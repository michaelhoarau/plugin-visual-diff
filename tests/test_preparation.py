"""Exercise preparation and recovery through the SQL dataset registry."""
from copy import deepcopy
from pathlib import Path
import sys
import time
import hashlib
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-lib'))
from visualflowdiff.preparation import (PreparationError, PreparationJobs,
    digest, identity, prepare_revision, resolve_selection)

from visualflowdiff.registry import Registry
from registry_fixture import Dataset, Executor
from revision_fixture import settings_diff

OLD = 'a' * 40
LATEST = 'b' * 40
INVARIANT = 'c' * 40


class Settings:
    def __init__(self, project):
        self.project = project
        self.raw = deepcopy(project.settings)

    def get_raw(self):
        return self.raw

    def save(self):
        if self.project.client.archive_failures and self.project.finalized:
            self.project.client.archive_failures -= 1
            raise RuntimeError('Archive unavailable')
        previous = deepcopy(self.project.settings)
        self.project.settings = deepcopy(self.raw)
        if self.project.client.archive_commits:
            self.project.record_archive(previous)


class Project:
    def __init__(self, client, key, origin=None, bootstrap=None):
        self.client, self.key, self.origin = client, key, origin
        self.branch = bootstrap or 'main'
        self.branches = [self.branch]
        self.settings = {'projectStatus': 'Draft', 'other': {'keep': True}}
        self.head = LATEST
        self.dirty = False
        self.finalized = False
        self.history = {}

    def record_archive(self, previous):
        parent = self.head
        commit = hashlib.sha1((self.key + parent + str(len(self.history))).encode()).hexdigest()
        before = dict(previous, versionTag={'versionNumber': len(self.history),
                      'lastModifiedBy': {'login': 'alice'}, 'lastModifiedOn': 1})
        after = dict(self.settings, versionTag={'versionNumber': len(self.history) + 1,
                     'lastModifiedBy': {'login': 'alice'}, 'lastModifiedOn': 2})
        self.history[commit] = {'parent': parent, 'message': 'Updated project settings for ' + self.key,
                                'diff': settings_diff(before, after)}
        self.head = commit

    def diff(self, commit_from=None, commit_to=None):
        entry = self.history[commit_to]
        assert entry['parent'] == commit_from
        return deepcopy(entry['diff'])

    def get_settings(self):
        return Settings(self)

    def get_project_git(self):
        return self

    def log(self, start_commit=None, count=1):
        if start_commit:
            if not (OLD.startswith(start_commit) or LATEST.startswith(start_commit)):
                raise RuntimeError('Unknown commit')
            return {'entries': [{'commit': OLD if OLD.startswith(start_commit) else LATEST}]}
        entries, current = [], self.head
        while len(entries) < count:
            entry = {'commit': current}
            if current in self.history:
                entry['message'] = self.history[current]['message']
                parent = self.history[current]['parent']
            elif current == INVARIANT:
                entry['message'] = 'Updated invariant properties of project %s after git switch operation.' % self.key
                parent = OLD
            else:
                parent = None
            entries.append(entry)
            if parent is None:
                break
            current = parent
        return {'entries': entries}

    def get_status(self):
        return {'currentBranch': self.branch, 'originProjectKey': self.origin,
                'clean': not self.dirty, 'hasUncommittedChanges': self.dirty}

    def get_current_branch(self):
        return self.branch

    def list_branches(self):
        return list(self.branches)

    def create_branch(self, branch_name, commit, duplicate_project=False, target_project_key=None, target_project_folder_id=None):
        self.client.calls.append((self.key, duplicate_project, branch_name, commit, target_project_key, target_project_folder_id))
        if duplicate_project:
            if target_project_key in self.client.projects:
                raise RuntimeError('Project %s already exists' % target_project_key)
            self.client.duplications += 1
            # DSS keeps existing GitInfo.originProjectKey when a branch is copied.
            self.client.projects[target_project_key] = Project(self.client, target_project_key, self.origin or self.key, branch_name)
            if self.client.timeout_duplication:
                self.client.timeout_duplication = False
                raise TimeoutError('Lost response after successful duplication')
            return {'success': True, 'targetProjectKey': target_project_key}
        self.branches.append(branch_name)
        self.branch = branch_name
        self.head = INVARIANT if self.client.invariants else commit
        self.settings['projectStatus'] = 'Draft'  # Checkout may restore source metadata.
        self.finalized = True
        if self.client.timeout_checkout:
            self.client.timeout_checkout = False
            raise TimeoutError('Lost response after successful checkout')
        return {'success': True}


class Client:
    host = 'https://dss.example'

    def __init__(self):
        self.projects = {}
        self.calls = []
        self.duplications = 0
        self.hidden = set()
        self.timeout_duplication = False
        self.timeout_checkout = False
        self.archive_failures = 0
        self.invariants = False
        self.archive_commits = True
        self.projects['SOURCE'] = Project(self, 'SOURCE')
        self.projects['OTHER'] = Project(self, 'OTHER')

    def get_project(self, key):
        if key not in self.projects:
            raise RuntimeError('NotFoundException: Project does not exist: ' + key)
        return self.projects[key]

    def list_project_keys(self):
        return [key for key in self.projects if key not in self.hidden]


class PreparationTest(unittest.TestCase):
    def setUp(self):
        self.dataset, self.executor = Dataset(), Executor()
        self.addCleanup(self.executor.db.close)
        self.registry = Registry(self.dataset, self.executor)
        self.client = Client()
        self.ref = {'projectKey': 'SOURCE', 'commitId': OLD}
        logs = patch('visualflowdiff.preparation.LOGGER.exception')
        logs.start()
        self.addCleanup(logs.stop)
        warnings = patch('visualflowdiff.preparation.LOGGER.warning')
        warnings.start()
        self.addCleanup(warnings.stop)

    def prepare(self, **kwargs):
        return prepare_revision(self.client, self.registry, self.ref, **kwargs)

    def test_selected_commit_is_materialized_despite_duplicate_api_ignoring_it(self):
        artifact = self.prepare()
        project = self.client.projects[artifact['projectKey']]
        self.assertEqual(project.log(count=2)['entries'][1]['commit'], OLD)
        self.assertEqual(project.settings, {'projectStatus': 'Archived', 'other': {'keep': True}})
        self.assertEqual(self.client.projects['SOURCE'].head, LATEST)
        self.assertEqual(self.client.projects['SOURCE'].branch, 'main')
        self.assertEqual(self.client.calls[0][1], True)
        self.assertIsNone(self.client.calls[0][-1])
        self.assertEqual(self.client.calls[1][0], artifact['projectKey'])
        self.assertFalse(self.client.calls[1][1])
        self.assertEqual(artifact['verifiedHead'], project.head)
        self.assertFalse(artifact['reused'])

    def test_repeated_requests_and_roles_reuse_one_project_across_registry_reopen(self):
        first = self.prepare()
        self.registry = Registry(self.dataset, self.executor)
        second = self.prepare()
        self.assertEqual(first['projectKey'], second['projectKey'])
        self.assertTrue(second['reused'])
        self.assertEqual(self.client.duplications, 1)

    def test_retry_recovers_archive_commit_retained_by_old_head_check(self):
        artifact = self.prepare()
        project = self.client.projects[artifact['projectKey']]
        record_key = digest(identity(self.client, self.ref))
        record = self.registry.read(record_key)
        archive_head = project.head
        record['verifiedHead'] = project.history[archive_head]['parent']
        record['state'] = 'revision-ready'
        self.registry.write(record_key, record)
        restored = self.prepare()
        self.assertEqual(restored['verifiedHead'], archive_head)
        self.assertEqual(self.registry.read(record_key)['verifiedHead'], archive_head)
        self.assertEqual(self.client.duplications, 1)

    def test_archive_without_new_commit_remains_supported(self):
        self.client.archive_commits = False
        artifact = self.prepare()
        self.assertEqual(artifact['verifiedHead'], OLD)
        self.assertTrue(self.prepare()['reused'])

    def test_archive_commit_with_unrelated_project_changes_is_rejected(self):
        original = Project.record_archive
        def tampered(project, previous):
            original(project, previous)
            if project.finalized:
                after = deepcopy(project.settings)
                after['other']['keep'] = False
                project.history[project.head]['diff'] = settings_diff(previous, after)
        with patch.object(Project, 'record_archive', tampered):
            with self.assertRaisesRegex(PreparationError, 'beyond an archive-only'):
                self.prepare()
        self.assertEqual(self.client.projects['SOURCE'].head, LATEST)

    def test_archive_commit_with_flow_file_change_is_rejected(self):
        original = Project.record_archive
        def tampered(project, previous):
            original(project, previous)
            if project.finalized:
                project.history[project.head]['diff']['entries'][0]['newPath'] = 'recipes/prepare.json'
        with patch.object(Project, 'record_archive', tampered):
            with self.assertRaisesRegex(PreparationError, 'beyond an archive-only'):
                self.prepare()

    def test_successful_archive_commit_is_rechecked_on_reuse(self):
        artifact = self.prepare()
        project = self.client.projects[artifact['projectKey']]
        project.record_archive(project.settings)
        # Even the expected settings-update message cannot disguise a commit
        # that does not actually change the status to Archived.
        with self.assertRaisesRegex(PreparationError, 'beyond an archive-only'):
            self.prepare()
        self.assertEqual(self.client.duplications, 1)

    def test_known_and_hidden_name_collisions_never_modify_unrelated_projects(self):
        base = 'VFD_SOURCE_' + OLD[:8].upper()
        for key in [base, base + '_1']:
            self.client.projects[key] = Project(self.client, key)
        self.client.hidden.add(base + '_1')
        artifact = self.prepare()
        self.assertEqual(artifact['projectKey'], base + '_2')
        self.assertEqual(self.client.projects[base].settings['projectStatus'], 'Draft')
        self.assertEqual(self.client.projects[base + '_1'].settings['projectStatus'], 'Draft')

    def test_commits_with_identical_short_shas_get_separate_projects(self):
        first = self.prepare()
        second_ref = {'projectKey': 'SOURCE', 'commitId': OLD[:8] + 'b' * 32}
        second = prepare_revision(self.client, self.registry, second_ref)
        self.assertEqual(first['projectKey'], 'VFD_SOURCE_AAAAAAAA')
        self.assertEqual(second['projectKey'], 'VFD_SOURCE_AAAAAAAA_1')
        self.assertEqual(second['commitId'], second_ref['commitId'])
        self.assertTrue(self.prepare()['reused'])
        self.assertTrue(prepare_revision(self.client, self.registry, second_ref)['reused'])
        self.assertEqual(self.client.duplications, 2)

    def test_timeout_after_duplication_resumes_the_reserved_project(self):
        self.client.timeout_duplication = True
        with self.assertRaises(TimeoutError):
            self.prepare()
        partial = [project for key, project in self.client.projects.items() if key.startswith('VFD_')]
        self.assertEqual(len(partial), 1)
        self.assertEqual(partial[0].settings['projectStatus'], 'Archived')
        artifact = self.prepare()
        self.assertTrue(artifact['archived'])
        self.assertEqual(self.client.duplications, 1)

    def test_registry_read_or_initial_write_failure_creates_no_project(self):
        original = self.executor.query_to_df
        for fail_read in (True, False):
            def fail(query, **options):
                if fail_read or query.startswith('MERGE INTO '):
                    raise RuntimeError('Registry database unavailable')
                return original(query, **options)
            with patch.object(self.executor, 'query_to_df', side_effect=fail):
                with self.assertRaises(PreparationError):
                    self.prepare()
            self.assertEqual(self.client.calls, [])

    def test_lost_registry_commit_response_after_duplication_resumes_existing_copy(self):
        original = self.executor.query_to_df
        failed = False
        def lost_response(query, **options):
            nonlocal failed
            result = original(query, **options)
            if query.startswith('MERGE INTO ') and self.client.duplications and not failed:
                failed = True
                raise TimeoutError('Commit completed but its response was lost')
            return result
        with patch.object(self.executor, 'query_to_df', side_effect=lost_response):
            with self.assertRaises(PreparationError):
                self.prepare()
        self.registry = Registry(self.dataset, self.executor)
        artifact = self.prepare()
        self.assertTrue(artifact['archived'])
        self.assertEqual(self.client.duplications, 1)

    def test_timeout_after_checkout_does_not_recreate_the_branch(self):
        self.client.timeout_checkout = True
        with self.assertRaises(TimeoutError):
            self.prepare()
        self.prepare()
        self.assertEqual(self.client.duplications, 1)
        self.assertEqual(len([call for call in self.client.calls if not call[1]]), 1)

    def test_archive_failure_retries_archiving_without_duplicate_creation(self):
        self.client.archive_failures = 2
        with self.assertRaises(RuntimeError):
            self.prepare()
        artifact = self.prepare()
        self.assertTrue(artifact['archived'])
        self.assertEqual(self.client.duplications, 1)

    def test_unexpected_edits_are_not_reset_archived_or_replaced(self):
        artifact = self.prepare()
        project = self.client.projects[artifact['projectKey']]
        project.head = 'd' * 40
        project.settings['projectStatus'] = 'Draft'
        with self.assertRaises(PreparationError):
            self.prepare()
        self.assertEqual(project.head, 'd' * 40)
        self.assertEqual(project.settings['projectStatus'], 'Draft')
        self.assertEqual(self.client.duplications, 1)

    def test_dss_invariant_commit_is_verified_and_recorded(self):
        self.client.invariants = True
        artifact = self.prepare()
        self.assertEqual(artifact['commitId'], OLD)
        self.assertEqual(self.client.projects[artifact['projectKey']].log(count=2)['entries'][1]['commit'], INVARIANT)
        self.assertTrue(self.prepare()['reused'])

    def test_provenance_mismatch_never_archives_or_duplicates_existing_artifact(self):
        artifact = self.prepare()
        project = self.client.projects[artifact['projectKey']]
        project.origin = 'UNRELATED'
        project.settings['projectStatus'] = 'Draft'
        with self.assertRaises(PreparationError):
            self.prepare()
        self.assertEqual(project.settings['projectStatus'], 'Draft')
        self.assertEqual(self.client.duplications, 1)

    def test_branch_source_uses_inherited_origin_and_reuses_its_copy(self):
        self.client.projects['OTHER'].origin = 'SOURCE'
        ref = {'projectKey': 'OTHER', 'commitId': OLD}
        artifact = prepare_revision(self.client, self.registry, ref)
        project = self.client.projects[artifact['projectKey']]
        self.assertEqual(project.origin, 'SOURCE')
        self.assertEqual(artifact['sourceProjectKey'], 'OTHER')
        stored = self.registry.read(digest(identity(self.client, ref)))
        self.assertEqual(stored['sourceOriginProjectKey'], 'SOURCE')
        self.assertEqual(stored['identity']['sourceProjectKey'], 'OTHER')
        self.assertTrue(prepare_revision(self.client, self.registry, ref)['reused'])
        self.assertEqual(self.client.duplications, 1)

    def test_legacy_failed_branch_duplicate_resumes_without_another_copy(self):
        self.client.projects['OTHER'].origin = 'SOURCE'
        ref = {'projectKey': 'OTHER', 'commitId': OLD}
        key = digest(identity(self.client, ref))
        record = {'identity': identity(self.client, ref), 'baseKey': 'VFD_LEGACY', 'suffix': 0,
                  'projectKey': 'VFD_LEGACY', 'bootstrapBranch': 'vfd_init_legacy',
                  'branchName': 'vfd_legacy', 'state': 'duplicating', 'createdAt': 1}
        self.registry.write(key, record)
        self.client.projects['OTHER'].create_branch(branch_name=record['bootstrapBranch'], commit=OLD,
                                                   duplicate_project=True, target_project_key=record['projectKey'])
        artifact = prepare_revision(self.client, self.registry, ref)
        self.assertEqual(artifact['projectKey'], 'VFD_LEGACY')
        self.assertTrue(artifact['archived'])
        self.assertEqual(self.registry.read(key)['sourceOriginProjectKey'], 'SOURCE')
        self.assertEqual(self.client.duplications, 1)

    def test_shared_lineage_does_not_replace_the_unique_ownership_marker(self):
        self.client.projects['OTHER'].origin = 'SOURCE'
        ref = {'projectKey': 'OTHER', 'commitId': OLD}
        artifact = prepare_revision(self.client, self.registry, ref)
        project = self.client.projects[artifact['projectKey']]
        record = self.registry.read(digest(identity(self.client, ref)))
        project.branches.remove(record['bootstrapBranch'])
        project.settings['projectStatus'] = 'Draft'
        with self.assertRaisesRegex(PreparationError, 'provenance'):
            prepare_revision(self.client, self.registry, ref)
        self.assertEqual(project.settings['projectStatus'], 'Draft')
        self.assertEqual(self.client.duplications, 1)

    def test_root_and_branch_same_commit_have_separate_registry_identities(self):
        baseline = self.prepare()
        self.client.projects['OTHER'].origin = 'SOURCE'
        target = prepare_revision(self.client, self.registry, {'projectKey': 'OTHER', 'commitId': OLD})
        self.assertNotEqual(baseline['projectKey'], target['projectKey'])
        self.assertEqual(self.client.duplications, 2)

    def test_both_commits_are_validated_before_writes(self):
        refs = resolve_selection(self.client, {'baseline': {'projectKey': 'SOURCE', 'commitId': OLD[:8]}, 'target': {'projectKey': 'OTHER', 'commitId': LATEST}})
        self.assertEqual(refs['baseline']['commitId'], OLD)
        with self.assertRaises(PreparationError):
            resolve_selection(self.client, {'baseline': self.ref, 'target': {'projectKey': '../SOURCE', 'commitId': OLD}})
        self.assertEqual(self.client.calls, [])

    def test_distinct_commits_in_one_source_get_distinct_projects(self):
        first = self.prepare()
        other = prepare_revision(self.client, self.registry, {'projectKey': 'SOURCE', 'commitId': LATEST})
        self.assertNotEqual(first['projectKey'], other['projectKey'])
        self.assertNotEqual(first['branchName'], other['branchName'])
        self.assertEqual(self.client.duplications, 2)
        self.assertEqual(self.client.projects['SOURCE'].branch, 'main')

    def test_unrelated_revision_after_checkout_is_rejected(self):
        original = Project.create_branch
        def wrong_revision(project, **kwargs):
            result = original(project, **kwargs)
            if not kwargs.get('duplicate_project'):
                project.head = 'd' * 40
            return result
        with patch.object(Project, 'create_branch', wrong_revision):
            with self.assertRaisesRegex(PreparationError, 'does not match'):
                self.prepare()
        generated = [project for key, project in self.client.projects.items() if key.startswith('VFD_')]
        self.assertEqual(len(generated), 1)
        self.assertEqual(generated[0].settings['projectStatus'], 'Archived')
        self.assertEqual(self.client.projects['SOURCE'].head, LATEST)

    def test_dirty_registered_project_is_not_reset_or_replaced(self):
        artifact = self.prepare()
        project = self.client.projects[artifact['projectKey']]
        project.dirty = True
        with self.assertRaisesRegex(PreparationError, 'uncommitted changes'):
            self.prepare()
        self.assertTrue(project.dirty)
        self.assertEqual(self.client.duplications, 1)

    def test_single_writer_guard_deduplicates_retries_and_rejects_other_preparations(self):
        manager = PreparationJobs()
        refs = {'baseline': self.ref, 'target': {'projectKey': 'OTHER', 'commitId': OLD}}
        with patch('visualflowdiff.preparation.threading.Thread') as thread:
            job = manager.start(self.client, 'alice', self.registry, refs)
            self.assertEqual(manager.start(self.client, 'alice', self.registry, refs), job)
            changed = deepcopy(refs)
            changed['target']['commitId'] = LATEST
            with self.assertRaisesRegex(PreparationError, 'still preparing'):
                manager.start(self.client, 'alice', self.registry, changed)
            self.assertEqual(thread.call_count, 1)

    def test_job_keeps_successful_side_and_retry_reuses_it(self):
        manager = PreparationJobs()
        refs = {'baseline': self.ref, 'target': {'projectKey': 'OTHER', 'commitId': OLD}}
        # Deny the second source only after upfront validation, simulating a later permission change.
        other = self.client.projects['OTHER']
        original = other.create_branch
        other.create_branch = lambda **kwargs: (_ for _ in ()).throw(RuntimeError('denied'))
        job_id = manager.start(self.client, 'alice', self.registry, refs)
        for _ in range(200):
            state = manager.get(job_id, 'alice')
            if state['state'] != 'preparing':
                break
            time.sleep(.005)
        self.assertEqual(state['state'], 'failed')
        self.assertIn('baseline', state['artifacts'])
        with self.assertRaises(PreparationError):
            manager.get(job_id, 'bob')
        other.create_branch = original
        retry = manager.start(self.client, 'alice', self.registry, refs)
        for _ in range(200):
            state = manager.get(retry, 'alice')
            if state['state'] != 'preparing':
                break
            time.sleep(.005)
        self.assertEqual(state['state'], 'ready')
        self.assertTrue(state['artifacts']['baseline']['reused'])
        self.assertEqual(self.client.duplications, 2)


if __name__ == '__main__':
    unittest.main()
