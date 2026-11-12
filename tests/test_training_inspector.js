'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trainingRecipe, prepareStepRows } = require('../resource/flow-comparison.js');
const fixture = () => structuredClone(require('./fixtures/training_recipe.json'));

test('training groups align by identity with granular feature and hyperparameter fields', () => {
    const { before, after } = fixture();
    const original = structuredClone(before);
    const left = trainingRecipe(before), right = trainingRecipe(after);
    const rows = prepareStepRows(left.steps, right.steps);
    const group = (title) => rows.find((row) => row.left?.title === title || row.right?.title === title);
    assert.equal(group('Training task').status, 'unchanged');
    assert.equal(group('Algorithms').status, 'modified');
    assert.equal(group('Features').status, 'modified');
    assert.equal(group('Additional settings').status, 'deleted');
    assert.equal(group('Algorithms').right.fields.find((f) => f.label.endsWith('N Estimators')).value, 200);
    assert.equal(group('Features').right.fields.find((f) => f.label.endsWith('Country / Role')).value, 'INPUT');
    assert.deepEqual(before, original);
    const reversed = prepareStepRows(right.steps, left.steps);
    assert.equal(reversed.find((row) => row.right?.title === 'Additional settings').status, 'added');
});

test('prediction and clustering support both recipe kinds but scoring and models do not', () => {
    const { before } = fixture();
    for (const kind of ['recipe', 'ml-recipe']) {
        before.kind = kind;
        for (const type of ['prediction_training', 'clustering_training']) {
            before.config.definition.type = type;
            assert.ok(trainingRecipe(before).steps.length);
        }
    }
    before.config.definition.type = 'prediction_scoring';
    assert.equal(trainingRecipe(before), undefined);
    assert.equal(trainingRecipe({ ...before, kind: 'model', subType: 'prediction_training' }), undefined);
    assert.equal(trainingRecipe(undefined), undefined);
});

test('unknown settings, false, zero, null, empty containers and ordered arrays are retained', () => {
    const { before } = fixture();
    before.config.payload = { futureOption: { enabled: false, count: 0, empty: '', unknown: null, list: [], map: {}, ordered: ['b', 'a'] } };
    const fields = trainingRecipe(before).steps.find((s) => s.title === 'Additional settings').fields;
    assert.deepEqual(fields.map((f) => f.value), [0, '', false, [], {}, ['b', 'a'], null]);
    const reordered = structuredClone(before);
    reordered.config.payload.futureOption = Object.fromEntries(Object.entries(reordered.config.payload.futureOption).reverse());
    assert.ok(prepareStepRows(trainingRecipe(before).steps, trainingRecipe(reordered).steps).every((r) => r.status === 'unchanged'));
});

test('missing or graph-only captures explicitly report unavailable settings', () => {
    for (const payload of [undefined, null, 'raw', []]) {
        assert.equal(trainingRecipe({ kind: 'ml-recipe', subType: 'prediction_training', config: { payload } }).unavailable, true);
    }
    const { before } = fixture();
    for (const coverage of ['graph-only', 'external-reference']) {
        assert.equal(trainingRecipe({ ...before, coverage }).unavailable, true);
    }
    before.config.payload = {};
    assert.equal(trainingRecipe(before).unavailable, undefined);
});
