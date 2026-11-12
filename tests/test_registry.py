"""Validate dataset selection, SQL persistence, escaping, and failure handling."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-lib'))
from visualflowdiff.preparation import PreparationError
from visualflowdiff.registry import Registry, COLUMNS
from registry_fixture import Dataset, Executor, Frame


def record():
    return {'identity': {'schema': 1, 'instance': 'https://dss.example',
                         'sourceProjectKey': 'SOURCE', 'commitId': 'a' * 40},
            'branchName': 'vfd_branch', 'bootstrapBranch': 'vfd_init_nonce',
            'baseKey': 'VFD_SOURCE', 'suffix': 0, 'state': 'reserved', 'createdAt': 1.25}


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.dataset, self.executor = Dataset(), Executor()
        self.addCleanup(self.executor.db.close)
        self.registry = Registry(self.dataset, self.executor)

    def test_records_survive_connection_reopen_and_updates_preserve_other_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'registry.sqlite')
            first = Executor(path)
            registry = Registry(self.dataset, first)
            value = record()
            registry.write('one', value)
            registry.write('two', record())
            value.update(state='ready', projectKey='VFD_SOURCE_ABC', verifiedHead='b' * 40)
            registry.write('one', value)
            first.db.close()
            second = Executor(path)
            self.addCleanup(second.db.close)
            restored = Registry(self.dataset, second)
            self.assertEqual(restored.read('one'), value)
            self.assertEqual(restored.read('two')['state'], 'reserved')
            self.assertIsNone(restored.read('missing'))
            rows = second.db.execute('SELECT PREPARATION_STATUS, GENERATED_PROJECT_KEY, VERIFIED_HEAD FROM VISUAL_FLOW_DIFF_REGISTRY WHERE RECORD_KEY = ?', ('one',)).fetchall()
            self.assertEqual(rows, [('ready', 'VFD_SOURCE_ABC', 'b' * 40)])

    def test_quotes_backslashes_and_unicode_are_values_not_sql(self):
        value = record()
        value['note'] = "O'Brien \\ snowman ☃'; DROP TABLE VISUAL_FLOW_DIFF_REGISTRY;--"
        key = "'; DELETE FROM VISUAL_FLOW_DIFF_REGISTRY;--"
        self.registry.write(key, value)
        self.assertEqual(self.registry.read(key), value)
        self.assertNotIn('DROP TABLE', self.executor.calls[-2][0])

    def test_membership_is_scoped_to_instance_project_and_requested_commits(self):
        for key, instance, project, sha in (
                ('match', 'https://dss.example', 'SOURCE', 'a' * 40),
                ('other-instance', 'https://other.example', 'SOURCE', 'b' * 40),
                ('other-project', 'https://dss.example', 'OTHER', 'c' * 40),
                ('not-requested', 'https://dss.example', 'SOURCE', 'd' * 40)):
            value = record()
            value['identity'].update(instance=instance, sourceProjectKey=project, commitId=sha)
            self.registry.write(key, value)
        self.assertEqual(self.registry.registered_commits('https://dss.example/', 'SOURCE',
                         ['a' * 40, 'b' * 40, 'c' * 40]), {'a' * 40})
        self.assertEqual(self.registry.registered_commits('https://dss.example', "SOURCE'", ['a' * 40]), set())
        self.assertEqual(self.registry.registered_commits('https://dss.example', 'SOURCE', []), set())

    def test_membership_reader_uses_metadata_without_schema_initialization_queries(self):
        self.registry.write('one', record())
        self.executor.calls.clear()
        reader = Registry(self.dataset, self.executor, initialize=False)
        self.assertEqual(self.executor.calls, [])
        self.assertEqual(self.dataset.schema_writes, [])
        self.assertEqual(reader.registered_commits('https://dss.example', 'SOURCE', ['a' * 40]), {'a' * 40})
        self.assertEqual(len(self.executor.calls), 1)

    def test_membership_reader_does_not_initialize_empty_schema(self):
        self.dataset.columns = []
        self.executor.calls.clear()
        with self.assertRaises(PreparationError):
            Registry(self.dataset, self.executor, initialize=False)
        self.assertEqual(self.executor.calls, [])
        self.assertEqual(self.dataset.schema_writes, [])

    def test_non_snowflake_and_query_datasets_are_rejected(self):
        for change in ({'databaseType': 'PostgreSQL'}, {'query': 'SELECT 1', 'table': None}):
            dataset = Dataset()
            dataset.location['info'].update(change)
            with self.assertRaises(PreparationError):
                Registry(dataset, self.executor)
        self.dataset.location['locationInfoType'] = 'FS'
        with self.assertRaises(PreparationError):
            Registry(self.dataset, self.executor)

    def test_empty_dataset_without_table_is_initialized_and_can_store_records(self):
        executor = Executor(provision=False)
        self.addCleanup(executor.db.close)
        dataset = Dataset()
        dataset.columns = []
        # Match DSS's default behavior: an empty schema raises unless explicitly allowed.
        with self.assertRaisesRegex(Exception, 'No column in schema'):
            dataset.read_schema()
        registry = Registry(dataset, executor)
        self.assertEqual(len(dataset.schema_writes), 1)
        self.assertIn({'name': 'CREATED_AT', 'type': 'double'}, dataset.schema_writes[0])
        self.assertIn({'name': 'RECORD_JSON', 'type': 'string'}, dataset.schema_writes[0])
        registry.write('one', record())
        self.assertEqual(registry.read('one')['state'], 'reserved')
        before = len(executor.calls)
        Registry(dataset, executor)
        self.assertEqual(len(dataset.schema_writes), 1)
        self.assertFalse(any(query.startswith(('CREATE ', 'ALTER ')) for query, options in executor.calls[before:]))

    def test_empty_existing_table_adds_columns_without_dropping_placeholder(self):
        executor = Executor(provision=False)
        self.addCleanup(executor.db.close)
        executor.db.execute('CREATE TABLE VISUAL_FLOW_DIFF_REGISTRY (PLACEHOLDER VARCHAR)')
        dataset = Dataset()
        dataset.columns = ['PLACEHOLDER']
        registry = Registry(dataset, executor)
        registry.write('one', record())
        self.assertEqual(registry.read('one')['state'], 'reserved')
        self.assertIn('PLACEHOLDER', [column[1] for column in executor.db.execute('PRAGMA table_info(VISUAL_FLOW_DIFF_REGISTRY)')])
        self.assertIn('PLACEHOLDER', dataset.columns)

    def test_populated_unrelated_table_is_rejected_without_schema_changes(self):
        executor = Executor(provision=False)
        self.addCleanup(executor.db.close)
        executor.db.execute('CREATE TABLE VISUAL_FLOW_DIFF_REGISTRY (OTHER VARCHAR)')
        executor.db.execute("INSERT INTO VISUAL_FLOW_DIFF_REGISTRY VALUES ('keep')")
        dataset = Dataset()
        dataset.columns = []
        with self.assertRaisesRegex(PreparationError, 'contains data'):
            Registry(dataset, executor)
        self.assertEqual(dataset.schema_writes, [])
        self.assertEqual(executor.db.execute('SELECT * FROM VISUAL_FLOW_DIFF_REGISTRY').fetchall(), [('keep',)])
        self.assertFalse(any(query.startswith(('CREATE ', 'ALTER ')) for query, options in executor.calls))

    def test_existing_registry_with_rows_and_empty_dss_schema_only_updates_metadata(self):
        self.registry.write('one', record())
        self.dataset.columns = []
        before = len(self.executor.calls)
        registry = Registry(self.dataset, self.executor)
        self.assertEqual(len(self.dataset.schema_writes), 1)
        self.assertEqual(registry.read('one')['state'], 'reserved')
        self.assertFalse(any(query.startswith(('CREATE ', 'ALTER ')) for query, options in self.executor.calls[before:]))

    def test_initialization_permission_errors_do_not_write_dataset_schema(self):
        executor = Mock()
        executor.query_to_df.side_effect = RuntimeError('Permission denied')
        self.dataset.columns = []
        with self.assertRaisesRegex(PreparationError, 'schema-write access'):
            Registry(self.dataset, executor)
        self.assertEqual(self.dataset.schema_writes, [])

    def test_schema_read_permission_errors_still_fail_without_metadata_changes(self):
        from unittest.mock import patch
        self.dataset.columns = []
        with patch.object(self.dataset, 'read_schema', side_effect=RuntimeError('Read schema denied')) as read:
            with self.assertRaises(PreparationError) as failure:
                Registry(self.dataset, self.executor)
            read.assert_called_once_with(raise_if_empty=False)
        self.assertEqual(str(failure.exception.__cause__), 'Read schema denied')
        self.assertEqual(self.dataset.schema_writes, [])

    def test_retry_after_dss_schema_write_failure_reuses_created_table(self):
        executor = Executor(provision=False)
        self.addCleanup(executor.db.close)
        dataset = Dataset()
        dataset.columns = []
        from unittest.mock import patch
        with patch.object(dataset, 'write_schema', side_effect=RuntimeError('DSS schema permission denied')):
            with self.assertRaisesRegex(PreparationError, 'schema-write access'):
                Registry(dataset, executor)
        calls_before_retry = len(executor.calls)
        registry = Registry(dataset, executor)
        registry.write('one', record())
        self.assertEqual(registry.read('one')['state'], 'reserved')
        self.assertFalse(any(query.startswith(('CREATE ', 'ALTER ')) for query, options in executor.calls[calls_before_retry:]))

    def test_ambiguous_physical_columns_are_rejected_without_schema_changes(self):
        executor = Mock()
        executor.query_to_df.return_value = Frame([], ['RECORD_KEY', 'record_key'])
        with self.assertRaisesRegex(PreparationError, 'ambiguous columns'):
            Registry(self.dataset, executor)
        self.assertEqual(self.dataset.schema_writes, [])

    def test_lowercase_columns_and_quoted_table_identifiers(self):
        dataset = Dataset()
        dataset.columns = list(COLUMNS)
        dataset.location['info'].update(catalog='Db', schema='a"b', table='table.name')
        executor = Mock()
        executor.query_to_df.return_value = Frame([], list(COLUMNS))
        registry = Registry(dataset, executor)
        self.assertEqual(registry.table, '"Db"."a""b"."table.name"')
        self.assertIn('"record_json"', executor.query_to_df.call_args.args[0])

    def test_read_errors_are_not_interpreted_as_missing_and_write_errors_are_actionable(self):
        self.registry.executor = Mock()
        self.registry.executor.query_to_df.side_effect = RuntimeError('private SQL details')
        with self.assertRaisesRegex(PreparationError, 'Unable to read'):
            self.registry.read('one')
        with self.assertRaisesRegex(PreparationError, 'INSERT/UPDATE permissions'):
            self.registry.write('one', record())

    def test_duplicate_and_corrupt_records_fail_instead_of_recreating_projects(self):
        self.registry.write('one', record())
        self.executor.db.execute('INSERT INTO VISUAL_FLOW_DIFF_REGISTRY SELECT * FROM VISUAL_FLOW_DIFF_REGISTRY')
        with self.assertRaisesRegex(PreparationError, 'duplicate records'):
            self.registry.read('one')
        self.executor.db.execute('DELETE FROM VISUAL_FLOW_DIFF_REGISTRY')
        self.registry.write('one', record())
        self.executor.db.execute("UPDATE VISUAL_FLOW_DIFF_REGISTRY SET RECORD_JSON = 'broken'")
        with self.assertRaisesRegex(PreparationError, 'Unable to read'):
            self.registry.read('one')

    def test_legacy_import_preserves_provenance_is_repeatable_and_rejects_conflicts(self):
        value = record()
        value.update(projectKey='VFD_EXISTING', verifiedHead='a' * 40, state='ready')
        self.assertTrue(self.registry.import_record(value))
        self.assertFalse(self.registry.import_record(value))
        from visualflowdiff.preparation import digest
        saved = self.registry.read(digest(value['identity']))
        self.assertEqual(saved['bootstrapBranch'], value['bootstrapBranch'])
        self.assertEqual(saved['projectKey'], 'VFD_EXISTING')
        value['projectKey'] = 'VFD_OTHER'
        with self.assertRaisesRegex(PreparationError, 'will not be overwritten'):
            self.registry.import_record(value)


if __name__ == '__main__':
    unittest.main()
