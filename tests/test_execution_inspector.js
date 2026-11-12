'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncRecipe, scoringRecipe, prepareStepRows } = require('../resource/flow-comparison.js');
const fixture = (name) => structuredClone(require(`./fixtures/${name}_recipe.json`));
const field = (model, label) => model.steps.flatMap((s) => s.fields).find((f) => f.label === label);

test('supplied Sync definition with an empty payload exposes schema, I/O, write mode and engine options', () => {
    const { before, after } = fixture('sync');
    const original = structuredClone(before);
    const left = syncRecipe(before), right = syncRecipe(after);
    assert.equal(left.unavailable, undefined);
    assert.equal(field(left, 'Schema handling').value, 'Strict schema synchronization');
    assert.equal(field(left, 'Input dataset').value, 'revenue_prediction');
    assert.equal(field(left, 'Output dataset').value, 'revenue_prediction_copy');
    assert.equal(field(left, 'Write mode').value, 'Overwrite');
    assert.equal(field(right, 'Write mode').value, 'Append');
    assert.equal(field(right, 'Engine settings / Maximum threads').value, 8);
    const rows = prepareStepRows(left.steps, right.steps);
    assert.equal(rows.find((r) => r.left.title === 'Synchronization').status, 'modified');
    assert.equal(rows.find((r) => r.left.title === 'Build behavior').status, 'unchanged');
    assert.deepEqual(before, original);
});

test('supplied scoring options preserve inactive thresholds, empty columns, false, zero and null runtime values', () => {
    const { before, after } = fixture('scoring');
    const original = structuredClone(before);
    const left = scoringRecipe(before), right = scoringRecipe(after);
    assert.equal(field(left, 'Saved model').value, 'Vs6j4B8H');
    assert.equal(field(left, 'Keep only selected input columns').value, false);
    assert.deepEqual(field(left, 'Input columns to keep (when filtering is on)').value, []);
    assert.equal(field(left, 'Classification threshold (when override is on)').value, 0);
    assert.equal(field(right, 'Classification threshold (when override is on)').value, 0.65);
    assert.equal(field(left, 'Spark settings / Allow pipeline merging').value, null);
    assert.equal(field(left, 'GPU settings / Use GPU').value, true);
    assert.equal(field(right, 'GPU settings / Use GPU').value, false);
    assert.equal(field(left, 'Output class probabilities').value, true);
    assert.deepEqual(before, original);
});

test('model names resolve with IDs and I/O reference order does not create false differences', () => {
    const { before } = fixture('scoring');
    const modelId = JSON.stringify(['COMPUTABLE_SAVED_MODEL', 'Vs6j4B8H']);
    assert.equal(field(scoringRecipe(before, { [modelId]: { id: modelId, kind: 'model', name: 'Revenue model' } }), 'Saved model').value, 'Revenue model (Vs6j4B8H)');
    const { before: sync } = fixture('sync');
    sync.config.definition.outputs.main.items.push({ ref: 'archive', appendMode: true });
    const reordered = structuredClone(sync);
    reordered.config.definition.outputs.main.items.reverse();
    assert.ok(prepareStepRows(syncRecipe(sync).steps, syncRecipe(reordered).steps).every((row) => row.status === 'unchanged'));
    const changed = structuredClone(sync);
    changed.config.definition.outputs.main.items[0].ref = 'new_output';
    const a = syncRecipe(sync).steps[0].fields, b = syncRecipe(changed).steps[0].fields;
    assert.ok(a.some((f) => !b.some((other) => other.key === f.key)));
});

test('unknown options and malformed I/O are retained; missing and partial captures remain explicit', () => {
    for (const [name, adapt] of [['sync', syncRecipe], ['scoring', scoringRecipe]]) {
        const { before } = fixture(name);
        assert.equal(adapt(undefined), undefined);
        assert.equal(adapt({ ...before, kind: 'dataset' }), undefined);
        assert.equal(adapt({ ...before, subType: 'python', config: { definition: { type: 'python' } } }), undefined);
        for (const coverage of ['graph-only', 'external-reference']) assert.equal(adapt({ ...before, coverage }).unavailable, true);
        assert.equal(adapt({ ...before, config: {} }).unavailable, true);
        before.config.definition.params.future = { disabled: false, note: '', count: 0 };
        before.config.definition.outputs.main.items = [null];
        const result = adapt(before);
        assert.equal(field(result, 'Future / Disabled').value, false);
        assert.equal(field(result, 'Future / Note').value, '');
        assert.equal(field(result, 'Future / Count').value, 0);
        assert.ok(result.steps[0].fields.some((f) => f.value?.[0] === null));
    }
    const { before } = fixture('scoring');
    for (const payload of [undefined, '', null, []]) {
        before.config.payload = payload;
        assert.equal(scoringRecipe(before).unavailable, true);
    }
});
