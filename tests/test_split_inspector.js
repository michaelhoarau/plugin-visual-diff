'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitRecipe, splitConditionRows } = require('../resource/flow-comparison.js');
const fixture = require('./split_fixture.js');

test('Split model resolves destinations against each version, keeping reordered small output unchanged', () => {
    const { before, after } = fixture();
    const left = splitRecipe(before), right = splitRecipe(after);
    assert.equal(left.ranges[0].Output, 'plik-small-files');
    assert.equal(right.ranges[0].Output, left.ranges[0].Output);
    assert.equal(left.ranges[0].To, '10,000,000');
    assert.equal(right.ranges[0].To, '2,000,000');
    assert.equal(right.ranges[1].From, '2,000,000');
    assert.equal(right.ranges[1].To, '50,000,000');
    assert.equal(left.ranges[1].Output, 'plik-medium-files');
    assert.equal(right.ranges[1].Output, 'plik-medium-logs');
    assert.equal(right.remaining.Output, 'plik-large-logs');
    assert.equal(left.remaining.Output, 'plik-large-files');
    assert.equal(left.conditions[0].Column, 'archive_uncompressed_size');
    assert.deepEqual(left.conditions[0], right.conditions[0]); // legacy col metadata is not the selected UI input
    const rows = splitConditionRows(left.conditions, right.conditions);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0].left, rows[0].right);
    assert.equal(rows[2].left.Column, 'archive_file_count');
    assert.equal(rows[2].right, undefined);
    assert.equal(before.config.payload.preFilter.uiData.conditions.length, 3); // adapter leaves snapshots untouched
});

test('Condition insertions stay aligned; empty and missing sides do not generate phantom conditions', () => {
    const a = { Column: 'size', Operator: '>', Value: '0' }, b = { Column: 'count', Operator: '=', Value: '1' };
    const rows = splitConditionRows([a], [b, a]);
    assert.equal(rows[0].left, undefined);
    assert.deepEqual(rows[1], { left: a, right: a });
    assert.deepEqual(splitConditionRows(), []);
    assert.deepEqual(splitConditionRows([a]), [{ left: a, right: undefined }]);
});

test('Bounds retain inclusion semantics; invalid destinations and unsupported payloads are explicit', () => {
    const { before } = fixture();
    before.config.payload.rangeSplits[0].filter.uiData.conditions[0].operator = '>  [number]';
    before.config.payload.rangeSplits[0].filter.uiData.conditions[1].operator = '<= [number]';
    before.config.payload.rangeSplits[0].outputIndex = 99;
    const model = splitRecipe(before);
    assert.equal(model.ranges[0]['Lower bound'], 'Exclusive');
    assert.equal(model.ranges[0]['Upper bound'], 'Inclusive');
    assert.equal(model.ranges[0].Output, 'Unresolved output (99)');
    before.config.payload.rangeSplits = [null, { filter: { uiData: { conditions: [null, null] } } }];
    assert.doesNotThrow(() => splitRecipe(before));
    before.config.payload = null;
    assert.equal(splitRecipe(before).unavailable, true);
    assert.equal(splitRecipe({ ...before, kind: 'dataset' }), undefined);
    assert.equal(splitRecipe(undefined), undefined);
});
