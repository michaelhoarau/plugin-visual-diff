"""Verify archive exceptions inspect real Git patch content, not just messages."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-lib'))
from visualflowdiff.revision import archive_only_diff
from revision_fixture import settings_diff


class ArchiveDiffTest(unittest.TestCase):
    def setUp(self):
        self.before = {'versionTag': {'versionNumber': 1, 'lastModifiedBy': {'login': 'alice'}, 'lastModifiedOn': 1},
                       'projectStatus': 'Draft', 'settings': {'keep': True}}
        self.after = deepcopy(self.before)
        self.after['projectStatus'] = 'Archived'
        self.after['versionTag'].update(versionNumber=2, lastModifiedOn=2)

    def test_only_archive_and_version_metadata_are_accepted(self):
        self.assertTrue(archive_only_diff(settings_diff(self.before, self.after)))

    def test_status_can_be_added_when_absent(self):
        del self.before['projectStatus']
        self.assertTrue(archive_only_diff(settings_diff(self.before, self.after)))

    def test_separate_hunks_for_version_and_status(self):
        before = {'versionTag': self.before['versionTag'], 'settings': {str(i): i for i in range(30)}, 'projectStatus': 'Draft'}
        after = deepcopy(before)
        after['versionTag'] = self.after['versionTag']
        after['projectStatus'] = 'Archived'
        self.assertTrue(archive_only_diff(settings_diff(before, after)))

    def test_unrelated_project_setting_or_nested_status_change_is_rejected(self):
        self.after['settings']['keep'] = False
        self.assertFalse(archive_only_diff(settings_diff(self.before, self.after)))
        self.after['settings'] = {'keep': True, 'projectStatus': 'Archived'}
        self.assertFalse(archive_only_diff(settings_diff(self.before, self.after)))

    def test_dataset_or_recipe_changes_are_rejected(self):
        diff = settings_diff(self.before, self.after, path='datasets/customers.json')
        self.assertFalse(archive_only_diff(diff))
        diff = settings_diff(self.before, self.after)
        diff['entries'].append(diff['entries'][0])
        diff['changedFiles'] = 2
        self.assertFalse(archive_only_diff(diff))

    def test_version_metadata_alone_or_different_status_is_rejected(self):
        self.after['projectStatus'] = 'Draft'
        self.assertFalse(archive_only_diff(settings_diff(self.before, self.after)))
        self.after['projectStatus'] = 'Deployed'
        self.assertFalse(archive_only_diff(settings_diff(self.before, self.after)))

    def test_missing_truncated_or_renamed_diff_is_rejected(self):
        for mutate in (
                lambda diff: diff['entries'][0].update(changeType='RENAME'),
                lambda diff: diff['entries'][0]['fileChange'].update(patch=[]),
                lambda diff: diff['entries'][0]['fileChange']['patch'].pop(),
                lambda diff: diff.update(addedLines=999)):
            diff = settings_diff(self.before, self.after)
            mutate(diff)
            self.assertFalse(archive_only_diff(diff))


if __name__ == '__main__':
    unittest.main()
