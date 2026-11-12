'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareRecipe, prepareStepRows, prepareMapping, prepareMappingRows, prepareIfRule } = require('../resource/flow-comparison.js');
const fixture = () => structuredClone(require('./fixtures/prepare_recipe.json'));
const recipe = (steps) => ({ kind: 'recipe', subType: 'shaker', config: { payload: { steps } } });
const rows = (a, b) => prepareStepRows(prepareRecipe(recipe(a)).steps, prepareRecipe(recipe(b)).steps);
const step = (type, value, extra = {}) => ({ type, params: { value }, ...extra });

test('supplied Prepare settings retain off/on, formula, empty error column and removal direction', () => {
    const { before, after } = fixture();
    const original = structuredClone(before);
    const left = prepareRecipe(before), right = prepareRecipe(after);
    const diff = prepareStepRows(left.steps, right.steps);
    assert.deepEqual(diff.map((row) => row.status), ['modified', 'deleted']);
    assert.equal(left.steps[0].fields.find((f) => f.label === 'Extract country code').value, false);
    assert.equal(right.steps[0].fields.find((f) => f.label === 'Extract country code').value, true);
    assert.equal(left.steps[1].fields.find((f) => f.label === 'Expression').value, 'val("pages_visited") > 7');
    assert.equal(left.steps[1].fields.find((f) => f.label === 'Error column').value, '');
    assert.deepEqual(prepareStepRows(right.steps, left.steps).map((row) => row.status), ['modified', 'added']);
    assert.deepEqual(before, original);
});

test('insertions and removals preserve exact downstream matches and original step numbers', () => {
    const a = step('A', 1), b = step('B', 2), c = step('C', 3);
    const diff = rows([a, c], [a, b, c]);
    assert.deepEqual(diff.map((r) => r.status), ['unchanged', 'added', 'unchanged']);
    assert.equal(diff[2].left.index, 1);
    assert.equal(diff[2].right.index, 2);
    assert.deepEqual(rows([a, b, c], [a, c]).map((r) => r.status), ['unchanged', 'deleted', 'unchanged']);
    assert.deepEqual(rows([], []), []);
});

test('IDs preserve modified identity, conflicting IDs and ambiguous repeats are never paired', () => {
    const a = step('A', 1, { id: 'one' }), b = step('A', 2, { id: 'two' });
    assert.deepEqual(rows([a, b], [{ ...a, params: { value: 3 } }, b]).map((r) => r.status), ['modified', 'unchanged']);
    assert.deepEqual(rows([a], [{ ...a, id: 'different' }]).map((r) => r.status), ['deleted', 'added']);
    assert.ok(rows([step('A', 1), step('A', 2)], [step('A', 3), step('A', 4)]).every((r) => !r.left || !r.right));
    const moved = rows([a, b], [b, a]);
    assert.equal(moved.filter((r) => r.status === 'unchanged').length, 1);
    assert.equal(moved.filter((r) => r.status === 'added').length, 1);
    assert.equal(moved.filter((r) => r.status === 'deleted').length, 1);
});

test('editor state does not change steps; disabled, comments and unknown parameters do', () => {
    const a = step('PluginProcessor', { a: 1, b: 2 }, { preview: false, alwaysShowComment: false });
    assert.equal(rows([a], [{ ...a, params: { value: { b: 2, a: 1 } }, preview: true, alwaysShowComment: true }])[0].status, 'unchanged');
    for (const extra of [{ disabled: true }, { comment: '<script>unsafe</script>' }, { custom: { k: 1 } }]) {
        assert.equal(rows([a], [{ ...a, ...extra }])[0].status, 'modified');
    }
    assert.equal(prepareRecipe(recipe([a])).steps[0].known, false);
    const known = fixture().before;
    known.config.payload.steps[0].params.extraSetting = { nested: true };
    assert.deepEqual(prepareRecipe(known).steps[0].fields.find((f) => f.label === 'extraSetting').value, { nested: true });
});

test('missing, empty and malformed payloads remain explicit and do not crash the adapter', () => {
    assert.equal(prepareRecipe(undefined), undefined);
    assert.equal(prepareRecipe({ kind: 'dataset', subType: 'shaker' }), undefined);
    for (const payload of [undefined, 'json', null, {}, { steps: {} }]) {
        assert.equal(prepareRecipe({ kind: 'recipe', subType: 'shaker', config: { payload } }).unavailable, true);
    }
    assert.deepEqual(prepareRecipe(recipe([])).steps, []);
    assert.doesNotThrow(() => rows([null, 3, { type: 'X', params: null }], []));
    const { before } = fixture();
    delete before.config.payload.steps[0].params.extract_country;
    assert.equal(prepareRecipe(before).steps[0].fields.find((f) => f.label === 'Extract country').value, undefined);
});

test('large identical scripts use bounded alignment and retain every processor on each side', () => {
    const a = Array.from({ length: 1100 }, () => step('A', 1));
    const diff = rows(a, a);
    assert.equal(diff.filter((r) => r.left).length, a.length);
    assert.equal(diff.filter((r) => r.right).length, a.length);
    assert.ok(diff.every((r) => r.status === 'unchanged'));
});

test('Find / Replace and column renaming expose native mapping labels and preserve values', () => {
    const entries = [{ from: 'False', to: 'control' }, { from: 'True', to: 'campaign' }];
    const source = recipe([
        { type: 'FindReplace', params: { mapping: entries, columns: ['flag'], useDatasetForMapping: false } },
        { type: 'ColumnRenamer', params: { renamings: [{ from: 'customer_id', to: 'test_customer_id' }] } }
    ]);
    const original = structuredClone(source);
    const [replace, rename] = prepareRecipe(source).steps;
    assert.equal(replace.title, 'Find / Replace');
    assert.equal(replace.fields.find((f) => f.key === 'params.mapping').label, 'Replacements');
    assert.deepEqual(replace.fields.find((f) => f.label === 'Replacements').mapping.entries, entries);
    assert.equal(rename.fields[0].label, 'Renamings');
    assert.equal(rename.known, true);
    assert.deepEqual(source, original);
});

test('mapping diffs align by source, retain unchanged rows after insertions and preserve execution order', () => {
    const left = [{ from: 'False', to: 'control' }, { from: 'True', to: 'campaign' }];
    const added = { from: '', to: 'unknown' };
    const changed = { from: 'True', to: 'treatment' };
    assert.deepEqual(prepareMappingRows(prepareMapping(left), prepareMapping([added, left[0], changed])), [
        { left: undefined, right: added }, { left: left[0], right: left[0] }, { left: left[1], right: changed }
    ]);
    assert.deepEqual(prepareMappingRows(prepareMapping(left), prepareMapping([left[1]])), [
        { left: left[0], right: undefined }, { left: left[1], right: left[1] }
    ]);
    const reordered = prepareMappingRows(prepareMapping(left), prepareMapping([...left].reverse()));
    assert.deepEqual(reordered.flatMap((row) => row.left ? [row.left] : []), left);
    assert.deepEqual(reordered.flatMap((row) => row.right ? [row.right] : []), [...left].reverse());
    const duplicate = [{ from: 'x', to: 'y' }, { from: 'x', to: 'z' }];
    assert.deepEqual(prepareMappingRows(prepareMapping(duplicate), prepareMapping(duplicate)).map((r) => r.left), duplicate);
});

test('mapping detection preserves empty, nested, dictionary and unfamiliar structured values', () => {
    assert.deepEqual(prepareMapping([], 'params.renamings'), { entries: [], ordered: true });
    assert.equal(prepareMapping([]), undefined);
    assert.equal(prepareMapping([{ from: 'a', to: 'b', extra: true }]), undefined);
    assert.equal(prepareMapping([{ from: 'a' }]), undefined);
    assert.equal(prepareMapping(null, 'mapping'), undefined);
    assert.deepEqual(prepareMapping({ from: '', to: false }).entries, [{ from: '', to: false }]);
    const a = prepareMapping({ False: { value: 'control' }, True: 'campaign' }, 'mapping');
    const b = prepareMapping({ True: 'campaign', False: { value: 'updated' } }, 'mapping');
    assert.deepEqual(prepareMappingRows(a, b).map((row) => row.left.from), ['False', 'True']);
    assert.equal(prepareMappingRows(a, b)[0].right.to.value, 'updated');
    assert.deepEqual(prepareMappingRows(), []);
});

test('Visual If rules describe the example without exposing its stored JSON structure', () => {
    const { before } = structuredClone(require('./fixtures/prepare_if_rule.json'));
    const original = structuredClone(before);
    const model = prepareRecipe(before).steps[0];
    const field = model.fields.find((item) => item.key === 'params.visualIfDesc');
    const lines = field.rule.lines.map((line) => line.label + ' ' + line.parts.map((part) => part.text).join(''));
    assert.deepEqual(lines, ['If (pages_visited > 7)', 'Then (test_visit_segment = high)', 'Else (test_visit_segment = standard)']);
    assert.equal(model.title, 'Visual If Rule');
    assert.equal(model.known, true);
    assert.deepEqual(before, original);
});

test('Visual If descriptions preserve grouped logic, branch/action order and assignment types', () => {
    const { before } = structuredClone(require('./fixtures/prepare_if_rule.json'));
    const rule = before.config.payload.steps[0].params.visualIfDesc;
    rule.ifThen.filter.uiData.conditions.push({ mode: '||', conditions: [
        { input: 'country', operator: '== [string]', string: 'FR' },
        { input: 'country', operator: 'empty string' }
    ] });
    rule.ifThen.actions.push({ outputColumnName: 'copy', operator: 'ASSIGN_COLUMN', column: 'country' });
    rule.elseIfThens = [{ filter: { uiData: { mode: '&&', conditions: [{ input: 'count', operator: '>= [column]', col: 'limit' }] } },
        actions: [{ outputColumnName: 'score', operator: 'ASSIGN_FORMULA', formula: 'val("count") * 2' }] }];
    const lines = prepareIfRule(rule).lines.map((line) => line.label + ' ' + line.parts.map((part) => part.text).join(''));
    assert.deepEqual(lines, [
        'If (pages_visited > 7 AND (country = FR OR country is empty))',
        'Then (test_visit_segment = high)', 'And (copy = country)',
        'Else if (count >= limit)', 'Then (score = formula: val("count") * 2)',
        'Else (test_visit_segment = standard)'
    ]);
    rule.elseActions = [];
    assert.equal(prepareIfRule(rule).lines.at(-1).parts[0].text, '(No action)');
});

test('unsupported and incomplete Visual If forms retain the structured fallback', () => {
    assert.equal(prepareIfRule(null), undefined);
    for (const mutate of [
        (r) => { r.ifThen.filter.uiData.conditions[0].operator = 'future operator'; },
        (r) => { r.ifThen.actions[0].operator = 'future assignment'; },
        (r) => { delete r.ifThen.filter.uiData.conditions[0].num; },
        (r) => { r.ifThen.filter.enabled = false; },
        (r) => { r.elseIfThens = {}; }
    ]) {
        const { before } = structuredClone(require('./fixtures/prepare_if_rule.json'));
        const raw = before.config.payload.steps[0].params.visualIfDesc;
        mutate(raw);
        const field = prepareRecipe(before).steps[0].fields.find((f) => f.key === 'params.visualIfDesc');
        assert.equal(field.rule, undefined);
        assert.deepEqual(field.value, raw);
    }
});
