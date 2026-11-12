"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const FlowLayout = require("../resource/flow-layout.js");
const FlowComparison = require("../resource/flow-comparison.js");

// UI state tests use a fast layout double; test_layout.js runs the real ELK engine.
function layoutDouble(input) {
    const ports = new Map();
    function position(parent, offsetX = 0, offsetY = 0) {
        (parent.children || []).forEach((child, index) => {
            child.x = 30 + index * 240;
            child.y = 40;
            position(child, offsetX + child.x, offsetY + child.y);
            (child.ports || []).forEach((port) => ports.set(port.id, {
                x: offsetX + child.x + (port.x ?? (port.layoutOptions['elk.port.side'] === 'EAST' ? child.width : 0)),
                y: offsetY + child.y + (port.y ?? child.height / 2)
            }));
        });
        parent.width = parent.width || Math.max(300, (parent.children || []).length * 240 + 60);
        parent.height = parent.height || 300;
    }
    position(input);
    input.edges.forEach((edge) => { edge.sections = [{ startPoint: ports.get(edge.sources[0]), endPoint: ports.get(edge.targets[0]) }]; });
    return input;
}

// Minimal DOM controls keep these state-transition tests dependency-free.
class Element {
    constructor(text = "", value = "") {
        this.textContent = text;
        this.value = value;
        this.children = [];
        this.listeners = {};
        this.disabled = false;
        this.hidden = false;
        this.open = false;
        this.attributes = {};
        this.clientWidth = 1200;
        this.clientHeight = 600;
        this.classList = { remove() {}, toggle() {}, add() {} };
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ""; }
    append(...children) { this.children.push(...children); }
    add(child) { this.children.push(child); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    setPointerCapture(id) { this.pointerId = id; }
    hasPointerCapture(id) { return this.pointerId === id; }
    releasePointerCapture() { this.pointerId = null; }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    scrollIntoView() { this.scrolledIntoView = true; }
    fire(name, event = {}) { this.listeners[name]({ preventDefault() {}, ...event }); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const source = readFileSync(join(__dirname, "../webapps/webapp/app.js"), "utf8");

async function setup(branchHandler, flowHandler = async () => ({ nodes: [], edges: [] }), bounds, layoutHandler, preparationHandler, cleanupHandler, comparisonHandler, commitHandler, registryHandler) {
    const elements = new Map();
    const get = (id) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    let mode = "same-project";
    const radios = [new Element(), new Element()];
    const calls = [];
    let requestedSelection;
    runInNewContext(source, {
        document: {
            readyState: "complete", getElementById: get,
            querySelector: () => ({ value: mode }), querySelectorAll: () => radios,
            createElement: () => new Element(), createElementNS: () => {
                const element = new Element();
                if (bounds) element.getBBox = () => bounds;
                return element;
            }, dispatchEvent() {}
        },
        window: { location: { href: "http://preview/" } },
        Option: Element, URL, CustomEvent: class {},
        FlowLayout, FlowComparison, ELK: class { layout(input) { return layoutHandler ? layoutHandler(input) : Promise.resolve(layoutDouble(input)); } },
        requestAnimationFrame: (callback) => setImmediate(callback),
        setTimeout: (callback) => setImmediate(callback),
        encodeURIComponent,
        getWebAppBackendUrl: (path) => "/" + path,
        fetch: async (url, options) => {
            assert.equal(options.credentials, "include");
            calls.push(url);
            let result;
            if (url.pathname === "/projects") result = {
                projects: [{ key: "PARENT", name: "Parent" }, { key: "BRANCH", name: "Branch" }, { key: "OTHER", name: "Unrelated" }],
                currentProjectKey: "PARENT"
            };
            else if (url.pathname === "/branches") result = await branchHandler(url.searchParams.get("projectKey"));
            else if (url.pathname === "/prepare-comparison") {
                assert.equal(options.method, "POST");
                assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
                requestedSelection = JSON.parse(options.body);
                result = { jobId: 'job123', state: 'preparing' };
            }
            else if (url.pathname === '/cleanup-projects') {
                assert.equal(options.method, 'POST');
                assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
                assert.deepEqual(JSON.parse(options.body), { confirmed: true });
                result = { jobId: 'cleanup123', state: 'preparing' };
            }
            else if (url.pathname === '/preparation/cleanup123') {
                result = cleanupHandler ? await cleanupHandler() : { state: 'ready', result: {
                    deletedProjects: ['SNAP_PARENT'], alreadyMissingProjects: [], removedRecords: 1, failures: []
                }};
            }
            else if (url.pathname === "/preparation/job123") {
                const artifacts = Object.fromEntries(['baseline', 'target'].map((side) => [side, {
                    sourceProjectKey: requestedSelection[side].projectKey,
                    projectKey: 'SNAP_' + requestedSelection[side].projectKey,
                    commitId: requestedSelection[side].commitId, branchName: 'vfd_snapshot', archived: true, reused: false
                }]));
                result = preparationHandler ? await preparationHandler(artifacts) : { state: 'ready', artifacts };
            }
            else if (url.pathname === "/comparison") {
                const graph = await flowHandler(url.searchParams.get('baselineProjectKey'));
                if (graph.error || graph.rawResponse) result = graph;
                else {
                    const model = { objects: Object.fromEntries(graph.nodes.map((node) => [node.id, node])), zones: {} };
                    result = comparisonHandler ? comparisonHandler(graph) : { graph, counts: { added: 0, deleted: 0, modified: 0, unchanged: graph.nodes.length },
                        baseline: { model }, target: { model } };
                }
            }
            else if (url.pathname === '/registry-membership') result = registryHandler ? await registryHandler(url) : { registeredCommitIds: [] };
            else result = commitHandler ? await commitHandler(url) : { commits: [{ id: "full-sha", message: "Commit", author: "Alex", timestamp: null }], nextCommit: null };
            if (result.rawResponse) return result.rawResponse;
            return { ok: result.state ? true : !result.error, json: async () => result };
        }
    });
    await tick();
    get("flow-screen").hidden = true;
    return {
        get, calls,
        mode(value) { mode = value; radios[0].fire("change"); },
        baseline(key) { get("base-project").value = key; get("base-project").fire("change"); }
    };
}

const child = { key: "BRANCH", name: "Branch", branch: "feature" };

test('cleanup requires explicit confirmation, reports results, and refreshes project choices', async () => {
    const ui = await setup(async () => ({ branches: [child] }));
    ui.get('cleanup-projects').fire('click');
    assert.equal(ui.get('cleanup-confirmation').hidden, false);
    assert.equal(ui.calls.some((url) => url.pathname === '/cleanup-projects'), false);
    ui.get('cancel-cleanup').fire('click');
    assert.equal(ui.get('cleanup-confirmation').hidden, true);
    ui.get('cleanup-projects').fire('click');
    ui.get('confirm-cleanup').fire('click');
    assert.equal(ui.get('cleanup-projects').disabled, true);
    await tick();
    assert.match(ui.get('cleanup-status').textContent, /1 projects deleted.*1 registry entries removed/);
    assert.equal(ui.get('cleanup-projects').disabled, false);
    assert.equal(ui.calls.filter((url) => url.pathname === '/projects').length, 2);
});

test('cleanup displays retained records and errors safely for retry', async () => {
    const ui = await setup(async () => ({ branches: [child] }), undefined, undefined, undefined, undefined,
        () => ({ state: 'ready', result: { deletedProjects: [], alreadyMissingProjects: ['OLD'], removedRecords: 1,
            failures: [{ projectKey: '<project>', message: 'Permission denied' }] }}));
    ui.get('confirm-cleanup').fire('click');
    await tick();
    assert.match(ui.get('cleanup-status').textContent, /1 already absent.*1 entries retained/);
    assert.equal(ui.get('cleanup-failures').hidden, false);
    assert.equal(ui.get('cleanup-failures').children[0].textContent, '<project>: Permission denied');
});

test('cleanup failure reenables controls and does not refresh choices', async () => {
    const ui = await setup(async () => ({ branches: [child] }), undefined, undefined, undefined, undefined,
        () => ({ state: 'failed', error: 'A comparison is still preparing.' }));
    ui.get('confirm-cleanup').fire('click');
    await tick();
    assert.equal(ui.get('cleanup-status').textContent, 'A comparison is still preparing.');
    assert.equal(ui.get('cleanup-projects').disabled, false);
    assert.equal(ui.calls.filter((url) => url.pathname === '/projects').length, 1);
});

test("branch mode restricts options, clears old commits, and reloads for a new baseline", async () => {
    const ui = await setup(async (key) => ({ branches: key === "PARENT" ? [child] : [], incomplete: false }));
    assert.equal(ui.calls.filter((url) => url.pathname === "/branches").length, 0);
    ui.mode("cross-project");
    assert.equal(ui.get("target-project").disabled, true);
    assert.equal(ui.get("target-commits").children.length, 0);
    await tick();
    assert.deepEqual(ui.get("target-project").children.map((option) => option.value), ["", "BRANCH"]);
    assert.equal(ui.get("target-project").disabled, false);
    ui.get("target-project").value = "BRANCH";
    ui.get("target-project").fire("change");
    await tick();
    ui.get("base-commits").children[0].children[0].fire("change");
    ui.get("target-commits").children[0].children[0].fire("change");
    assert.equal(ui.get("confirm-selection").disabled, false);
    ui.baseline("OTHER");
    assert.equal(ui.get("confirm-selection").disabled, true);
    assert.equal(ui.get("target-commits").children.length, 0);
    await tick();
    assert.equal(ui.get("target-project").disabled, true);
    assert.match(ui.get("same-project-note").textContent, /No accessible branch/);
});

async function confirmBranch(ui) {
    ui.mode("cross-project");
    await tick();
    ui.get("target-project").value = "BRANCH";
    ui.get("target-project").fire("change");
    await tick();
    ui.get("base-commits").children[0].children[0].fire("change");
    ui.get("target-commits").children[0].children[0].fire("change");
    ui.get("comparison-form").fire("submit");
    await tick();
}

test("confirmation loads the baseline Flow with all shapes, then restores selection", async () => {
    const graph = {
        nodes: ["dataset", "recipe", "ml-recipe", "model"].map((kind, i) => ({ id: String(i), name: kind, kind })),
        edges: [{ source: "0", target: "1" }, { source: "1", target: "2" }, { source: "2", target: "3" }]
    };
    const ui = await setup(async () => ({ branches: [child] }), async (key) => {
        assert.equal(key, "SNAP_PARENT");
        return graph;
    });
    await confirmBranch(ui);
    assert.equal(ui.get("flow-screen").hidden, false);
    assert.equal(ui.get("comparison-form").hidden, true);
    assert.match(ui.get("flow-status").textContent, /4 items · 3 connections/);
    const groups = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node");
    assert.deepEqual(groups.map((node) => node.children[1].attributes.class), ["node-shape dataset", "node-shape recipe", "node-shape ml-recipe", "node-shape model"]);
    ui.get("back-to-selection").fire("click");
    assert.equal(ui.get("comparison-form").hidden, false);
    assert.equal(ui.get("target-project").value, "BRANCH");
    assert.equal(ui.get("confirm-selection").disabled, false);
    for (const side of ['base', 'target']) {
        assert.equal(ui.get(`${side}-commits`).children[0].children[1].children
            .find((element) => element.className === 'commit-registry-badge').textContent, 'In registry');
    }
});

test("dataset icons resolve storage aliases and show actionable filenames on image failure", async () => {
    const graph = { nodes: [
        { id: "s3", name: "Source", kind: "dataset", config: { type: "S3" } },
        { id: "custom", name: "Custom", kind: "dataset", config: { type: "CustomConnector" }, diffStatus: "modified" },
        { id: "unknown", name: "Unknown", kind: "dataset" }
    ], edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const groups = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node");
    for (const [id, filename] of [["s3", "amazon-s3.svg"], ["custom", "custom-connector.svg"], ["unknown", "unknown.svg"]]) {
        const group = groups.find((node) => node.attributes["data-node-id"] === id);
        const shape = group.children.find((child) => child.attributes.class === "node-shape dataset");
        const icon = shape.children[2];
        assert.equal(icon.attributes.href, `../../resource/icons/${filename}`);
        const marker = group.children.find((child) => child.attributes.class === "missing-dataset-icon");
        assert.equal(marker.attributes.visibility, "hidden");
        icon.fire("error");
        assert.equal(marker.attributes.visibility, "visible");
        assert.equal(icon.attributes.visibility, "hidden");
        assert.ok(marker.children.some((child) => child.textContent.includes(filename)));
        icon.fire("load");
        assert.equal(marker.attributes.visibility, "hidden");
        assert.equal(icon.attributes.visibility, "visible");
    }
});

test("recipe icons cover visual, code, ML, implicit and missing recipe types", async () => {
    const cases = [
        ["shaker", "prepare.svg"], ["grouping", "group.svg"], ["vstack", "stack.svg"],
        ["python", "python.png"], ["spark_sql", "spark-sql.png"], ["sparkr", "rspark.png"],
        ["prediction_training", "train.svg"], ["prediction_scoring", "score.svg"],
        ["clustering_scoring", "cluster.svg"], ["standalone_evaluation", "standalone-evaluation.svg"],
        ["custom_recipe", "custom-recipe.svg"],
        ["CustomCode_custom-code-clean-mail-body", "custom-code-custom-code-clean-mail-body.svg"]
    ];
    const nodes = cases.map(([type], index) => ({ id: String(index), name: type,
        kind: type.startsWith("prediction") || type.startsWith("clustering") ? "ml-recipe" : "recipe",
        subType: "stale", config: { definition: { type } } }));
    nodes.push({ id: "implicit", name: "Training", kind: "ml-recipe", type: "RUNNABLE_IMPLICIT_RECIPE" });
    nodes.push({ id: "raw", name: "Prepare", kind: "recipe", subType: "shaker" });
    const ui = await setup(async () => ({ branches: [child] }), async () => ({ nodes, edges: [] }));
    await confirmBranch(ui);
    const groups = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node");
    const expected = [...cases.map(([, filename], index) => [String(index), filename]), ["implicit", "train.svg"], ["raw", "prepare.svg"]];
    for (const [id, filename] of expected) {
        const group = groups.find((node) => node.attributes["data-node-id"] === id);
        const shape = group.children[1];
        const icon = shape.children[2];
        assert.equal(icon.attributes.href, `../../resource/icons/${filename}`);
        const pluginRecipe = /^custom(?:code)?[_-]/i.test(cases[Number(id)]?.[0] || "");
        if (!pluginRecipe) assert.ok(readFileSync(join(__dirname, "../resource/icons", filename)).length);
        const marker = group.children.find((node) => node.attributes.class === "missing-recipe-icon");
        icon.fire("error");
        assert.equal(marker.attributes.visibility, pluginRecipe ? "hidden" : "visible");
        assert.equal(shape.children[1].attributes.visibility, pluginRecipe ? "hidden" : "visible");
        assert.equal(icon.attributes.visibility, "hidden");
        assert.equal(shape.children[0].attributes.class, pluginRecipe ? "recipe-icon-frame plugin-recipe-fallback" : "recipe-icon-frame");
        assert.ok(marker.children.some((line) => line.textContent.includes(filename)));
        icon.fire("load");
        assert.equal(marker.attributes.visibility, "hidden");
        assert.equal(icon.attributes.visibility, "visible");
        assert.equal(shape.children[0].attributes.class, "recipe-icon-frame");
    }
});

test("Flow waits for preparation and uses the archived baseline instead of its source", async () => {
    let finish;
    const ui = await setup(async () => ({ branches: [child] }), async (key) => {
        assert.equal(key, 'SNAP_PARENT');
        return navigationGraph;
    }, undefined, undefined, (artifacts) => new Promise((resolve) => {
        finish = () => resolve({ state: 'ready', artifacts });
    }));
    await confirmBranch(ui);
    assert.equal(ui.calls.some((url) => url.pathname === '/comparison'), false);
    assert.match(ui.get('flow-status').textContent, /Preparing/);
    finish();
    await tick();
    assert.equal(ui.calls.filter((url) => url.pathname === '/comparison').length, 1);
    assert.match(ui.get('flow-project').textContent, /Parent \(PARENT\)/);
    assert.equal(ui.get('comparison-coverage').hidden, true);
    assert.equal(ui.get('comparison-coverage-issues').children.length, 0);
    assert.equal(ui.get('comparison-coverage').open, false);
    assert.match(ui.get('flow-preparation').textContent, /SNAP_BRANCH/);
});

test("partial preparation failure preserves successful artifacts and retry can reuse them", async () => {
    let attempts = 0;
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph,
        undefined, undefined, (artifacts) => {
            if (++attempts === 1) return { state: 'failed', error: 'Target: permission denied', artifacts: { baseline: artifacts.baseline } };
            artifacts.baseline.reused = true;
            return { state: 'ready', artifacts };
        });
    await confirmBranch(ui);
    assert.equal(ui.calls.some((url) => url.pathname === '/comparison'), false);
    assert.match(ui.get('flow-status').textContent, /Target: permission denied/);
    assert.match(ui.get('flow-preparation').textContent, /SNAP_PARENT/);
    assert.equal(ui.get('retry-flow').hidden, false);
    ui.get('retry-flow').fire('click');
    await tick();
    assert.match(ui.get('flow-preparation').textContent, /\(reused\)/);
    assert.doesNotMatch(ui.get('flow-preparation').textContent, /archived/i);
    assert.equal(ui.calls.filter((url) => url.pathname === '/comparison').length, 1);
});

test("leaving preparation ignores its late result without requesting the Flow", async () => {
    let finish;
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph,
        undefined, undefined, (artifacts) => new Promise((resolve) => {
            finish = () => resolve({ state: 'ready', artifacts });
        }));
    await confirmBranch(ui);
    ui.get('back-to-selection').fire('click');
    finish();
    await tick();
    assert.equal(ui.calls.some((url) => url.pathname === '/comparison'), false);
    assert.equal(ui.get('flow-screen').hidden, true);
    assert.equal(ui.get('confirm-selection').disabled, false);
});

test("a ready response without both archived artifacts cannot open the Flow", async () => {
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph,
        undefined, undefined, (artifacts) => {
            artifacts.target.archived = false;
            return { state: 'ready', artifacts };
        });
    await confirmBranch(ui);
    assert.equal(ui.calls.some((url) => url.pathname === '/comparison'), false);
    assert.match(ui.get('flow-status').textContent, /Both comparison projects must be ready/);
});

function flowContent(ui) {
    return ui.get("flow-graph").children.find((element) => element.attributes.id === "flow-content");
}

async function camera(ui) {
    await tick();
    return flowContent(ui).attributes.transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g).map(Number);
}

const navigationGraph = {
    nodes: [{ id: "a", name: "Dataset", kind: "dataset" }, { id: "b", name: "Recipe", kind: "recipe" }],
    edges: [{ source: "a", target: "b" }]
};

test('diff Flow shows change statuses, both projects, and object JSON on click', async () => {
    const graph = { nodes: ['deleted', 'modified', 'added', 'unchanged'].map((status, index) => ({
        id: String(index), name: status + ' dataset', kind: 'dataset', diffStatus: status
    })), edges: [{ source: '0', target: '1', diffStatus: 'deleted' }, { source: '1', target: '2', diffStatus: 'added' }] };
    const before = { objects: { '0': { name: '<deleted>', config: { value: 1 } }, '1': { name: 'modified dataset', config: { value: 1 } } }, zones: {} };
    const after = { objects: { '1': { name: 'modified dataset', config: { value: 2 } }, '2': { name: 'added dataset' } }, zones: {} };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph, undefined, undefined, undefined, undefined,
        () => ({ graph, baseline: { model: before }, target: { model: after }, counts: { deleted: 1, modified: 1, added: 1, unchanged: 1 } }));
    await confirmBranch(ui);
    assert.match(ui.get('comparison-summary').textContent, /1 deleted · 1 modified · 1 added · 1 unchanged/);
    const groups = flowContent(ui).children.filter((node) => node.attributes.class === 'flow-node');
    assert.deepEqual(groups.map((node) => node.attributes['data-diff-status']), ['deleted', 'modified', 'added', 'unchanged']);
    assert.equal(ui.get('json-comparison').hidden, false);
    for (const index of [0, 2, 3]) {
        assert.equal(groups[index].attributes.tabindex, -1);
        assert.equal(groups[index].listeners.click, undefined);
        assert.equal(groups[index].listeners.keydown, undefined);
    }
    assert.equal(groups[1].attributes.tabindex, 0);
    groups[1].fire('click');
    assert.equal(ui.get('object-inspector').open, true);
    assert.equal(ui.get('json-comparison').open, false);
    assert.equal(ui.get('inspector-object-name').textContent, 'modified dataset · dataset');
    assert.equal(ui.get('inspector-change-status').textContent, 'Modified');
    assert.equal(ui.get('diff-object').value, '1');
    ui.get('object-inspector').close();
    groups[1].fire('keydown', { key: 'Enter' });
    assert.equal(ui.get('object-inspector').open, true);
    ui.get('object-inspector').close();
    groups[1].fire('keydown', { key: ' ' });
    assert.equal(ui.get('object-inspector').open, true);
    assert.ok(ui.get('json-diff-rows').children.some((row) => row.attributes['data-diff-status'] === 'modified'));
    assert.match(ui.get('json-target-title').textContent, /BRANCH/);
    assert.equal(ui.calls.find((url) => url.pathname === '/comparison').searchParams.get('targetProjectKey'), 'SNAP_BRANCH');
});

test('overlay closes and reopens independently of the foldable full Flow JSON', async () => {
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph);
    await confirmBranch(ui);
    ui.get('json-comparison').open = true;
    ui.get('json-comparison').fire('toggle');
    const fullFlowRows = ui.get('flow-json-rows').children;
    assert.ok(fullFlowRows.length > 2);
    assert.equal(ui.get('object-inspector').open, false);
    ui.get('diff-object').value = 'a';
    ui.get('diff-object').fire('change');
    assert.equal(ui.get('object-inspector').open, true);
    assert.equal(ui.get('json-comparison').open, true);
    assert.equal(ui.get('flow-json-rows').children, fullFlowRows);
    ui.get('close-inspector').fire('click');
    assert.equal(ui.get('object-inspector').open, false);
    ui.get('open-inspector').fire('click');
    assert.equal(ui.get('object-inspector').open, true);
    ui.get('close-inspector-footer').fire('click');
    assert.equal(ui.get('object-inspector').open, false);
    ui.get('open-inspector').fire('click');
    const dialog = ui.get('object-inspector');
    dialog.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 });
    dialog.fire('click', { target: dialog, clientX: 50, clientY: 50 });
    assert.equal(dialog.open, true); // clicking inside the dialog is not a backdrop click
    dialog.fire('click', { target: dialog, clientX: 0, clientY: 0 });
    assert.equal(dialog.open, false);
    ui.get('open-inspector').fire('click');
    ui.get('back-to-selection').fire('click');
    assert.equal(dialog.open, false);
});

test('code recipes open source tab, allow JSON switching, and handle absent sides and non-code selections', async () => {
    const graph = { nodes: ['modified', 'added', 'deleted', 'unchanged'].map((status) => ({
        id: status, name: status, kind: status === 'unchanged' ? 'dataset' : 'recipe', diffStatus: status
    })), edges: [] };
    const recipe = (payload) => ({ kind: 'recipe', config: { definition: { type: 'python' }, payload } });
    const ui = await setup(async () => ({ branches: [child] }), async () => graph, undefined, undefined, undefined, undefined,
        () => ({ graph, baseline: { model: { objects: { modified: recipe('def run():\n    return 1'), deleted: recipe('old') } } },
            target: { model: { objects: { modified: recipe('def run():\n    return 2'), added: recipe('') } } },
            counts: { deleted: 1, modified: 1, added: 1, unchanged: 1 } }));
    await confirmBranch(ui);
    const inspect = (id) => {
        ui.get('diff-object').value = id;
        ui.get('diff-object').fire('change');
    };
    inspect('modified');
    assert.equal(ui.get('recipe-code-tab').hidden, false);
    assert.equal(ui.get('recipe-code-tab').attributes['aria-selected'], 'true');
    assert.equal(ui.get('json-diff-panel').hidden, true);
    const rows = ui.get('recipe-code-rows').children;
    assert.equal(rows[1].children[0].children[1].textContent, '    return 1');
    assert.equal(rows[1].children[1].children[1].textContent, '    return 2');
    ui.get('json-diff-tab').fire('click');
    assert.equal(ui.get('recipe-code-panel').hidden, true);
    assert.ok(ui.get('json-diff-rows').children.length > 2);
    ui.get('json-diff-tab').fire('keydown', { key: 'ArrowRight' });
    assert.equal(ui.get('recipe-code-panel').hidden, false);
    for (const status of ['added', 'deleted']) {
        inspect(status);
        assert.ok(ui.get('recipe-code-rows').children.every((row) => row.attributes['data-diff-status'] === status));
    }
    inspect('unchanged');
    assert.equal(ui.get('recipe-code-tab').hidden, true);
    assert.equal(ui.get('json-diff-panel').hidden, false);
    ui.get('diff-object').value = '';
    ui.get('diff-object').fire('change');
    assert.equal(ui.get('recipe-code-tab').hidden, true);
});

test('Split inspector opens visually, highlights meaningful fields, and keeps JSON and keyboard navigation', async () => {
    const { before, after } = require('./split_fixture.js')();
    const htmlName = '<img src=x onerror=alert(1)>';
    after.config.definition.outputs.main.items[0].ref = htmlName;
    after.config.payload.rangeSplits[0].filter.uiData.conditions[0].operator = '> [number]';
    const unsupported = JSON.parse(JSON.stringify(after));
    unsupported.config.payload.mode = 'RANDOM';
    const graph = { nodes: ['modified', 'added', 'deleted', 'unsupported', 'missing', 'dataset'].map((id) => ({
        id, name: id, kind: id === 'dataset' ? 'dataset' : 'recipe', diffStatus: 'modified'
    })), edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph, undefined, undefined, undefined, undefined,
        () => ({ graph, baseline: { model: { objects: { modified: before, deleted: before } } },
            target: { model: { objects: { modified: after, added: after, unsupported,
                missing: { kind: 'recipe', subType: 'split' }, dataset: { kind: 'dataset' } } } },
            counts: { deleted: 1, modified: 1, added: 1, unchanged: 1 } }));
    await confirmBranch(ui);
    const inspect = (id) => {
        ui.get('diff-object').value = id;
        ui.get('diff-object').fire('change');
    };
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    const nodes = () => descendants(ui.get('visual-inspector-panel'));
    inspect('modified');
    assert.equal(ui.get('visual-inspector-tab').hidden, false);
    assert.equal(ui.get('visual-inspector-tab').attributes['aria-selected'], 'true');
    assert.equal(ui.get('recipe-code-tab').hidden, true);
    assert.equal(ui.get('json-diff-panel').hidden, true);
    const spans = nodes().filter((node) => ['split-removed', 'split-added'].includes(node.className));
    assert.ok(spans.some((node) => node.textContent === '10,000,000' && node.className === 'split-removed'));
    assert.ok(spans.some((node) => node.textContent === '2,000,000' && node.className === 'split-added'));
    assert.ok(spans.some((node) => node.textContent === '(' && node.className === 'split-added'));
    assert.ok(spans.some((node) => node.textContent === '[' && node.className === 'split-removed'));
    assert.ok(nodes().some((node) => node.attributes['aria-label'] === 'Exclusive from bound'));
    assert.ok(nodes().some((node) => node.textContent === 'Condition removed'));
    assert.ok(!spans.some((node) => node.textContent === 'plik-small-files'));
    assert.ok(nodes().some((node) => node.textContent === htmlName));
    assert.ok(nodes().every((node) => node.innerHTML === undefined));
    assert.ok(nodes().some((node) => node.textContent === 'archive_file_count'));
    assert.ok(nodes().some((node) => node.textContent === 'Full configuration and technical details'));
    assert.ok(!nodes().some((node) => /Show changes only|at a glance|Next change/.test(node.textContent)));
    ui.get('visual-inspector-tab').fire('keydown', { key: 'Home' });
    assert.equal(ui.get('json-diff-panel').hidden, false);
    assert.ok(ui.get('json-diff-rows').children.length > 2);
    ui.get('json-diff-tab').fire('keydown', { key: 'ArrowRight' });
    assert.equal(ui.get('visual-inspector-panel').hidden, false);
    for (const id of ['added', 'deleted']) {
        inspect(id);
        assert.ok(nodes().some((node) => node.textContent === 'No Split recipe in this version.'));
    }
    inspect('unsupported');
    assert.ok(nodes().some((node) => /supports range splits/.test(node.textContent)));
    inspect('missing');
    assert.ok(nodes().some((node) => /settings are unavailable/.test(node.textContent)));
    inspect('dataset');
    assert.equal(ui.get('visual-inspector-tab').hidden, true);
    assert.equal(ui.get('json-diff-panel').hidden, false);
    inspect('');
    assert.equal(ui.get('visual-inspector-tab').hidden, true);
});

test('Prepare inspector shows paired settings, removals, safe fallback, missing states and JSON navigation', async () => {
    const { before, after } = JSON.parse(JSON.stringify(require('./fixtures/prepare_recipe.json')));
    const unsafe = '<img src=x onerror=alert(1)>';
    before.config.payload.steps[1].comment = unsafe;
    const unknown = JSON.parse(JSON.stringify(after));
    unknown.config.payload.steps = [{ type: 'CustomProcessor', params: { nested: { value: unsafe } } }];
    const graph = { nodes: ['modified', 'added', 'deleted', 'unknown', 'missing', 'empty', 'dataset'].map((id) => ({
        id, name: id, kind: id === 'dataset' ? 'dataset' : 'recipe', subType: id === 'dataset' ? undefined : 'shaker', diffStatus: 'modified'
    })), edges: [] };
    const empty = { kind: 'recipe', subType: 'shaker', config: { payload: { steps: [] } } };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph, undefined, undefined, undefined, undefined,
        () => ({ graph, baseline: { model: { objects: { modified: before, deleted: before } } },
            target: { model: { objects: { modified: after, added: after, unknown, empty,
                missing: { kind: 'recipe', subType: 'shaker' }, dataset: { kind: 'dataset' } } } },
            counts: { deleted: 1, modified: 1, added: 1, unchanged: 0 } }));
    await confirmBranch(ui);
    const inspect = (id) => { ui.get('diff-object').value = id; ui.get('diff-object').fire('change'); };
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    const nodes = () => descendants(ui.get('visual-inspector-panel'));
    inspect('modified');
    assert.equal(ui.get('visual-inspector-tab').attributes['aria-selected'], 'true');
    assert.equal(ui.get('json-diff-panel').hidden, true);
    assert.match(ui.get('inspector-object-name').textContent, /Prepare/);
    assert.ok(nodes().some((node) => /1 modified.*1 removed/.test(node.textContent)));
    assert.ok(nodes().some((node) => node.attributes['aria-label'] === 'Previous Extract country code: false'));
    assert.ok(nodes().some((node) => node.attributes['aria-label'] === 'New Extract country code: true'));
    assert.ok(!nodes().some((node) => /^(Previous|New) IP Column:/.test(node.attributes['aria-label'] || '')));
    assert.ok(nodes().some((node) => node.textContent === 'val("pages_visited") > 7'));
    assert.ok(nodes().some((node) => node.textContent === '(empty)'));
    assert.ok(nodes().some((node) => node.textContent === 'Step removed. No corresponding step in this version.'));
    assert.ok(nodes().some((node) => node.textContent === unsafe));
    assert.ok(nodes().every((node) => node.innerHTML === undefined));
    assert.ok(nodes().filter((node) => node.className === 'prepare-step').every((node) => node.open));
    ui.get('visual-inspector-tab').fire('keydown', { key: 'Home' });
    assert.equal(ui.get('json-diff-panel').hidden, false);
    ui.get('json-diff-tab').fire('keydown', { key: 'ArrowRight' });
    assert.equal(ui.get('visual-inspector-panel').hidden, false);
    for (const id of ['added', 'deleted']) {
        inspect(id);
        assert.ok(nodes().some((node) => node.textContent === 'No Prepare recipe in this version.'));
    }
    inspect('unknown');
    assert.ok(nodes().some((node) => /shown as captured parameters/.test(node.textContent)));
    assert.ok(nodes().some((node) => node.textContent.includes(unsafe)));
    inspect('missing');
    assert.ok(nodes().some((node) => /settings are unavailable/.test(node.textContent)));
    inspect('empty');
    assert.ok(nodes().some((node) => /No preparation steps/.test(node.textContent)));
    inspect('dataset');
    assert.equal(ui.get('visual-inspector-tab').hidden, true);
    assert.equal(ui.get('json-diff-panel').hidden, false);
});

test('Prepare mappings render from/to rows with granular diffs, gaps and readable nested settings', async () => {
    const unsafe = '<img src=x onerror=alert(1)>';
    const before = { kind: 'recipe', subType: 'shaker', config: { payload: { steps: [
        { type: 'FindReplace', params: { mapping: [{ from: 'False', to: 'control' }, { from: 'True', to: 'campaign' }], columns: ['flag'] } },
        { type: 'ColumnRenamer', params: { renamings: [{ from: 'customer_id', to: 'test_customer_id' }] } },
        { type: 'Custom', params: { options: { nested: { safe: unsafe }, empty: [], missing: null }, rules: [{ from: 'a', to: 'b', extra: true }] } }
    ] } } };
    const after = JSON.parse(JSON.stringify(before));
    after.config.payload.steps[0].params.mapping = [{ from: '', to: 'unknown' }, { from: 'False', to: 'control' }, { from: 'True', to: 'treatment' }];
    after.config.payload.steps[1].params.renamings = [];
    const graph = { nodes: [{ id: 'recipe', name: 'recipe', kind: 'recipe', subType: 'shaker', diffStatus: 'modified' }], edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph, undefined, undefined, undefined, undefined,
        () => ({ graph, baseline: { model: { objects: { recipe: before } } }, target: { model: { objects: { recipe: after } } },
            counts: { modified: 1, added: 0, deleted: 0, unchanged: 0 } }));
    await confirmBranch(ui);
    ui.get('diff-object').value = 'recipe'; ui.get('diff-object').fire('change');
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    const nodes = descendants(ui.get('visual-inspector-panel'));
    assert.ok(nodes.some((node) => node.textContent === 'Replacements'));
    assert.ok(nodes.some((node) => node.textContent === 'Renamings'));
    assert.ok(nodes.some((node) => node.textContent === '→'));
    assert.equal(nodes.filter((node) => node.className === 'prepare-mapping-row').length, 6);
    assert.ok(nodes.some((node) => node.textContent === 'campaign' && node.className === 'split-removed'));
    assert.ok(nodes.some((node) => node.textContent === 'treatment' && node.className === 'split-added'));
    assert.ok(!nodes.some((node) => node.textContent === 'control' && /split-(added|removed)/.test(node.className || '')));
    assert.ok(nodes.some((node) => node.textContent === 'No corresponding mapping'));
    assert.ok(nodes.some((node) => node.textContent === 'No mappings'));
    assert.ok(nodes.some((node) => node.textContent === '(empty)'));
    assert.ok(nodes.some((node) => node.textContent === 'Added' && /prepare-mapping-status/.test(node.className || '')));
    assert.ok(nodes.some((node) => node.textContent === 'Removed' && /prepare-mapping-status/.test(node.className || '')));
    assert.ok(nodes.some((node) => node.textContent === unsafe));
    assert.ok(nodes.some((node) => node.textContent === 'extra'));
    assert.ok(nodes.some((node) => node.textContent === 'No items'));
    assert.ok(nodes.every((node) => node.innerHTML === undefined));
    assert.ok(!nodes.some((node) => /^\s*[\[{]/.test(node.textContent)));
});

test('Visual If uses descriptive prose with granular diffs and a structured fallback for unfamiliar rules', async () => {
    const { before, after } = JSON.parse(JSON.stringify(require('./fixtures/prepare_if_rule.json')));
    const unsafe = '<img src=x onerror=alert(1)>';
    before.config.payload.steps[0].params.visualIfDesc.elseActions[0].value = unsafe;
    after.config.payload.steps[0].params.visualIfDesc.elseActions[0].value = unsafe;
    const unsupported = JSON.parse(JSON.stringify(after));
    unsupported.config.payload.steps[0].params.visualIfDesc.ifThen.actions[0].operator = 'future assignment';
    const graph = { nodes: ['rule', 'unsupported'].map((id) => ({ id, name: id, kind: 'recipe', subType: 'shaker', diffStatus: 'modified' })), edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph, undefined, undefined, undefined, undefined,
        () => ({ graph, baseline: { model: { objects: { rule: before } } }, target: { model: { objects: { rule: after, unsupported } } },
            counts: { modified: 1, added: 1, deleted: 0, unchanged: 0 } }));
    await confirmBranch(ui);
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    const inspect = (id) => { ui.get('diff-object').value = id; ui.get('diff-object').fire('change'); return descendants(ui.get('visual-inspector-panel')); };
    const nodes = inspect('rule');
    assert.equal(nodes.filter((node) => node.className === 'prepare-if-rule').length, 2);
    assert.ok(nodes.some((node) => node.textContent === 'If '));
    assert.ok(nodes.some((node) => node.textContent === 'Then '));
    assert.ok(nodes.some((node) => node.textContent === 'Else '));
    assert.ok(nodes.some((node) => node.textContent === '7' && /split-removed/.test(node.className || '')));
    assert.ok(nodes.some((node) => node.textContent === '10' && /split-added/.test(node.className || '')));
    assert.ok(!nodes.some((node) => node.textContent === 'pages_visited' && /split-(added|removed)/.test(node.className || '')));
    assert.ok(nodes.some((node) => node.textContent === unsafe));
    assert.ok(nodes.every((node) => node.innerHTML === undefined));
    assert.ok(!nodes.some((node) => node.textContent === 'ifThen'));
    const fallback = inspect('unsupported');
    assert.ok(fallback.some((node) => /require the captured structure/.test(node.textContent)));
    assert.ok(fallback.some((node) => node.textContent === 'future assignment'));
});

test("wheel zoom preserves the graph coordinate under the pointer", async () => {
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph);
    await confirmBranch(ui);
    const before = await camera(ui);
    let prevented = false;
    ui.get("flow-viewport").fire("wheel", { deltaY: -100, deltaMode: 0, clientX: 240, clientY: 160, preventDefault() { prevented = true; } });
    const after = await camera(ui);
    assert.equal(prevented, true);
    assert.ok(after[2] > before[2]);
    assert.ok(Math.abs((240 - before[0]) / before[2] - (240 - after[0]) / after[2]) < 1e-8);
    assert.ok(Math.abs((160 - before[1]) / before[2] - (160 - after[1]) / after[2]) < 1e-8);
});

test("Refresh Flow reloads the selected comparison and icons and refits the camera", async () => {
    let requests = 0;
    const ui = await setup(async () => ({ branches: [child] }), async () => {
        requests++;
        return navigationGraph;
    });
    await confirmBranch(ui);
    const fitted = await camera(ui);
    ui.get("flow-zoom-in").fire("click");
    const before = await camera(ui);
    assert.notDeepEqual(before, fitted);
    ui.get("refresh-flow").fire("click");
    assert.equal(ui.get("refresh-flow").disabled, true);
    ui.get("refresh-flow").fire("click");
    await tick();
    assert.equal(requests, 2);
    assert.equal(ui.get("flow-screen").hidden, false);
    assert.equal(ui.get("comparison-form").hidden, true);
    assert.equal(ui.get("refresh-flow").disabled, false);
    assert.deepEqual(await camera(ui), fitted);
    const node = flowContent(ui).children.find((child) => child.attributes.class === "flow-node");
    assert.match(node.children[1].children[2].attributes.href, /\?v=\d+$/);
});

test("model icons resolve model types and missing generic models report their expected SVG", async () => {
    const cases = [[undefined, "saved-model.svg"], ["MLflow", "model-mlflow.svg"],
        ["DEEP_LEARNING", "saved-model-deep-learning.svg"], ["timeseries", "saved-model-timeseries.svg"]];
    const graph = { nodes: cases.map(([type], index) => ({ id: String(index), name: "Model", kind: "model",
        diffStatus: "modified", config: type ? { modelType: type } : {} })), edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const groups = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node");
    cases.forEach(([, filename], index) => {
        const group = groups.find((node) => node.attributes["data-node-id"] === String(index));
        const shape = group.children[1];
        assert.equal(shape.children[0].attributes.class, "model-icon-frame");
        const icon = shape.children[2];
        assert.equal(icon.attributes.href, `../../resource/icons/${filename}`);
        const marker = group.children.find((node) => node.attributes.class === "missing-model-icon");
        const chip = group.children.find((node) => node.attributes.class === "diff-chip");
        const closePosition = chip.attributes.transform;
        assert.equal(closePosition, "translate(-38,62)");
        icon.fire("error");
        assert.equal(marker.attributes.visibility, "visible");
        assert.ok(marker.children.some((line) => line.textContent.includes("Expected resource/icons/" + filename)));
        assert.notEqual(chip.attributes.transform, closePosition);
        icon.fire("load");
        assert.equal(marker.attributes.visibility, "hidden");
        assert.equal(chip.attributes.transform, closePosition);
    });
});

test("saved model agent metadata selects the pink agent icon instead of the trained model icon", async () => {
    const graph = { nodes: [
        { id: "agent", name: "Evidence Dossier Builder", kind: "model", type: "COMPUTABLE_SAVED_MODEL",
            config: { savedModelType: "STRUCTURED_AGENT", inlineVersions: [{ versionId: "v1" }] } },
        { id: "trained", name: "Trained model", kind: "model", type: "COMPUTABLE_SAVED_MODEL",
            config: { savedModelType: "PREDICTION" } }
    ], edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const groups = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node");
    const agent = groups.find((node) => node.attributes["data-node-id"] === "agent");
    const trained = groups.find((node) => node.attributes["data-node-id"] === "trained");
    assert.equal(agent.children[1].children[2].attributes.href, "../../resource/icons/ai-agent-visual.svg");
    assert.match(agent.attributes["aria-label"], /, agent,/);
    assert.equal(trained.children[1].children[2].attributes.href, "../../resource/icons/saved-model.svg");
    assert.ok(readFileSync(join(__dirname, "../resource/icons/ai-agent-visual.svg")).length);
});

test("knowledge banks use their Flow type for icons when settings have no type", async () => {
    const graph = { nodes: [{ id: "kb", name: "embedded-attachments", kind: "dataset",
        type: "COMPUTABLE_RETRIEVABLE_KNOWLEDGE", config: { vectorStoreType: "CHROMA" } },
        { id: "search", name: "Search logs", kind: "agent-tool", type: "AGENT_TOOL",
            config: { type: "VectorStoreSearch" } }], edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const groups = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node");
    assert.equal(groups[0].children[1].children[2].attributes.href, "../../resource/icons/computable-retrievable-knowledge.svg");
    assert.equal(groups[1].children[1].children[2].attributes.href, "../../resource/icons/agent-tool-knowledge-bank.svg");
});

test("agent tools render as inspectable first-level objects with change badges", async () => {
    const tool = { id: "tool", name: "Lookup", kind: "agent-tool", type: "AGENT_TOOL",
        diffStatus: "modified", config: { type: "PYTHON", params: { code: "return 2" } } };
    const graph = { nodes: [tool], edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const group = flowContent(ui).children.find((node) => node.attributes["data-node-id"] === "tool");
    assert.equal(group.children[1].children[2].attributes.href, "../../resource/icons/agent-tool-puzzle-piece.svg");
    assert.equal(group.attributes["data-diff-status"], "modified");
    assert.match(group.attributes["aria-label"], /agent tool/);
    assert.ok(group.listeners.click);
});

test("dataset and recipe stickers move down only while missing-icon details are visible", async () => {
    const graph = { nodes: ["dataset", "recipe"].map((kind, index) => ({ id: String(index),
        name: "a_long_name_that_wraps_to_two_lines", kind, diffStatus: "deleted" })), edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const groups = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node");
    groups.forEach((group) => {
        const chip = group.children.find((node) => node.attributes.class === "diff-chip");
        const icon = group.children[1].children[2];
        assert.equal(chip.attributes.transform, "translate(-38,78)");
        icon.fire("error");
        assert.equal(chip.attributes.transform, "translate(-38,111)");
        icon.fire("load");
        assert.equal(chip.attributes.transform, "translate(-38,78)");
    });
});

test("drag pans the camera without moving nodes and stops on pointer cancellation", async () => {
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph);
    await confirmBranch(ui);
    const before = await camera(ui);
    const positions = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node").map((node) => node.attributes.transform);
    const viewport = ui.get("flow-viewport");
    viewport.fire("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    assert.equal(viewport.hasPointerCapture(1), false);
    viewport.fire("pointermove", { pointerId: 1, clientX: 170, clientY: 130 });
    assert.equal(viewport.hasPointerCapture(1), true);
    const after = await camera(ui);
    assert.deepEqual(after, [before[0] + 70, before[1] + 30, before[2]]);
    assert.deepEqual(flowContent(ui).children.filter((node) => node.attributes.class === "flow-node").map((node) => node.attributes.transform), positions);
    viewport.fire("pointercancel", { pointerId: 1 });
    assert.equal(viewport.hasPointerCapture(1), false);
    viewport.fire("pointermove", { pointerId: 1, clientX: 400, clientY: 400 });
    assert.deepEqual(await camera(ui), after);
});

test("node clicks survive pointer gestures while dragging does not inspect", async () => {
    const graph = { ...navigationGraph, nodes: navigationGraph.nodes.map((node) => ({ ...node, diffStatus: 'modified' })) };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const viewport = ui.get("flow-viewport");
    const node = flowContent(ui).children.find((element) => element.attributes.class === "flow-node");
    const before = await camera(ui);
    viewport.fire("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    viewport.fire("pointermove", { pointerId: 1, clientX: 101, clientY: 101 });
    assert.equal(viewport.hasPointerCapture(1), false);
    assert.deepEqual(await camera(ui), before);
    viewport.fire("pointerup", { pointerId: 1 });
    node.fire("click");
    assert.equal(ui.get("diff-object").value, "a");
    assert.equal(ui.get("object-inspector").open, true);

    ui.get("object-inspector").close();
    viewport.fire("pointerdown", { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    viewport.fire("pointermove", { pointerId: 2, clientX: 120, clientY: 100 });
    viewport.fire("pointerup", { pointerId: 2 });
    node.fire("click");
    assert.equal(ui.get("object-inspector").open, false);

    viewport.fire("pointerdown", { button: 0, pointerId: 3, clientX: 120, clientY: 100 });
    viewport.fire("pointerup", { pointerId: 3 });
    node.fire("click");
    assert.equal(ui.get("object-inspector").open, true);
});

test("loading automatically fits measured labels and padding like the Fit button", async () => {
    const bounds = { x: -40, y: -20, width: 4000, height: 1500 };
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph, bounds);
    await confirmBranch(ui);
    const [x, y, scale] = await camera(ui);
    assert.ok(scale < 0.85);
    assert.ok(x + bounds.x * scale >= 32 - 1e-8);
    assert.ok(y + bounds.y * scale >= 32 - 1e-8);
    assert.ok(x + (bounds.x + bounds.width) * scale <= 1200 - 32 + 1e-8);
    assert.ok(y + (bounds.y + bounds.height) * scale <= 600 - 32 + 1e-8);
    ui.get("flow-fit").fire("click");
    assert.deepEqual(await camera(ui), [x, y, scale]);
});

test("redraws refit the camera and preserve node positions despite reordered data or renamed labels", async () => {
    let redraw = false;
    const ui = await setup(async () => ({ branches: [child] }), async () => redraw ? { nodes: [...navigationGraph.nodes].reverse().map((node) => ({ ...node, name: "Renamed " + node.name })), edges: [...navigationGraph.edges].reverse() } : navigationGraph);
    await confirmBranch(ui);
    const fitted = await camera(ui);
    ui.get("flow-zoom-in").fire("click");
    const before = await camera(ui);
    assert.notDeepEqual(before, fitted);
    const positions = flowContent(ui).children.filter((node) => node.attributes.class === "flow-node").map((node) => node.attributes.transform);
    ui.get("back-to-selection").fire("click");
    redraw = true;
    ui.get("comparison-form").fire("submit");
    await tick();
    assert.deepEqual(await camera(ui), fitted);
    assert.deepEqual(flowContent(ui).children.filter((node) => node.attributes.class === "flow-node").map((node) => node.attributes.transform), positions);
});

test("Flow failures offer retry and empty Flow is explicit", async () => {
    let attempts = 0;
    const ui = await setup(async () => ({ branches: [child] }), async () => ++attempts === 1 ? { error: "Flow unavailable" } : { nodes: [], edges: [] });
    await confirmBranch(ui);
    assert.equal(ui.get("retry-flow").hidden, false);
    ui.get("retry-flow").fire("click");
    await tick();
    assert.match(ui.get("flow-status").textContent, /empty Flow/);
    assert.equal(ui.get("retry-flow").hidden, true);
});

test("late Flow responses are ignored after returning to selection", async () => {
    let resolve;
    const ui = await setup(async () => ({ branches: [child] }), () => new Promise((done) => { resolve = done; }));
    await confirmBranch(ui);
    ui.get("back-to-selection").fire("click");
    resolve({ nodes: [], edges: [] });
    await tick();
    assert.equal(ui.get("flow-screen").hidden, true);
    assert.equal(ui.get("comparison-form").hidden, false);
    assert.equal(ui.get("flow-graph").children.length, 0);
});

test("cycles and disconnected Flow nodes render without blocking", async () => {
    const graph = { nodes: ["a", "b", "isolated"].map((id) => ({ id, name: id, kind: "dataset" })), edges: [{ source: "a", target: "b" }, { source: "b", target: "a" }] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    assert.match(ui.get("flow-status").textContent, /3 items · 2 connections/);
    assert.equal(ui.get("retry-flow").hidden, true);
});

test("ELK failures offer retry and never silently use the old layout", async () => {
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph, null,
        async () => { throw new Error("ELK could not arrange the Flow"); });
    await confirmBranch(ui);
    assert.match(ui.get("flow-status").textContent, /ELK could not arrange/);
    assert.equal(ui.get("retry-flow").hidden, false);
    assert.equal(ui.get("flow-graph").children.length, 0);
});

test("late ELK results cannot reopen the Flow after returning to selection", async () => {
    let resolve;
    let pending;
    const ui = await setup(async () => ({ branches: [child] }), async () => navigationGraph, null,
        (input) => { pending = input; return new Promise((done) => { resolve = done; }); });
    await confirmBranch(ui);
    assert.match(ui.get("flow-status").textContent, /Arranging/);
    ui.get("back-to-selection").fire("click");
    resolve(layoutDouble(pending));
    await tick();
    assert.equal(ui.get("flow-screen").hidden, true);
    assert.equal(ui.get("flow-graph").children.length, 0);
});

test("zone layout renders every canonical item once within its zone panel", async () => {
    const graph = { ...navigationGraph, hasZones: true,
        nodes: navigationGraph.nodes.map((node) => ({ ...node, zoneId: "prepare" })),
        zones: [{ id: "prepare", name: "Prepare", color: "#27a9df", nodeIds: ["a", "b"] }] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const children = flowContent(ui).children;
    assert.equal(children.filter((element) => element.attributes.class === "flow-zone").length, 1);
    assert.equal(children.filter((element) => element.attributes.class === "flow-node").length, 2);
    assert.match(ui.get("flow-status").textContent, /1 zones/);
});

test("shared inputs render dimmed inside the receiving zone, retaining original identity", async () => {
    const graph = { ...navigationGraph, hasZones: true,
        nodes: [{ id: "a", name: "attachments-metadata", kind: "dataset", zoneId: "owner" },
            { id: "b", name: "compute_images-metadata", kind: "recipe", zoneId: "images" }],
        zones: [{ id: "owner", name: "Attachments", color: "#27a9df" }, { id: "images", name: "Images", color: "#8e24aa" }] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph);
    await confirmBranch(ui);
    const elements = flowContent(ui).children;
    const originals = elements.filter((node) => node.attributes.class === "flow-node");
    const references = elements.filter((node) => node.attributes.class === "flow-node is-reference");
    assert.equal(originals.length, 2);
    assert.equal(references.length, 1);
    assert.equal(references[0].attributes['data-node-id'], 'a');
    assert.equal(references[0].attributes['data-zone-id'], 'images');
    assert.equal(originals.find((node) => node.attributes['data-node-id'] === 'a').attributes['data-zone-id'], 'owner');
    assert.match(references[0].attributes['aria-label'], /attachments-metadata.*shared input from Attachments/);
    const zoneLinks = elements.filter((node) => node.attributes.class === "flow-zone-link");
    assert.equal(zoneLinks.length, 1);
    assert.equal(zoneLinks[0].attributes['data-source-zone'], 'owner');
    assert.equal(zoneLinks[0].attributes['data-target-zone'], 'images');
    assert.equal(zoneLinks[0].attributes['marker-end'], undefined);
    assert.ok(elements.indexOf(zoneLinks[0]) < elements.findIndex((node) => node.attributes.class === 'flow-zone'));
    assert.equal(elements.filter((node) => node.attributes.class === "flow-edge flow-reference-link").length, 0);
    assert.equal(elements.filter((node) => node.attributes.class === "flow-edge").length, 1);
    assert.match(ui.get("flow-status").textContent, /2 items · 1 connections/);
});

test("non-JSON authentication and proxy errors retain actionable diagnostics", async () => {
    for (const [status, message] of [[401, /authenticate/], [502, /HTTP 502/]]) {
        const ui = await setup(async () => ({ branches: [child] }), async () => ({ rawResponse: {
            ok: false, status, json: async () => { throw new SyntaxError("HTML error page"); }
        } }));
        await confirmBranch(ui);
        assert.match(ui.get("flow-status").textContent, message);
        assert.equal(ui.get("retry-flow").hidden, false);
    }
});

test("switching back to one project restores baseline and ignores late branches", async () => {
    let resolve;
    const ui = await setup(() => new Promise((done) => { resolve = done; }));
    ui.mode("cross-project");
    ui.mode("same-project");
    resolve({ branches: [child], incomplete: false });
    await tick();
    assert.equal(ui.get("target-project").value, "PARENT");
    assert.equal(ui.get("target-project").disabled, true);
    assert.match(ui.get("same-project-note").textContent, /Uses the same project/);
});

test("late branch responses cannot replace the new baseline's branches", async () => {
    let resolve;
    const ui = await setup((key) => key === "PARENT" ? new Promise((done) => { resolve = done; }) : Promise.resolve({ branches: [], incomplete: false }));
    ui.mode("cross-project");
    ui.baseline("OTHER");
    await tick();
    resolve({ branches: [child], incomplete: false });
    await tick();
    assert.deepEqual(ui.get("target-project").children.map((option) => option.value), [""]);
    assert.equal(ui.get("target-project").disabled, true);
});

test("branch lookup failures expose retry and recover without unrelated options", async () => {
    let attempts = 0;
    const ui = await setup(async () => ++attempts === 1 ? { error: "Branch lookup failed" } : { branches: [child], incomplete: false });
    ui.mode("cross-project");
    await tick();
    assert.equal(ui.get("retry-branches").hidden, false);
    assert.equal(ui.get("target-project").disabled, true);
    ui.get("retry-branches").fire("click");
    await tick();
    assert.equal(ui.get("retry-branches").hidden, true);
    assert.deepEqual(ui.get("target-project").children.map((option) => option.value), ["", "BRANCH"]);
});

test("partial branch discovery shows verified results with a retry notice", async () => {
    const ui = await setup(async () => ({ branches: [child], incomplete: true }));
    ui.mode("cross-project");
    await tick();
    assert.equal(ui.get("retry-branches").hidden, false);
    assert.match(ui.get("same-project-note").textContent, /verified branches only/);
    assert.deepEqual(ui.get("target-project").children.map((option) => option.value), ["", "BRANCH"]);
});

test("branch mode waits for a baseline before making a lookup", async () => {
    const ui = await setup(async () => ({ branches: [], incomplete: false }));
    ui.baseline("");
    ui.mode("cross-project");
    await tick();
    assert.equal(ui.calls.filter((url) => url.pathname === "/branches").length, 0);
    assert.equal(ui.get("target-project").disabled, true);
    assert.match(ui.get("same-project-note").textContent, /Select a baseline project/);
});

test('commit picker marks registered revisions on both sides and preserves markers when searching', async () => {
    const ui = await setup(async () => ({ branches: [child] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async () => ({ commits: [
            { id: 'registered', message: 'Prepared revision', author: 'Alex' },
            { id: 'new', message: 'New revision', author: 'Alex' },
            { id: 'unknown', message: 'Unknown revision', author: 'Alex' }
        ], nextCommit: null }), async () => ({ registeredCommitIds: ['registered'] }));
    for (const side of ['base', 'target']) {
        const list = ui.get(`${side}-commits`);
        const badges = (row) => row.children[1].children.filter((element) => element.className === 'commit-registry-badge');
        assert.equal(badges(list.children[0])[0].textContent, 'In registry');
        assert.equal(badges(list.children[1]).length, 0);
        assert.equal(badges(list.children[2]).length, 0);
        ui.get(`${side}-search`).value = 'Prepared';
        ui.get(`${side}-search`).fire('input');
        assert.equal(list.children.length, 1);
        assert.equal(badges(list.children[0])[0].textContent, 'In registry');
    }
});

test('slow registry lookups do not block selection and identical lists share a request', async () => {
    let resolveMembership;
    const pending = new Promise((resolve) => { resolveMembership = resolve; });
    const ui = await setup(async () => ({ branches: [] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async () => ({ commits: [
            { id: 'first', message: 'First', author: 'Alex' },
            { id: 'second', message: 'Second', author: 'Alex' }
        ], nextCommit: null }), async () => pending);
    for (const side of ['base', 'target']) {
        assert.equal(ui.get(`${side}-commits`).children.length, 2);
        assert.equal(ui.get(`${side}-commits`).attributes['aria-busy'], 'false');
        assert.equal(ui.get(`${side}-search`).disabled, false);
    }
    assert.equal(ui.get('confirm-selection').disabled, false);
    assert.equal(ui.calls.filter((url) => url.pathname === '/registry-membership').length, 1);
    ui.get('base-search').value = 'First';
    ui.get('base-search').fire('input');
    resolveMembership({ registeredCommitIds: ['first'] });
    await tick();
    assert.equal(ui.get('base-commits').children.length, 1);
    assert.equal(ui.get('base-commits').children[0].children[1].children[2].textContent, 'In registry');
});

test('late registry responses cannot modify a newly selected project', async () => {
    let resolveMembership;
    const pending = new Promise((resolve) => { resolveMembership = resolve; });
    const ui = await setup(async () => ({ branches: [] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async () => ({ commits: [{ id: 'same-sha', message: 'Revision', author: 'Alex' }], nextCommit: null }),
        async (url) => url.searchParams.get('projectKey') === 'PARENT' ? pending : { registeredCommitIds: [] });
    ui.baseline('OTHER');
    await tick();
    resolveMembership({ registeredCommitIds: ['same-sha'] });
    await tick();
    for (const side of ['base', 'target']) {
        assert.equal(ui.get(`${side}-commits`).children[0].children[1].children
            .filter((element) => element.className === 'commit-registry-badge').length, 0);
    }
});

test('registry lookup warnings keep commit selection available', async () => {
    const ui = await setup(async () => ({ branches: [] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async () => ({ commits: [
            { id: 'first', message: 'First', author: 'Alex', inRegistry: null },
            { id: 'second', message: 'Second', author: 'Alex', inRegistry: null }
        ], nextCommit: null }), async () => { throw new Error('Registry unavailable'); });
    assert.match(ui.get('base-status').textContent, /Registry status unavailable/);
    assert.equal(ui.get('confirm-selection').disabled, false);
});

test('commit picker skips setup commits, selects newest valid commit, and displays searchable tags', async () => {
    const ui = await setup(async () => ({ branches: [child] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async (url) => ({ commits: url.searchParams.get('startCommit') ? [
            { id: 'older', message: 'Older commit', author: 'Alex', tags: [] }
        ] : [
            { id: 'setup', message: 'Initialize gitignore\nSetup', author: 'Alex' },
            { id: 'latest', message: 'Latest commit', author: 'Alex', tags: ['v1', '<release>'] },
            { id: 'previous', message: 'Previous commit', author: 'Alex' }
        ], nextCommit: url.searchParams.get('startCommit') ? null : 'older' }));
    const list = ui.get('base-commits');
    assert.deepEqual(list.children.map((row) => row.children[0].value), ['latest', 'previous']);
    assert.equal(list.children[0].children[0].checked, true);
    assert.equal(list.children[0].children[1].children[2].textContent, 'Tags: v1, <release>');
    list.children[1].children[0].fire('change');
    ui.get('base-more').fire('click');
    await tick();
    assert.equal(list.children[1].children[0].checked, true);
    ui.get('base-search').value = '<release>';
    ui.get('base-search').fire('input');
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0].children[0].value, 'latest');
    ui.baseline('OTHER');
    await tick();
    assert.equal(list.children[0].children[0].checked, true);
});

test('commit picker continues past setup-only pages to find a default', async () => {
    const ui = await setup(async () => ({ branches: [] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async (url) => url.searchParams.get('startCommit') ? {
            commits: [{ id: 'valid', message: 'Project created', author: 'Alex' }], nextCommit: null
        } : { commits: [{ id: 'setup', message: 'Initialize gitignore', author: 'Alex' }], nextCommit: 'next' });
    await tick();
    assert.equal(ui.get('base-commits').children[0].children[0].value, 'valid');
    assert.equal(ui.get('base-commits').children[0].children[0].checked, true);
});

test('shared tagged-only toggle filters both sides and keeps selections eligible', async () => {
    const ui = await setup(async () => ({ branches: [child] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async (url) => ({ commits: [
            { id: 'latest', message: 'Latest', author: 'Alex' },
            { id: 'tagged', message: 'Release', author: 'Alex', tags: ['v1'] }
        ], nextCommit: null }));
    const toggle = ui.get('tagged-commits-only');
    toggle.checked = true;
    toggle.fire('change');
    for (const side of ['base', 'target']) {
        const list = ui.get(`${side}-commits`);
        assert.equal(list.children.length, 1);
        assert.equal(list.children[0].children[0].value, 'tagged');
        assert.equal(list.children[0].children[0].checked, true);
        assert.equal(list.children[0].children[1].children[2].className, 'commit-meta commit-tags');
    }
    ui.baseline('OTHER');
    await tick();
    assert.equal(ui.get('base-commits').children[0].children[0].value, 'tagged');
    assert.equal(ui.get('base-commits').children[0].children[0].checked, true);
    toggle.checked = false;
    toggle.fire('change');
    assert.equal(ui.get('base-commits').children.length, 2);
    assert.equal(ui.get('base-commits').children[1].children[0].checked, true);
});

test('tagged-only filter clears untagged selections when no tags are loaded', async () => {
    const ui = await setup(async () => ({ branches: [child] }));
    ui.mode('cross-project');
    await tick();
    ui.get('target-project').value = 'BRANCH';
    ui.get('target-project').fire('change');
    await tick();
    assert.equal(ui.get('confirm-selection').disabled, false);
    ui.get('tagged-commits-only').checked = true;
    ui.get('tagged-commits-only').fire('change');
    assert.equal(ui.get('base-commits').children.length, 0);
    assert.equal(ui.get('target-commits').children.length, 0);
    assert.equal(ui.get('confirm-selection').disabled, true);
    assert.match(ui.get('base-status').textContent, /No matching commits/);
    ui.get('tagged-commits-only').checked = false;
    ui.get('tagged-commits-only').fire('change');
    assert.equal(ui.get('confirm-selection').disabled, false);
});

test('bundle tags highlight only the bundle ID and preserve ordinary tag text', async () => {
    const ui = await setup(async () => ({ branches: [] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async () => ({ commits: [{ id: 'tagged', message: 'Release', author: 'Alex', tags: [
            '\u00a0dss-bundle-TSHIRTS_INC001_V1_0_0-v1-0-1-2026-10-28-10-18-41-807',
            'v1',
            'dss-bundle-PROJECT-<release>-candidate-2026-10-28-10-18-41-807',
            'dss-bundle-PROJECT-incomplete'
        ] }], nextCommit: null }));
    const tags = ui.get('base-commits').children[0].children[1].children[2];
    const first = tags.children[0];
    assert.equal(first.children[0].textContent, '\u00a0dss-bundle-TSHIRTS_INC001_V1_0_0-');
    assert.equal(first.children[1].className, 'commit-bundle-id');
    assert.equal(first.children[1].textContent, 'v1-0-1');
    assert.equal(first.children[2].textContent, '-2026-10-28-10-18-41-807');
    assert.equal(tags.children[2].textContent, 'v1');
    assert.equal(tags.children[4].children[1].textContent, '<release>-candidate');
    assert.equal(tags.children[6].textContent, 'dss-bundle-PROJECT-incomplete');
});

test('same-project comparison defaults to the second eligible commit and preserves manual choices', async () => {
    const ui = await setup(async () => ({ branches: [] }), undefined, undefined, undefined, undefined, undefined, undefined,
        async (url) => ({ commits: [
            { id: 'setup', message: 'Initialize gitignore', author: 'Alex' },
            { id: 'latest', message: 'Latest', author: 'Alex', tags: ['v2'] },
            { id: 'previous', message: 'Previous', author: 'Alex', tags: ['v1'] },
            { id: 'older', message: 'Older', author: 'Alex' }
        ], nextCommit: url.searchParams.get('startCommit') ? null : 'next' }));
    assert.equal(ui.get('base-commits').children[0].children[0].checked, true);
    const target = ui.get('target-commits');
    assert.equal(target.children[0].children[0].checked, false);
    assert.equal(target.children[1].children[0].checked, true);
    assert.equal(ui.get('confirm-selection').disabled, false);
    target.children[2].children[0].fire('change');
    ui.get('target-more').fire('click');
    await tick();
    assert.equal(target.children[2].children[0].checked, true);
    ui.get('tagged-commits-only').checked = true;
    ui.get('tagged-commits-only').fire('change');
    assert.equal(target.children[1].children[0].checked, true);
});

test('same-project comparison with only one commit leaves target unselected', async () => {
    const ui = await setup(async () => ({ branches: [] }));
    assert.equal(ui.get('base-commits').children[0].children[0].checked, true);
    assert.equal(ui.get('target-commits').children[0].children[0].checked, false);
    assert.equal(ui.get('confirm-selection').disabled, true);
});

test('Model training inspector reuses paired fields, checkboxes, granular highlights and JSON navigation', async () => {
    const { before, after } = structuredClone(require('./fixtures/training_recipe.json'));
    const unsafe = '<img src=x onerror=alert(1)>';
    after.config.payload.futureOption = unsafe;
    const graphOnly = { kind: 'ml-recipe', subType: 'prediction_training', coverage: 'graph-only', config: {} };
    const clustering = structuredClone(after);
    clustering.config.definition.type = 'clustering_training';
    const graph = { nodes: ['modified', 'added', 'deleted', 'missing', 'clustering', 'dataset'].map((id) => ({
        id, name: id, kind: id === 'dataset' ? 'dataset' : 'ml-recipe', diffStatus: 'modified'
    })), edges: [] };
    const ui = await setup(async () => ({ branches: [child] }), async () => graph, undefined, undefined, undefined, undefined,
        () => ({ graph, baseline: { model: { objects: { modified: before, deleted: before } } },
            target: { model: { objects: { modified: after, added: after, missing: graphOnly, clustering, dataset: { kind: 'dataset' } } } },
            counts: { modified: 1, added: 1, deleted: 1, unchanged: 0 } }));
    await confirmBranch(ui);
    const inspect = (id) => { ui.get('diff-object').value = id; ui.get('diff-object').fire('change'); };
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    const nodes = () => descendants(ui.get('visual-inspector-panel'));
    inspect('modified');
    assert.equal(ui.get('visual-inspector-tab').attributes['aria-selected'], 'true');
    assert.equal(ui.get('recipe-code-tab').hidden, true);
    assert.ok(nodes().some((node) => node.attributes['aria-label'] === 'Previous Algorithms / RANDOM FOREST REGRESSION / N Estimators: 100'));
    assert.ok(nodes().some((node) => node.attributes['aria-label'] === 'New Algorithms / RANDOM FOREST REGRESSION / N Estimators: 200'));
    assert.ok(!nodes().some((node) => /^(Previous|New) Target variable:/.test(node.attributes['aria-label'] || '')));
    assert.ok(nodes().some((node) => node.className === 'prepare-checkbox is-checked'));
    assert.ok(nodes().some((node) => node.textContent === unsafe));
    assert.ok(nodes().every((node) => node.innerHTML === undefined));
    assert.ok(nodes().some((node) => node.textContent === 'Not present in this section'));
    const sections = nodes().filter((node) => node.className === 'prepare-step');
    assert.ok(sections.some((node) => node.attributes['data-diff-status'] === 'modified' && node.open));
    assert.ok(sections.some((node) => node.attributes['data-diff-status'] === 'unchanged' && !node.open));
    ui.get('visual-inspector-tab').fire('keydown', { key: 'Home' });
    assert.equal(ui.get('json-diff-panel').hidden, false);
    assert.ok(ui.get('json-diff-rows').children.length > 2);
    ui.get('json-diff-tab').fire('keydown', { key: 'ArrowRight' });
    assert.equal(ui.get('visual-inspector-panel').hidden, false);
    for (const id of ['added', 'deleted']) {
        inspect(id);
        assert.ok(nodes().some((node) => node.textContent === 'No model training recipe in this version.'));
    }
    inspect('clustering');
    assert.equal(ui.get('visual-inspector-tab').hidden, false);
    inspect('missing');
    assert.ok(nodes().some((node) => /settings are unavailable/.test(node.textContent)));
    assert.ok(!nodes().some((node) => node.className === 'prepare-step'));
    inspect('dataset');
    assert.equal(ui.get('visual-inspector-tab').hidden, true);
});
