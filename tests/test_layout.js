"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const ELK = require("../resource/vendor/elk.bundled.js");
const FlowLayout = require("../resource/flow-layout.js");

const item = (id, zoneId, name = id, kind = "dataset") => ({ id, name, kind, zoneId });
const link = (source, target) => ({ source, target });
const zone = (id) => ({ id, name: `Zone ${id}`, color: "#27a9df", isDefault: id === "default" });
const compute = (graph) => FlowLayout.layout(graph, new ELK());
const box = (node) => ({ x: node.x - node.width / 2, y: node.y - 36, width: node.width, height: node.height });
const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

function assertComplete(graph, layout) {
    assert.deepEqual(layout.nodes.map((node) => node.id).sort(), graph.nodes.map((node) => node.id).sort());
    assert.deepEqual(layout.edges.map((edge) => [edge.source, edge.target]).sort(), graph.edges.map((edge) => [edge.source, edge.target]).sort());
    const appearances = [...layout.nodes, ...layout.references];
    for (const node of appearances) {
        assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
        const owner = layout.zones.find((zone) => zone.id === node.zoneId);
        if (owner) {
            const bounds = box(node);
            assert.ok(bounds.x >= owner.x && bounds.x + bounds.width <= owner.x + owner.width, node.id + " horizontal containment");
            assert.ok(bounds.y >= owner.y + 28 && bounds.y + bounds.height <= owner.y + owner.height, node.id + " label/header containment");
        }
    }
    for (let i = 0; i < appearances.length; i++) for (let j = i + 1; j < appearances.length; j++) {
        assert.equal(overlap(box(appearances[i]), box(appearances[j])), false, "item/label bounds overlap");
    }
    for (let i = 0; i < layout.zones.length; i++) for (let j = i + 1; j < layout.zones.length; j++) {
        assert.equal(overlap(layout.zones[i], layout.zones[j]), false, "zone panels overlap");
    }
    for (const edge of layout.edges) {
        assert.ok(edge.paths.length);
        for (const path of edge.paths) for (const point of path) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        const from = layout.references.find((node) => node.appearanceId === edge.sourceAppearanceId) || layout.nodes.find((node) => node.id === edge.source);
        const to = layout.nodes.find((node) => node.id === edge.target);
        assert.equal(edge.paths[0][0].y, from.y);
        assert.equal(edge.paths.at(-1).at(-1).y, to.y);
    }
    const pairs = new Set();
    for (const edge of layout.zoneLinks) {
        const key = JSON.stringify([edge.sourceZoneId, edge.targetZoneId]);
        assert.equal(pairs.has(key), false, 'duplicate zone-pair connector');
        pairs.add(key);
        const from = layout.zones.find((zone) => zone.id === edge.sourceZoneId);
        const to = layout.zones.find((zone) => zone.id === edge.targetZoneId);
        const start = edge.paths[0][0];
        const end = edge.paths.at(-1).at(-1);
        assert.equal(start.x, from.x + from.width, 'connector must start on the source zone border');
        assert.equal(end.x, to.x, 'connector must end on the receiving zone border');
        assert.ok(start.y >= from.y && start.y <= from.y + from.height);
        assert.ok(end.y >= to.y && end.y <= to.y + to.height);
    }
}

test("ELK positions cycles, self-links, downstream nodes and disconnected pipelines", async () => {
    const graph = { nodes: ["a", "b", "c", "downstream", "isolated", "source", "sink"].map((id) => item(id)),
        edges: [link("a", "b"), link("b", "c"), link("c", "a"), link("b", "b"), link("c", "downstream"), link("source", "sink")] };
    const result = await compute(graph);
    assertComplete(graph, result);
    assert.ok(new Set(result.nodes.map((node) => node.x)).size > 2, "cycle must not collapse into a single column");
});

test("compound layout preserves intra-zone and cross-zone routes with label space", async () => {
    const graph = { hasZones: true, zones: [zone("default"), zone("prepare"), zone("train"), zone("score"), zone("empty")],
        nodes: [item("input", "default"), item("prep", "prepare", "a_very_long_recipe_name_that_wraps_onto_three_lines", "recipe"), item("clean", "prepare"),
            item("train", "train", "Training", "ml-recipe"), item("model", "train", "Revenue model", "model"),
            item("score", "score", "Score", "ml-recipe"), item("out", "score")],
        edges: [link("input", "prep"), link("prep", "clean"), link("clean", "train"), link("train", "model"), link("model", "score"), link("clean", "score"), link("score", "out")] };
    const result = await compute(graph);
    assertComplete(graph, result);
    assert.equal(result.zones.length, 5);
    const byId = new Map(result.nodes.map((node) => [node.id, node]));
    for (const edge of result.edges) {
        // Sections are relative to edge.container, even when stored at the root.
        const source = result.references.find((node) => node.appearanceId === edge.sourceAppearanceId) || byId.get(edge.source);
        assert.equal(edge.paths[0][1].y, source.y, "source port must align after container translation");
        assert.equal(edge.paths.at(-1).at(-2).y, byId.get(edge.target).y, "target port must align after container translation");
    }
});

test("ELK handles cycles crossing zone boundaries without losing dependencies", async () => {
    const graph = { hasZones: true, zones: [zone("one"), zone("two"), zone("three")],
        nodes: [item("a", "one"), item("b", "two"), item("c", "three"), item("out", "three")],
        edges: [link("a", "b"), link("b", "c"), link("c", "a"), link("c", "out")] };
    assertComplete(graph, await compute(graph));
});

test("sorted inputs and a fixed seed produce the same layout after reordering", async () => {
    const graph = { hasZones: true, zones: [zone("a"), zone("b")],
        nodes: [item("a1", "a"), item("a2", "a"), item("b1", "b"), item("b2", "b")],
        edges: [link("a1", "b1"), link("a2", "b1"), link("b1", "b2")] };
    const reversed = { ...graph, zones: [...graph.zones].reverse(), nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    assert.equal(FlowLayout.signature(graph), FlowLayout.signature(reversed));
    assert.deepEqual(await compute(graph), await compute(reversed));
});

test("cache keys include zone membership, node kind, and changed label dimensions", () => {
    const graph = { hasZones: true, zones: [zone("a"), zone("b")], nodes: [item("one", "a")], edges: [] };
    const base = FlowLayout.signature(graph);
    assert.notEqual(base, FlowLayout.signature({ ...graph, nodes: [item("one", "b")] }));
    assert.notEqual(base, FlowLayout.signature({ ...graph, nodes: [item("one", "a", "one", "model")] }));
    assert.notEqual(base, FlowLayout.signature({ ...graph, nodes: [item("one", "a", "Long_label_".repeat(8))] }));
});

test("empty flows and explicit empty zones have finite bounds", async () => {
    const empty = await compute({ nodes: [], edges: [] });
    assert.ok(empty.bounds.width > 0 && empty.bounds.height > 0);
    const graph = { hasZones: true, nodes: [], edges: [], zones: [zone("empty")] };
    const grouped = await compute(graph);
    assert.equal(grouped.zones.length, 1);
    assert.ok(grouped.zones[0].width >= 220 && grouped.zones[0].height >= 130);
});

test("a larger multi-zone graph keeps every item and dependency", async () => {
    const nodes = [], edges = [], zones = [];
    for (let group = 0; group < 8; group++) {
        const id = "zone" + group;
        zones.push(zone(id));
        for (let i = 0; i < 12; i++) {
            const key = `${id}-${i}`;
            nodes.push(item(key, id));
            if (i) edges.push(link(`${id}-${i - 1}`, key));
        }
        if (group) edges.push(link(`zone${group - 1}-11`, `${id}-0`));
    }
    const graph = { nodes, edges, zones, hasZones: true };
    assertComplete(graph, await compute(graph));
});

test("an external attachments-metadata input appears locally before its recipe", async () => {
    const graph = {
        hasZones: true, zones: [zone("attachments"), { ...zone("images"), references: [
            { nodeId: "attachments-metadata", ownerZoneId: "attachments", appearanceId: '["images","attachments-metadata"]' }
        ] }],
        nodes: [item("attachments-metadata", "attachments"), item("compute_images-metadata", "images", "compute_images-metadata", "recipe"), item("documents-metadata", "images")],
        edges: [link("attachments-metadata", "compute_images-metadata"), link("compute_images-metadata", "documents-metadata")]
    };
    const original = JSON.stringify(graph);
    const result = await compute(graph);
    assertComplete(graph, result);
    assert.equal(JSON.stringify(graph), original);
    const source = result.nodes.find((node) => node.id === "attachments-metadata");
    const reference = result.references[0];
    const recipe = result.nodes.find((node) => node.id === "compute_images-metadata");
    assert.equal(result.references.length, 1);
    assert.equal(source.zoneId, "attachments");
    assert.equal(reference.zoneId, "images");
    assert.equal(reference.ownerZoneId, "attachments");
    assert.equal(reference.nodeId, source.id);
    assert.equal(reference.isReference, true);
    assert.ok(reference.x < recipe.x);
    const dependency = result.edges.find((edge) => edge.source === source.id);
    assert.equal(dependency.sourceAppearanceId, reference.appearanceId);
    assert.equal(dependency.paths[0][0].x, reference.x + 30);
    assert.equal(result.zoneLinks.length, 1);
    assert.equal(result.zoneLinks[0].sourceZoneId, 'attachments');
    assert.equal(result.zoneLinks[0].targetZoneId, 'images');
});

test("references deduplicate by receiving zone and include explicit unused pre-shares", async () => {
    const graph = { hasZones: true, zones: [zone("owner"),
        { ...zone("one"), sharedNodeIds: ["input", "input", "unused"], references: [{ nodeId: "input" }, { nodeId: "missing" }] }, zone("two")],
        nodes: [item("input", "owner"), item("unused", "owner"), item("r1", "one", "Recipe 1", "recipe"), item("r2", "one", "Recipe 2", "recipe"), item("r3", "two", "Recipe 3", "recipe")],
        edges: [link("input", "r1"), link("input", "r2"), link("input", "r3")] };
    const result = await compute(graph);
    assertComplete(graph, result);
    assert.equal(result.references.length, 3);
    assert.equal(result.zoneLinks.length, 2);
    assert.equal(result.nodes.length, 5);
    const sameZone = result.edges.filter((edge) => edge.target === "r1" || edge.target === "r2");
    assert.equal(sameZone[0].sourceAppearanceId, sameZone[1].sourceAppearanceId);
    assert.notEqual(sameZone[0].sourceAppearanceId, result.edges.find((edge) => edge.target === "r3").sourceAppearanceId);
    assert.deepEqual(result.zoneLinks.find((edge) => edge.targetZoneId === 'one').nodeIds, ['input', 'unused']);
});

test("cache keys change when pre-shares change; same-zone shares create no duplicate", async () => {
    const base = { hasZones: true, zones: [zone("one"), zone("two")], nodes: [item("input", "one")], edges: [] };
    const shared = { ...base, zones: [zone("one"), { ...zone("two"), sharedNodeIds: ["input"] }] };
    assert.notEqual(FlowLayout.signature(base), FlowLayout.signature(shared));
    const sameZone = { ...base, zones: [{ ...zone("one"), sharedNodeIds: ["input"] }, zone("two")] };
    assert.equal((await compute(sameZone)).references.length, 0);
});

test("multiple external items compress to one connector per directed zone pair", async () => {
    const graph = {
        hasZones: true, zones: [zone('source'), zone('destination')],
        nodes: [item('input1', 'source'), item('input2', 'source'), item('r1', 'destination', 'r1', 'recipe'), item('r2', 'destination', 'r2', 'recipe')],
        edges: [link('input1', 'r1'), link('input2', 'r1'), link('input2', 'r2')]
    };
    const result = await compute(graph);
    assertComplete(graph, result);
    assert.equal(result.references.length, 2);
    assert.equal(result.zoneLinks.length, 1);
    assert.deepEqual(result.zoneLinks[0].nodeIds, ['input1', 'input2']);
    assert.equal(result.edges.length, 3);
    assert.ok(result.edges.every((edge) => edge.sourceAppearanceId));
});
