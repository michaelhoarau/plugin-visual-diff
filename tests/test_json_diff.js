const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jsonRows } = require('../resource/flow-comparison.js');
const { codeRows, recipeCode } = require('../resource/flow-comparison.js');

test('source diff aligns insertions and preserves indentation, blanks, escapes and trailing newline', () => {
    const before = 'import dataiku\n\ndef run():\n\tprint("literal \\n <script>")\n    return 1\n';
    const after = before.replace('    return 1', '    log()\n    return 2');
    const rows = codeRows(before, after);
    for (const [side, expected] of [['left', before], ['right', after]]) {
        assert.equal(rows.filter((row) => row[side] !== null).map((row) => row[side]).join('\n'), expected);
        assert.deepEqual(rows.filter((row) => row[side] !== null).map((row) => row[side + 'Number']),
            expected.split('\n').map((_, index) => index + 1));
    }
    const inserted = codeRows('first\nlast', 'first\ninserted\nlast');
    assert.deepEqual(inserted.map((row) => row.status), ['unchanged', 'added', 'unchanged']);
    assert.equal(inserted[1].left, null);
    assert.deepEqual(codeRows('first\nremoved\nlast', 'first\nlast').map((row) => row.status), ['unchanged', 'deleted', 'unchanged']);
});

test('source diff handles absent/empty payloads and normalizes line endings', () => {
    assert.ok(codeRows(undefined, '').every((row) => row.status === 'added'));
    assert.ok(codeRows('x\n', undefined).every((row) => row.status === 'deleted'));
    assert.deepEqual(codeRows(undefined, undefined), []);
    assert.ok(codeRows('x\r\ny\r\n', 'x\ny\n').every((row) => row.status === 'unchanged'));
    const rows = codeRows('old\n'.repeat(2100), 'new\n'.repeat(2100));
    assert.equal(rows.filter((row) => row.left !== null).length, 2101);
    assert.equal(rows.filter((row) => row.right !== null).length, 2101);
});

test('source extraction supports code recipe types and excludes visual recipes and other objects', () => {
    const recipe = (type, payload = '') => ({ kind: 'recipe', config: { definition: { type }, payload } });
    for (const type of ['python', 'r', 'sql', 'spark_scala', 'pyspark', 'spark_sql', 'sparkr', 'shell']) {
        assert.equal(recipeCode(recipe(type, 'code')), 'code');
        assert.equal(recipeCode(recipe(type)), '');
    }
    assert.equal(recipeCode({ kind: 'recipe', subType: 'python', config: { payload: 'code' } }), 'code');
    assert.equal(recipeCode(recipe('shaker', '{"steps":[]}')), undefined);
    assert.equal(recipeCode(recipe('python', {})), undefined);
    assert.equal(recipeCode({ ...recipe('python'), kind: 'dataset' }), undefined);
    assert.equal(recipeCode(undefined), undefined);
});

test('aligned JSON preserves both complete structures and highlights changed and missing keys', () => {
    const before = { z: { nested: [1, 2] }, deleted: { text: '<script>' }, common: 'old' };
    const after = { common: 'new', added: true, z: { nested: [1, 3] } };
    const rows = jsonRows(before, after);
    assert.deepEqual(JSON.parse(rows.filter((row) => row.left !== null).map((row) => row.left).join('\n')), before);
    assert.deepEqual(JSON.parse(rows.filter((row) => row.right !== null).map((row) => row.right).join('\n')), after);
    assert.ok(rows.some((row) => row.status === 'deleted' && row.left.includes('<script>')));
    assert.ok(rows.some((row) => row.status === 'added' && row.right.includes('added')));
    assert.ok(rows.some((row) => row.status === 'modified'));
});

test('added/deleted objects leave the other side blank, preserving null and empty values', () => {
    const object = { config: null, inputs: [], name: '' };
    assert.ok(jsonRows(undefined, object).every((row) => row.left === null));
    assert.ok(jsonRows(object, undefined).every((row) => row.right === null));
    assert.ok(jsonRows(object, object).every((row) => row.status === 'unchanged'));
});

test('configuration keys matching Object prototype names remain plain JSON values', () => {
    const before = JSON.parse('{"constructor": "old", "__proto__": {"text": "safe"}}');
    const after = { toString: 'new' };
    const rows = jsonRows(before, after);
    for (const [side, expected] of [['left', before], ['right', after]]) {
        assert.deepEqual(JSON.parse(rows.filter((row) => row[side] !== null).map((row) => row[side]).join('\n')), expected);
    }
});
