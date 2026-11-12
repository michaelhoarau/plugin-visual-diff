"""Exercise permanent project cleanup and durable registry reconciliation."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-lib'))
from visualflowdiff.cleanup import cleanup_registry
from visualflowdiff.preparation import prepare_revision, digest, identity, PreparationJobs, PreparationError
from visualflowdiff.registry import Registry
from registry_fixture import Dataset, Executor
from test_preparation import Client, OLD


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.executor = Executor()
        self.addCleanup(self.executor.db.close)
        self.registry = Registry(Dataset(), self.executor)
        self.ref = {'projectKey': 'SOURCE', 'commitId': OLD}
        self.key = digest(identity(self.client, self.ref))
        self.artifact = prepare_revision(self.client, self.registry, self.ref)
        self.project = self.client.projects[self.artifact['projectKey']]
        self.project.delete = Mock(side_effect=lambda **kwargs: self.client.projects.pop(self.project.key))
        logs = patch('visualflowdiff.cleanup.LOGGER.exception')
        logs.start()
        self.addCleanup(logs.stop)
        warnings = patch('visualflowdiff.preparation.LOGGER.warning')
        warnings.start()
        self.addCleanup(warnings.stop)

    def clean(self):
        return cleanup_registry(self.client, self.registry, 'HOST')

    def test_deletes_only_registered_copy_and_commits_record_removal(self):
        result = self.clean()
        self.assertEqual(result['deletedProjects'], [self.project.key])
        self.assertEqual(result['removedRecords'], 1)
        self.assertEqual(result['failures'], [])
        self.assertIsNone(self.registry.read(self.key))
        self.assertIn('SOURCE', self.client.projects)
        self.project.delete.assert_called_once_with(clear_managed_datasets=True, clear_output_managed_folders=True,
                                                   clear_job_and_scenario_logs=True, wait=True)
        self.assertEqual(self.clean()['removedRecords'], 0)

    def test_missing_project_removes_stale_record_without_delete(self):
        del self.client.projects[self.project.key]
        result = self.clean()
        self.assertEqual(result['alreadyMissingProjects'], [self.project.key])
        self.assertEqual(result['removedRecords'], 1)
        self.project.delete.assert_not_called()

    def masked_missing_projects(self):
        """Match DSS settings' permission-loader behavior after a project vanishes."""
        original = self.client.get_project
        def get_project(key):
            if key not in self.client.projects:
                project = Mock()
                project.get_settings.side_effect = RuntimeError(
                    'com.dataiku.dip.exceptions.UnauthorizedException: Failed to read project permissions')
                return project
            return original(key)
        return patch.object(self.client, 'get_project', side_effect=get_project)

    def test_successful_delete_with_dss_masked_missing_response_removes_record(self):
        with self.masked_missing_projects():
            result = self.clean()
        self.assertEqual(result['deletedProjects'], [self.project.key])
        self.assertEqual(result['removedRecords'], 1)
        self.assertEqual(result['failures'], [])
        self.assertIsNone(self.registry.read(self.key))

    def test_retry_reconciles_projects_already_deleted_by_previous_cleanup(self):
        del self.client.projects[self.project.key]
        with self.masked_missing_projects():
            result = self.clean()
        self.assertEqual(result['alreadyMissingProjects'], [self.project.key])
        self.assertEqual(result['removedRecords'], 1)
        self.assertEqual(result['failures'], [])
        self.project.delete.assert_not_called()

    def test_masked_error_for_visible_project_does_not_remove_record(self):
        with patch.object(self.project, 'get_settings', side_effect=RuntimeError(
                'UnauthorizedException: Failed to read project permissions')):
            result = self.clean()
        self.assertEqual(len(result['failures']), 1)
        self.assertEqual(result['failures'][0]['stage'], 'checking project access')
        self.project.delete.assert_not_called()
        self.assertIsNotNone(self.registry.read(self.key))

    def test_actual_permission_denial_for_hidden_project_is_not_absence(self):
        self.client.hidden.add(self.project.key)
        with patch.object(self.project, 'get_settings', side_effect=RuntimeError('UnauthorizedException: Action forbidden')):
            result = self.clean()
        self.assertEqual(len(result['failures']), 1)
        self.assertEqual(result['removedRecords'], 0)
        self.project.delete.assert_not_called()

    def test_project_list_failure_after_delete_retains_record_for_retry(self):
        with self.masked_missing_projects(), patch.object(self.client, 'list_project_keys', side_effect=RuntimeError('Connection failed')):
            result = self.clean()
        self.assertEqual(result['removedRecords'], 0)
        self.assertEqual(result['failures'][0]['stage'], 'verifying project deletion')
        self.assertIsNotNone(self.registry.read(self.key))
        with self.masked_missing_projects():
            self.assertEqual(self.clean()['removedRecords'], 1)

    def test_cleanup_recovers_legacy_branch_lineage_without_deleting_sources(self):
        self.clean()
        self.client.projects['OTHER'].origin = 'SOURCE'
        ref = {'projectKey': 'OTHER', 'commitId': OLD}
        artifact = prepare_revision(self.client, self.registry, ref)
        project = self.client.projects[artifact['projectKey']]
        self.assertEqual(project.origin, 'SOURCE')
        record_key = digest(identity(self.client, ref))
        legacy = self.registry.read(record_key)
        del legacy['sourceOriginProjectKey']
        self.registry.write(record_key, legacy)
        project.delete = Mock(side_effect=lambda **kwargs: self.client.projects.pop(project.key))
        result = self.clean()
        self.assertEqual(result['deletedProjects'], [project.key])
        self.assertEqual(result['failures'], [])
        self.assertIn('SOURCE', self.client.projects)
        self.assertIn('OTHER', self.client.projects)
        self.assertIsNone(self.registry.read(record_key))

    def test_foreign_or_changed_provenance_keeps_project_and_record(self):
        self.project.origin = 'UNRELATED'
        result = self.clean()
        self.assertEqual(len(result['failures']), 1)
        self.assertEqual(result['removedRecords'], 0)
        self.project.delete.assert_not_called()
        self.assertIsNotNone(self.registry.read(self.key))

    def test_delete_permission_is_checked_before_projects_are_deleted(self):
        with patch.object(self.registry, 'check_cleanup_access', side_effect=PreparationError('DELETE permission required')):
            with self.assertRaises(PreparationError):
                self.clean()
        self.project.delete.assert_not_called()
        self.assertIsNotNone(self.registry.read(self.key))

    def test_duplicate_record_keys_abort_before_any_deletion(self):
        self.executor.db.execute('INSERT INTO VISUAL_FLOW_DIFF_REGISTRY SELECT * FROM VISUAL_FLOW_DIFF_REGISTRY')
        with self.assertRaisesRegex(PreparationError, 'duplicate record keys'):
            self.clean()
        self.project.delete.assert_not_called()

    def test_generic_not_found_access_error_is_not_treated_as_absent(self):
        original = self.client.get_project
        def denied(key):
            if key == self.project.key:
                raise RuntimeError('NotFoundException: access denied')
            return original(key)
        with patch.object(self.client, 'get_project', side_effect=denied):
            self.assertEqual(len(self.clean()['failures']), 1)
        self.assertIsNotNone(self.registry.read(self.key))
        self.project.delete.assert_not_called()

    def test_hosting_project_is_never_deleted(self):
        result = cleanup_registry(self.client, self.registry, self.project.key)
        self.assertEqual(len(result['failures']), 1)
        self.project.delete.assert_not_called()

    def test_source_project_is_never_deleted_even_with_tampered_record(self):
        record = self.registry.read(self.key)
        record['projectKey'] = 'SOURCE'
        self.registry.write(self.key, record)
        result = self.clean()
        self.assertEqual(len(result['failures']), 1)
        self.assertIn('SOURCE', self.client.projects)

    def test_deletion_permission_failure_retains_record_but_other_entries_are_cleaned(self):
        self.project.delete.side_effect = RuntimeError('private permission details')
        other = prepare_revision(self.client, self.registry, {'projectKey': 'OTHER', 'commitId': OLD})
        project = self.client.projects[other['projectKey']]
        project.delete = Mock(side_effect=lambda **kwargs: self.client.projects.pop(project.key))
        result = self.clean()
        self.assertEqual(result['deletedProjects'], [project.key])
        self.assertEqual(len(result['failures']), 1)
        self.assertNotIn('private', result['failures'][0]['message'])
        self.assertIsNotNone(self.registry.read(self.key))

    def test_failed_registry_delete_can_be_retried_after_project_is_gone(self):
        with patch.object(self.registry, 'remove', side_effect=RuntimeError('database unavailable')):
            result = self.clean()
        self.assertEqual(result['deletedProjects'], [self.project.key])
        self.assertEqual(result['removedRecords'], 0)
        self.assertIsNotNone(self.registry.read(self.key))
        self.assertEqual(self.clean()['removedRecords'], 1)
        self.assertEqual(self.project.delete.call_count, 1)

    def test_uncertain_delete_is_verified_on_retry_without_losing_record(self):
        def lost_response(**kwargs):
            self.client.projects.pop(self.project.key)
            raise TimeoutError('Deletion response lost')
        self.project.delete.side_effect = lost_response
        self.assertEqual(len(self.clean()['failures']), 1)
        self.assertIsNotNone(self.registry.read(self.key))
        self.assertEqual(self.clean()['alreadyMissingProjects'], [self.project.key])

    def test_reserved_uncreated_entry_is_removed_and_corrupt_entry_is_retained(self):
        self.clean()
        record = {'identity': identity(self.client, self.ref), 'baseKey': 'VFD', 'suffix': 0,
                  'branchName': 'vfd', 'bootstrapBranch': 'nonce', 'state': 'reserved', 'createdAt': 1}
        self.registry.write(self.key, record)
        self.assertEqual(self.clean()['removedRecords'], 1)
        self.executor.db.execute("INSERT INTO VISUAL_FLOW_DIFF_REGISTRY (RECORD_KEY, INSTANCE_URL, SOURCE_PROJECT_KEY, COMMIT_SHA, BRANCH_NAME, PREPARATION_STATUS, CREATED_AT, UPDATED_AT, RECORD_JSON) VALUES ('bad', 'x', 'x', 'x', 'x', 'x', 1, 1, 'broken')")
        result = self.clean()
        self.assertEqual(result['removedRecords'], 0)
        self.assertEqual(len(result['failures']), 1)

    def test_cleanup_and_preparation_cannot_overlap(self):
        refs = {'baseline': self.ref, 'target': self.ref}
        manager = PreparationJobs()
        with patch('visualflowdiff.preparation.threading.Thread'):
            job = manager.start_cleanup(self.client, 'alice', self.registry, 'HOST')
            with self.assertRaises(PreparationError):
                manager.start(self.client, 'alice', self.registry, refs)
            with self.assertRaises(PreparationError):
                manager.start_cleanup(self.client, 'alice', self.registry, 'HOST')
        manager._run_cleanup(job, self.client, self.registry, 'HOST')
        result = manager.get(job, 'alice')
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(result['result']['removedRecords'], 1)
        manager.jobs['preparing'] = {'state': 'preparing'}
        with self.assertRaises(PreparationError):
            manager.start_cleanup(self.client, 'alice', self.registry, 'HOST')


if __name__ == '__main__':
    unittest.main()
