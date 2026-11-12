"""Store preparation records in a selected Snowflake dataset, with one writer.

SQL is executed through the webapp backend's DSS identity and connection. Source
project operations continue to use the separately authenticated viewer client.
No local persistence, locks, leases, or database coordination is implemented.
"""
import json
import time
from copy import deepcopy

from .preparation import PreparationError, digest


COLUMNS = (
    'record_key', 'instance_url', 'source_project_key', 'commit_sha',
    'generated_project_key', 'branch_name', 'preparation_status', 'verified_head',
    'created_at', 'updated_at', 'record_json',
)
SQL_TYPES = {column: 'VARCHAR' for column in COLUMNS}
SQL_TYPES.update(record_key='VARCHAR(64)', commit_sha='VARCHAR(40)',
                 verified_head='VARCHAR(40)', created_at='DOUBLE', updated_at='DOUBLE')


def schema_type(column):
    """Return the DSS type for a registry column."""
    return 'double' if column in ('created_at', 'updated_at') else 'string'


def identifier(value):
    """Quote one resolved SQL identifier, preserving its case and embedded quotes."""
    return '"' + value.replace('"', '""') + '"'


def text_value(value):
    """Encode UTF-8 SQL values as hex so quotes/backslashes cannot alter SQL."""
    if value is None:
        return 'NULL'
    return "TO_VARCHAR(TO_BINARY('%s', 'HEX'), 'UTF-8')" % str(value).encode('utf-8').hex()


class Registry:
    """Read and upsert individual records without rewriting the selected dataset.

    Empty datasets are initialized automatically. MERGE is a storage operation,
    not a concurrency guarantee. The caller supplies the supported single-writer
    execution model.
    """

    def __init__(self, dataset, executor, initialize=True):
        self.dataset = dataset
        self.executor = executor
        try:
            location = dataset.get_location_info(sensitive_info=False)
            info = location.get('info', {})
            if location.get('locationInfoType') != 'SQL' or info.get('databaseType', '').lower() != 'snowflake':
                raise PreparationError('Select a Snowflake SQL table dataset for the comparison registry.', 503)
            if not info.get('table') or info.get('query'):
                raise PreparationError('The registry dataset must reference a physical table, not a SQL query.', 503)
            parts = [info.get('catalog'), info.get('schema'), info['table']]
            self.table = '.'.join(identifier(part) for part in parts if part)
            if not initialize:
                # Badge lookups only need existing DSS column metadata. Schema
                # creation and physical-table checks belong to preparation.
                names = {}
                for column in dataset.read_schema(raise_if_empty=False):
                    names.setdefault(column['name'].lower(), []).append(column['name'])
                if any(len(names.get(column, [])) != 1 for column in COLUMNS):
                    raise PreparationError('The registry schema is not initialized. Prepare a comparison before checking registry status.', 503)
                self.columns = {column: identifier(names[column][0]) for column in COLUMNS}
                return
            self._initialize_schema()
            # Check the physical table before any source project is duplicated.
            executor.query_to_df('SELECT %s FROM %s WHERE 1 = 0' % (', '.join(self.columns.values()), self.table))
        except PreparationError:
            raise
        except Exception as error:
            raise PreparationError('Unable to initialize the registry dataset. Check backend dataset schema-write access and Snowflake SELECT, CREATE TABLE (if missing), and table ownership/ALTER rights (if columns are missing).', 503) from error

    def _initialize_schema(self):
        """Create missing storage, add columns only to empty tables, and sync DSS.

        The physical table is authoritative. CREATE IF NOT EXISTS never replaces
        a table, even if the first read failed because of permissions. Any second
        read failure is propagated, never interpreted as an empty table.
        """
        try:
            preview = self.executor.query_to_df('SELECT * FROM %s LIMIT 1' % self.table)
        except Exception:
            definitions = ', '.join('%s %s' % (identifier(column.upper()), SQL_TYPES[column]) for column in COLUMNS)
            self.executor.query_to_df('CREATE TABLE IF NOT EXISTS %s (%s)' % (self.table, definitions), post_queries=['COMMIT'])
            preview = self.executor.query_to_df('SELECT * FROM %s LIMIT 1' % self.table)

        def column_names(frame):
            names = {}
            for name in frame.columns:
                names.setdefault(name.lower(), []).append(name)
            return names

        names = column_names(preview)
        ambiguous = [column for column in COLUMNS if len(names.get(column, [])) > 1]
        if ambiguous:
            raise PreparationError('The registry table has ambiguous columns: %s. Its schema was not changed.' % ', '.join(ambiguous), 503)
        missing = [column for column in COLUMNS if column not in names]
        if missing and len(preview.index):
            raise PreparationError('The selected registry table contains data but is missing registry columns. Select an empty dedicated dataset or an existing registry table. Its schema was not changed.', 503)
        for column in missing:
            self.executor.query_to_df('ALTER TABLE %s ADD COLUMN %s %s' %
                                      (self.table, identifier(column.upper()), SQL_TYPES[column]), post_queries=['COMMIT'])
        if missing:
            preview = self.executor.query_to_df('SELECT * FROM %s LIMIT 1' % self.table)
            names = column_names(preview)
        if any(len(names.get(column, [])) != 1 for column in COLUMNS):
            raise PreparationError('Unable to verify the initialized registry columns. Check Snowflake permissions and retry.', 503)
        self.columns = {column: identifier(names[column][0]) for column in COLUMNS}
        expected = [{'name': names[column][0], 'type': schema_type(column)} for column in COLUMNS]
        # A newly created DSS dataset legitimately has zero columns. The default
        # read_schema() raises in that case, before write_schema can initialize it.
        schema = self.dataset.read_schema(raise_if_empty=False)
        current = [{'name': column['name'], 'type': column['type']} for column in schema
                   if column['name'].lower() in COLUMNS]
        if sorted(current, key=lambda column: column['name']) != sorted(expected, key=lambda column: column['name']):
            # This public API updates DSS metadata only: never drop_and_create.
            extras = [column for column in schema if column['name'].lower() not in COLUMNS]
            self.dataset.write_schema(expected + extras, drop_and_create=False)

    def read(self, key):
        """Read one durable record; SQL failures never count as a missing record."""
        try:
            rows = self.executor.query_to_df(
                'SELECT %s FROM %s WHERE %s = %s LIMIT 2' %
                (self.columns['record_json'], self.table, self.columns['record_key'], text_value(key)))
            if len(rows.index) > 1:
                raise PreparationError('The registry contains duplicate records for this revision. Resolve them before retrying.', 409)
            if not len(rows.index):
                return None
            record = json.loads(rows.iloc[0, 0])
            if not isinstance(record, dict):
                raise ValueError('Expected a registry object')
            return record
        except PreparationError:
            raise
        except Exception as error:
            raise PreparationError('Unable to read the comparison registry. Check backend logs and registry dataset access before retrying.', 503) from error

    def registered_commits(self, instance, project_key, commit_ids):
        """Return registered SHAs for one history page, scoped to its source."""
        if not commit_ids:
            return set()
        try:
            rows = self.executor.query_to_df(
                'SELECT DISTINCT %s FROM %s WHERE %s = %s AND %s = %s AND %s IN (%s)' % (
                    self.columns['commit_sha'], self.table,
                    self.columns['instance_url'], text_value(instance.rstrip('/')),
                    self.columns['source_project_key'], text_value(project_key),
                    self.columns['commit_sha'], ', '.join(text_value(sha) for sha in commit_ids)))
            return {row[0] for row in rows.itertuples(index=False, name=None)}
        except Exception as error:
            raise PreparationError('Unable to check commit membership in the comparison registry.', 503) from error

    def list_records(self):
        """Read cleanup candidates; preserve corrupt rows for explicit reporting."""
        try:
            rows = self.executor.query_to_df('SELECT %s, %s FROM %s ORDER BY %s' % (
                self.columns['record_key'], self.columns['record_json'], self.table, self.columns['record_key']))
            records = []
            seen = set()
            for key, raw in rows.itertuples(index=False, name=None):
                if key in seen:
                    raise PreparationError('The registry has duplicate record keys. Resolve them before cleanup; no projects were deleted.', 409)
                seen.add(key)
                try:
                    record = json.loads(raw)
                except (ValueError, TypeError):
                    record = None
                records.append((key, record))
            return records
        except PreparationError:
            raise
        except Exception as error:
            raise PreparationError('Unable to list the registry for cleanup. Check backend logs and dataset access.', 503) from error

    def check_cleanup_access(self):
        """Verify DELETE privileges before deleting any project; change no rows."""
        try:
            self.executor.query_to_df('DELETE FROM %s WHERE 1 = 0' % self.table, post_queries=['COMMIT'])
        except Exception as error:
            raise PreparationError('Cleanup requires DELETE permission on the Snowflake registry table. No projects were deleted. Check backend logs and retry.', 503) from error

    def remove(self, key):
        """Commit removal only after the caller verifies the project is absent."""
        try:
            self.executor.query_to_df('DELETE FROM %s WHERE %s = %s' % (
                self.table, self.columns['record_key'], text_value(key)), post_queries=['COMMIT'])
        except Exception as error:
            raise PreparationError('The project is absent, but its registry record could not be removed. Check DELETE permission on the registry table and retry cleanup.', 503) from error

    def write(self, key, record):
        """Commit one complete recovery record before continuing DSS operations."""
        record['updatedAt'] = time.time()
        identity = record['identity']
        values = {
            'record_key': key, 'instance_url': identity['instance'],
            'source_project_key': identity['sourceProjectKey'], 'commit_sha': identity['commitId'],
            'generated_project_key': record.get('projectKey'), 'branch_name': record['branchName'],
            'preparation_status': record['state'], 'verified_head': record.get('verifiedHead'),
            'created_at': record['createdAt'], 'updated_at': record['updatedAt'],
            'record_json': json.dumps(record, sort_keys=True),
        }
        expressions = [str(float(values[column])) if column in ('created_at', 'updated_at')
                       else text_value(values[column]) for column in COLUMNS]
        source = ', '.join('%s AS %s' % (value, self.columns[column]) for column, value in zip(COLUMNS, expressions))
        updates = ', '.join('%s = s.%s' % (self.columns[column], self.columns[column])
                            for column in COLUMNS if column != 'record_key')
        columns = ', '.join(self.columns[column] for column in COLUMNS)
        inserts = ', '.join('s.' + self.columns[column] for column in COLUMNS)
        query = ('MERGE INTO %s t USING (SELECT %s) s ON t.%s = s.%s '
                 'WHEN MATCHED THEN UPDATE SET %s '
                 'WHEN NOT MATCHED THEN INSERT (%s) VALUES (%s)') % (
                     self.table, source, self.columns['record_key'], self.columns['record_key'], updates, columns, inserts)
        try:
            self.executor.query_to_df(query, post_queries=['COMMIT'])
        except Exception as error:
            raise PreparationError('Unable to save the comparison registry. Check backend logs and INSERT/UPDATE permissions on its Snowflake table. Retry to resume from the last saved record.', 503) from error

    def import_record(self, record):
        """Import a legacy JSON record once without overwriting a different record.

        Call explicitly during migration with preparation stopped. Input is an
        already loaded JSON object; this helper never accesses a local directory.
        """
        required = ('identity', 'baseKey', 'suffix', 'bootstrapBranch', 'branchName', 'state', 'createdAt')
        if not isinstance(record, dict) or any(field not in record for field in required):
            raise PreparationError('The legacy registry record is incomplete.', 400)
        origin = record['identity']
        if not isinstance(origin, dict) or origin.get('schema') != 1 or any(
                not isinstance(origin.get(field), str) or not origin[field]
                for field in ('instance', 'sourceProjectKey', 'commitId')):
            raise PreparationError('The legacy registry identity is invalid.', 400)
        key = digest(origin)
        existing = self.read(key)
        if existing is not None:
            without_timestamp = lambda value: {name: content for name, content in value.items() if name != 'updatedAt'}
            if without_timestamp(existing) != without_timestamp(record):
                raise PreparationError('A different registry record already exists for this revision. It will not be overwritten.', 409)
            return False
        self.write(key, deepcopy(record))
        return True
