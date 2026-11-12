"""Exercise registry SQL reads and values with SQLite, translating Snowflake MERGE.

This validates storage behavior locally; it is not a Snowflake compatibility test.
"""
from pathlib import Path
import re
import sqlite3


class Frame:
    def __init__(self, rows, columns=()):
        self.rows = rows
        self.columns = list(columns)
        self.index = range(len(rows))
        self.iloc = self

    def __getitem__(self, position):
        row, column = position
        return self.rows[row][column]

    def itertuples(self, index=False, name=None):
        return iter(self.rows)


class Dataset:
    def __init__(self):
        from visualflowdiff.registry import COLUMNS
        self.columns = [column.upper() for column in COLUMNS]
        self.schema_writes = []
        self.location = {'locationInfoType': 'SQL', 'info': {
            'databaseType': 'Snowflake', 'table': 'VISUAL_FLOW_DIFF_REGISTRY',
            'schema': None, 'catalog': None}}

    def get_location_info(self, sensitive_info=False):
        assert not sensitive_info
        return self.location

    def read_schema(self, raise_if_empty=True):
        from visualflowdiff.registry import schema_type
        if raise_if_empty and not self.columns:
            raise Exception('No column in schema. Have you set up the schema for this dataset?')
        return [{'name': column, 'type': schema_type(column.lower())} for column in self.columns]

    def write_schema(self, schema, drop_and_create=False):
        assert not drop_and_create
        self.schema_writes.append(schema)
        self.columns = [column['name'] for column in schema]


class Executor:
    def __init__(self, path=':memory:', provision=True):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.create_function('TO_BINARY', 2, lambda value, encoding: bytes.fromhex(value))
        self.db.create_function('TO_VARCHAR', 2, lambda value, encoding: value.decode('utf-8'))
        schema = (Path(__file__).resolve().parents[1] / 'webapps/webapp/registry-schema.sql').read_text()
        if provision:
            self.db.executescript(schema.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
        self.calls = []

    def query_to_df(self, query, **options):
        self.calls.append((query, options))
        if query.startswith('MERGE INTO '):
            assert options == {'post_queries': ['COMMIT']}
            source = re.search(r'USING \(SELECT (.+)\) s ON ', query).group(1)
            cursor = self.db.execute('SELECT ' + source)
            row = cursor.fetchone()
            columns = [description[0] for description in cursor.description]
            names = ', '.join('"' + column + '"' for column in columns)
            # Emulate the storage-only MERGE on a single-writer SQLite connection.
            self.db.execute('DELETE FROM VISUAL_FLOW_DIFF_REGISTRY WHERE RECORD_KEY = ?', (row[0],))
            self.db.execute('INSERT INTO VISUAL_FLOW_DIFF_REGISTRY (%s) VALUES (%s)' %
                            (names, ', '.join('?' for _ in columns)), row)
            self.db.commit()
            return Frame([])
        cursor = self.db.execute(query)
        rows = cursor.fetchall()
        if options.get('post_queries'):
            assert options == {'post_queries': ['COMMIT']}
            self.db.commit()
        return Frame(rows, [column[0] for column in cursor.description] if cursor.description else [])
