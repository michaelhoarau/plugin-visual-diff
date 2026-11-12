"""Exercise DSS routes without installing DSS or running a webapp backend."""
import logging
from pathlib import Path
import runpy
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-lib'))


class BackendTest(unittest.TestCase):
    def setUp(self):
        self.backend_client = Mock(host='http://dss')
        self.backend_client.get_ticket_from_browser_headers.return_value = 'viewer-ticket'
        self.viewer = Mock()
        self.viewer.get_project.return_value.get_flow.return_value.list_zones.return_value = []
        self.request = SimpleNamespace(args={}, headers={'Cookie': 'browser-session'})
        dataiku = ModuleType('dataiku')
        self.dataset_constructor = dataiku.Dataset = Mock()
        self.sql_constructor = dataiku.SQLExecutor2 = Mock()
        dataiku.api_client = Mock(return_value=self.backend_client)
        dataiku.default_project_key = Mock(return_value='PARENT')
        customwebapp = ModuleType('dataiku.customwebapp')
        self.webapp_config = customwebapp.get_webapp_config = Mock(return_value={})
        dataikuapi = ModuleType('dataikuapi')
        self.client_constructor = dataikuapi.DSSClient = Mock(return_value=self.viewer)
        flask = ModuleType('flask')
        flask.request = self.request
        flask.jsonify = lambda **kwargs: kwargs
        app = Mock()
        app.route.side_effect = lambda *args, **kwargs: lambda function: function
        with patch.dict(sys.modules, {'dataiku': dataiku, 'dataikuapi': dataikuapi, 'flask': flask, 'dataiku.customwebapp': customwebapp}):
            self.routes = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'webapps/webapp/backend.py'), init_globals={'app': app})

    def test_projects_are_sorted_and_use_viewer_credentials(self):
        self.viewer.list_projects.return_value = [
            {'projectKey': 'Z', 'name': 'Zulu', 'projectStatus': 'Draft'},
            {'projectKey': 'A', 'name': 'Alpha'},
            {'projectKey': 'OLD', 'name': 'Archived comparison', 'projectStatus': 'Archived'}]
        response = self.routes['projects']()
        self.assertEqual([p['key'] for p in response['projects']], ['A', 'Z'])
        self.assertEqual(response['currentProjectKey'], 'PARENT')
        self.backend_client.get_ticket_from_browser_headers.assert_called_once_with({'Cookie': 'browser-session'})
        self.client_constructor.assert_called_once_with('http://dss', internal_ticket='viewer-ticket')
        self.backend_client.list_projects.assert_not_called()

    def test_missing_project_is_rejected_without_api_call(self):
        response, status = self.routes['commits']()
        self.assertEqual(status, 400)
        self.client_constructor.assert_not_called()

    def test_commit_schema_and_pagination(self):
        self.request.args = {'projectKey': 'BRANCH', 'startCommit': 'older-sha'}
        git = self.viewer.get_project.return_value.get_project_git.return_value
        git.log.return_value = {'entries': [{'commit': 'full-sha', 'message': 'Edit Flow', 'author': 'alice', 'timestamp': '2026-11-03T12:00:00Z',
            'tags': [{'shortName': 'v1', 'name': 'refs/tags/v1'}, {'name': 'release'}, {}]}], 'nextCommit': 'next-sha'}
        response = self.routes['commits']()
        self.viewer.get_project.assert_called_once_with('BRANCH')
        git.log.assert_called_once_with(start_commit='older-sha', count=50)
        self.assertEqual(response['commits'][0]['id'], 'full-sha')
        self.assertEqual(response['commits'][0]['tags'], ['v1', 'release'])
        self.assertEqual(response['nextCommit'], 'next-sha')
        self.dataset_constructor.assert_not_called()
        self.sql_constructor.assert_not_called()

    def test_commit_history_never_initializes_the_registry(self):
        self.request.args = {'projectKey': 'SOURCE'}
        self.viewer.get_project.return_value.get_project_git.return_value.log.return_value = {
            'entries': [{'commit': 'full-sha'}], 'nextCommit': 'older'}
        with patch.dict(self.routes['commits'].__globals__, Registry=Mock(side_effect=AssertionError('Registry accessed'))):
            response = self.routes['commits']()
        self.assertEqual(response['commits'][0]['id'], 'full-sha')
        self.assertEqual(response['nextCommit'], 'older')
        self.dataset_constructor.assert_not_called()

    def test_membership_reuses_metadata_but_reads_fresh_results(self):
        sha = 'a' * 40
        self.request.args = {'projectKey': 'SOURCE', 'commitIds': sha}
        self.webapp_config.return_value = {'registry_dataset': 'registry'}
        self.viewer.host = 'http://dss'
        constructor = Mock()
        constructor.return_value.registered_commits.side_effect = [{sha}, set()]
        with patch.dict(self.routes['registry_membership'].__globals__, Registry=constructor):
            self.assertEqual(self.routes['registry_membership'](), {'registeredCommitIds': [sha]})
            self.assertEqual(self.routes['registry_membership'](), {'registeredCommitIds': []})
        constructor.assert_called_once_with(self.dataset_constructor.return_value, self.sql_constructor.return_value, initialize=False)
        self.assertEqual(self.viewer.get_project.return_value.get_settings.call_count, 2)
        self.assertEqual(constructor.return_value.registered_commits.call_count, 2)

    def test_membership_rejects_invalid_ids_before_accessing_registry(self):
        self.request.args = {'projectKey': 'SOURCE', 'commitIds': "bad-sha"}
        response, status = self.routes['registry_membership']()
        self.assertEqual(status, 400)
        self.client_constructor.assert_not_called()
        self.dataset_constructor.assert_not_called()

    def test_membership_checks_viewer_access_before_registry(self):
        self.request.args = {'projectKey': 'DENIED', 'commitIds': 'a' * 40}
        self.viewer.get_project.return_value.get_settings.side_effect = RuntimeError('private details')
        with patch.object(logging.Logger, 'warning'):
            response, status = self.routes['registry_membership']()
        self.assertEqual(status, 502)
        self.assertNotIn('private', response['error'])
        self.dataset_constructor.assert_not_called()

    def test_membership_lookup_failure_evicts_cached_reader(self):
        self.request.args = {'projectKey': 'SOURCE', 'commitIds': 'a' * 40}
        self.webapp_config.return_value = {'registry_dataset': 'registry'}
        constructor = Mock()
        constructor.return_value.registered_commits.side_effect = RuntimeError('private details')
        with patch.dict(self.routes['registry_membership'].__globals__, Registry=constructor), patch.object(logging.Logger, 'warning'):
            response, status = self.routes['registry_membership']()
        self.assertEqual(status, 502)
        self.assertNotIn('private', response['error'])
        self.assertEqual(self.routes['membership_registry_cache'], {})

    def test_empty_history(self):
        self.request.args = {'projectKey': 'EMPTY'}
        self.viewer.get_project.return_value.get_project_git.return_value.log.return_value = {'entries': []}
        self.assertEqual(self.routes['commits'](), {'commits': [], 'nextCommit': None})

    def test_authentication_failure_has_no_owner_fallback(self):
        self.backend_client.get_ticket_from_browser_headers.side_effect = RuntimeError('secret error details')
        with patch.object(logging.Logger, 'exception'):
            response, status = self.routes['projects']()
        self.assertEqual(status, 502)
        self.assertNotIn('secret', response['error'])
        self.client_constructor.assert_not_called()
        self.backend_client.list_projects.assert_not_called()

    def test_commit_access_error_is_recoverable(self):
        self.request.args = {'projectKey': 'DENIED'}
        self.viewer.get_project.side_effect = RuntimeError('private details')
        with patch.object(logging.Logger, 'exception'):
            response, status = self.routes['commits']()
        self.assertEqual(status, 502)
        self.assertIn('retry', response['error'])
        self.assertNotIn('private', response['error'])

    def test_branches_include_only_direct_children_of_baseline(self):
        self.request.args = {'projectKey': 'PARENT'}
        self.viewer.list_projects.return_value = [
            {'projectKey': key, 'name': name} for key, name in [
                ('PARENT', 'Parent'), ('B', 'Zulu'), ('A', 'Alpha'),
                ('OTHER', 'Unrelated'), ('GRANDCHILD', 'Nested branch')]]
        self.viewer.list_projects.return_value.append({'projectKey': 'OLD', 'projectStatus': 'Archived'})
        origins = {'A': 'PARENT', 'B': 'PARENT', 'OTHER': None, 'GRANDCHILD': 'A'}
        def project(key):
            handle = Mock()
            handle.get_project_git.return_value.get_status.return_value = {
                'originProjectKey': origins[key], 'currentBranch': 'feature-' + key}
            return handle
        self.viewer.get_project.side_effect = project
        response = self.routes['branches']()
        self.assertEqual(response, {'branches': [
            {'key': 'A', 'name': 'Alpha', 'branch': 'feature-A'},
            {'key': 'B', 'name': 'Zulu', 'branch': 'feature-B'}], 'incomplete': False})
        self.assertEqual(self.viewer.get_project.call_count, 4)
        self.client_constructor.assert_called_once_with('http://dss', internal_ticket='viewer-ticket')

    def test_branches_skip_unreadable_relationships_and_report_partial_results(self):
        self.request.args = {'projectKey': 'PARENT'}
        self.viewer.list_projects.return_value = [{'projectKey': key} for key in ['PARENT', 'CHILD', 'DENIED']]
        child = Mock()
        child.get_project_git.return_value.get_status.return_value = {'originProjectKey': 'PARENT'}
        self.viewer.get_project.side_effect = [child, RuntimeError('private details')]
        with patch.object(logging.Logger, 'warning'):
            response = self.routes['branches']()
        self.assertEqual(response, {'branches': [{'key': 'CHILD', 'name': 'CHILD', 'branch': None}], 'incomplete': True})

    def test_branches_require_baseline_key(self):
        response, status = self.routes['branches']()
        self.assertEqual(status, 400)
        self.client_constructor.assert_not_called()

    def test_branches_reject_unavailable_baseline(self):
        self.request.args = {'projectKey': 'HIDDEN'}
        self.viewer.list_projects.return_value = [{'projectKey': 'OTHER'},
                                                {'projectKey': 'HIDDEN', 'projectStatus': 'Archived'}]
        response, status = self.routes['branches']()
        self.assertEqual(status, 404)
        self.viewer.get_project.assert_not_called()

    def test_branches_handle_empty_results(self):
        self.request.args = {'projectKey': 'PARENT'}
        self.viewer.list_projects.return_value = [{'projectKey': 'PARENT'}]
        self.assertEqual(self.routes['branches'](), {'branches': [], 'incomplete': False})

    def test_branch_authentication_failure_has_no_owner_fallback(self):
        self.request.args = {'projectKey': 'PARENT'}
        self.backend_client.get_ticket_from_browser_headers.side_effect = RuntimeError('private details')
        with patch.object(logging.Logger, 'exception'):
            response, status = self.routes['branches']()
        self.assertEqual(status, 502)
        self.assertNotIn('private', response['error'])
        self.client_constructor.assert_not_called()

    def test_comparison_reads_both_projects_as_viewer_and_compares_settings(self):
        self.request.args = {'baselineProjectKey': 'BASE', 'targetProjectKey': 'TARGET'}
        def project(key):
            handle = Mock()
            handle.get_flow.return_value.get_graph.return_value.nodes = {
                'data': {'ref': 'data', 'type': 'COMPUTABLE_DATASET'}}
            handle.get_flow.return_value.list_zones.return_value = []
            handle.get_dataset.return_value.get_settings.return_value.get_raw.return_value = {
                'projectKey': key, 'name': 'data', 'params': {'value': 1 if key == 'BASE' else 2}}
            return handle
        self.viewer.get_project.side_effect = project
        response = self.routes['comparison']()
        self.assertEqual(response['counts']['modified'], 1)
        self.assertEqual([call.args[0] for call in self.viewer.get_project.call_args_list], ['BASE', 'TARGET'])
        self.client_constructor.assert_called_once_with('http://dss', internal_ticket='viewer-ticket')
        self.backend_client.get_project.assert_not_called()

    def test_comparison_requires_both_keys_and_fails_when_settings_are_unreadable(self):
        self.request.args = {'baselineProjectKey': 'BASE'}
        self.assertEqual(self.routes['comparison']()[1], 400)
        self.client_constructor.assert_not_called()
        self.request.args['targetProjectKey'] = 'TARGET'
        handle = self.viewer.get_project.return_value
        handle.get_flow.return_value.get_graph.return_value.nodes = {'data': {'ref': 'data', 'type': 'COMPUTABLE_DATASET'}}
        handle.get_dataset.return_value.get_settings.side_effect = RuntimeError('private details')
        with patch.object(logging.Logger, 'exception'):
            response, code = self.routes['comparison']()
        self.assertEqual(code, 502)
        self.assertNotIn('private', response['error'])

    def test_browser_identity_failures_return_actionable_status_without_fallback(self):
        for exception, status, message in [
                ('NotAuthenticatedException: Not authenticated', 401, 'browser session'),
                ('DKUSecurityException: denied', 403, 'Impersonation in webapps')]:
            self.backend_client.get_ticket_from_browser_headers.side_effect = RuntimeError(exception)
            with patch.object(logging.Logger, 'exception'):
                response, code = self.routes['projects']()
            self.assertEqual(code, status)
            self.assertIn(message, response['error'])
        self.client_constructor.assert_not_called()

    def test_preparation_rejects_non_json_writes(self):
        self.request.is_json = False
        response, status = self.routes['prepare_comparison']()
        self.assertEqual(status, 400)
        self.client_constructor.assert_not_called()

    def test_preparation_requires_registry_dataset_selection(self):
        self.request.is_json = True
        self.request.headers['X-Requested-With'] = 'XMLHttpRequest'
        with patch.object(logging.Logger, 'exception'):
            response, status = self.routes['prepare_comparison']()
        self.assertEqual(status, 503)
        self.assertIn('registry', response['error'])

    def test_registry_uses_hosting_project_and_backend_dataset_api(self):
        with patch.dict(self.routes['preparation_registry'].__globals__, Registry=Mock()) as globals:
            registry = self.routes['preparation_registry']({'registry_dataset': '  comparison_registry  '})
            self.dataset_constructor.assert_called_once_with('comparison_registry', project_key='PARENT')
            self.sql_constructor.assert_called_once_with(dataset=self.dataset_constructor.return_value)
            globals['Registry'].assert_called_once_with(self.dataset_constructor.return_value, self.sql_constructor.return_value, initialize=True)
            self.assertEqual(registry, globals['Registry'].return_value)
        self.client_constructor.assert_not_called()

    def test_registry_configuration_is_validated_for_preparation_and_membership(self):
        self.request.args = {'projectKey': 'SOURCE', 'commitIds': 'a' * 40}
        for name in (None, '', '   ', 123):
            with self.subTest(name=name):
                config = {'registry_dataset': name}
                self.webapp_config.return_value = config
                with self.assertRaisesRegex(self.routes['PreparationError'], 'registry dataset') as raised:
                    self.routes['preparation_registry'](config)
                self.assertEqual(raised.exception.status, 503)
                with patch.object(logging.Logger, 'warning'):
                    response, status = self.routes['registry_membership']()
                self.assertEqual(status, 503)
                self.assertIn('registry dataset', response['error'])
        self.dataset_constructor.assert_not_called()
        self.sql_constructor.assert_not_called()

    def test_membership_trims_registry_name_and_opens_it_without_initialization(self):
        self.request.args = {'projectKey': 'SOURCE', 'commitIds': 'a' * 40}
        self.webapp_config.return_value = {'registry_dataset': '  registry  '}
        constructor = Mock()
        constructor.return_value.registered_commits.return_value = set()
        with patch.dict(self.routes['registry_membership'].__globals__, Registry=constructor):
            self.assertEqual(self.routes['registry_membership'](), {'registeredCommitIds': []})
        self.dataset_constructor.assert_called_once_with('registry', project_key='PARENT')
        self.sql_constructor.assert_called_once_with(dataset=self.dataset_constructor.return_value)
        constructor.assert_called_once_with(self.dataset_constructor.return_value,
                                            self.sql_constructor.return_value, initialize=False)

    def test_registry_dataset_failures_preserve_route_specific_error_responses(self):
        self.dataset_constructor.side_effect = RuntimeError('private details')
        config = {'registry_dataset': 'registry'}
        with self.assertRaises(self.routes['PreparationError']) as raised:
            self.routes['preparation_registry'](config)
        self.assertEqual(raised.exception.status, 503)
        self.assertNotIn('private', str(raised.exception))
        self.request.args = {'projectKey': 'SOURCE', 'commitIds': 'a' * 40}
        self.webapp_config.return_value = config
        with patch.object(logging.Logger, 'warning'):
            response, status = self.routes['registry_membership']()
        self.assertEqual(status, 502)
        self.assertNotIn('private', response['error'])
        self.assertEqual(self.routes['membership_registry_cache'], {})

    def test_preparation_status_rejects_missing_or_foreign_jobs(self):
        self.viewer.get_auth_info.return_value = {'authIdentifier': 'alice'}
        response, status = self.routes['preparation_status']('unknown')
        self.assertEqual(status, 404)
        manager = self.routes['preparation_status'].__globals__['preparation_jobs']
        manager.jobs['foreign'] = {'owner': 'bob'}
        response, status = self.routes['preparation_status']('foreign')
        self.assertEqual(status, 403)

    def test_cleanup_requires_json_and_explicit_confirmation(self):
        self.request.is_json = False
        self.assertEqual(self.routes['cleanup_projects']()[1], 400)
        self.request.is_json = True
        self.request.headers['X-Requested-With'] = 'XMLHttpRequest'
        self.request.get_json = Mock(return_value={})
        self.assertEqual(self.routes['cleanup_projects']()[1], 400)
        self.client_constructor.assert_not_called()

    def test_cleanup_starts_as_viewer_with_host_project_protected(self):
        self.request.is_json = True
        self.request.headers['X-Requested-With'] = 'XMLHttpRequest'
        self.request.get_json = Mock(return_value={'confirmed': True})
        self.viewer.get_auth_info.return_value = {'authIdentifier': 'alice'}
        route_globals = self.routes['cleanup_projects'].__globals__
        registry = Mock()
        manager = Mock()
        manager.start_cleanup.return_value = 'cleanup123'
        with patch.dict(route_globals, preparation_registry=Mock(return_value=registry), preparation_jobs=manager):
            response, status = self.routes['cleanup_projects']()
        self.assertEqual(status, 202)
        self.assertEqual(response['jobId'], 'cleanup123')
        manager.start_cleanup.assert_called_once_with(self.viewer, 'alice', registry, 'PARENT')
        self.backend_client.get_project.assert_not_called()


if __name__ == '__main__':
    unittest.main()
