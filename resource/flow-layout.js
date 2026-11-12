/** ELK adapter shared by the DSS webapp and dependency-free Node tests. */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.FlowLayout = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const OPTIONS = {
        "elk.algorithm": "layered", "elk.direction": "RIGHT",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN", "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": "42", "elk.spacing.componentComponent": "70",
        "elk.layered.spacing.nodeNodeBetweenLayers": "65",
        "elk.layered.spacing.edgeNodeBetweenLayers": "24",
        "elk.layered.mergeHierarchyEdges": "false",
        "elk.randomSeed": "1",
        "elk.padding": "[top=24,left=24,bottom=24,right=24]"
    };
    const token = (kind, id) => JSON.stringify([kind, id]);
    const compare = (a, b) => a.id.localeCompare(b.id);
    const radius = (kind) => kind === "dataset" ? 30 : kind === "model" ? 36 : 29;

    /** Wrap the displayed name; the renderer keeps the full name in a tooltip. */
    function labelLines(name) {
        const lines = String(name).match(/.{1,23}/gu) || [""];
        return lines.slice(0, 3).map((line, index) => index === 2 && lines.length > 3 ? line + "…" : line);
    }

    /** Reserve space for the shape and all displayed label lines. */
    function dimensions(node, measure) {
        const lines = labelLines(node.name);
        return { width: Math.max(176, ...lines.map((line) => Math.ceil(measure(line)) + 16)),
            height: 108 + (lines.length - 1) * 16 + (['dataset', 'recipe', 'ml-recipe', 'model', 'agent-tool'].includes(node.kind) ? 64 : 0) + (node.diffStatus && node.diffStatus !== 'unchanged' ? 26 : 0) };
    }

    /** Build owned items and zone-local input appearances without changing graph data. */
    function model(graph, measure = (text) => text.length * 8) {
        const nodes = [...graph.nodes].sort(compare).map((node) => ({ ...node, ...dimensions(node, measure) }));
        const ids = new Set(nodes.map((node) => node.id));
        if (ids.size !== nodes.length) throw new Error("The Flow contains duplicate node IDs.");
        const edges = [...graph.edges].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
        if (edges.some((edge) => !ids.has(edge.source) || !ids.has(edge.target))) throw new Error("A Flow connection refers to a missing item.");
        const grouped = Boolean(graph.hasZones);
        const zones = grouped ? [...(graph.zones || [])].map((zone) => ({ ...zone })) : [];
        if (grouped && nodes.some((node) => !zones.some((zone) => zone.id === node.zoneId))) {
            if (!zones.some((zone) => zone.id === "default")) zones.push({ id: "default", name: "Default", color: "#D1D8DA", isDefault: true });
            nodes.forEach((node) => { if (!zones.some((zone) => zone.id === node.zoneId)) node.zoneId = "default"; });
        }
        const visibleZones = zones.filter((zone) => !zone.isDefault || nodes.some((node) => node.zoneId === zone.id)).sort(compare);
        visibleZones.forEach((zone) => { zone.minWidth = Math.max(220, Math.ceil(measure(zone.name) * 1.2) + 40); });
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const references = new Map();
        function reference(zoneId, nodeId) {
            const node = byId.get(nodeId);
            if (!grouped || !node || node.zoneId === zoneId || !zones.some((zone) => zone.id === zoneId)) return null;
            const appearanceId = JSON.stringify([zoneId, nodeId]);
            if (!references.has(appearanceId)) references.set(appearanceId, {
                ...node, nodeId, zoneId, ownerZoneId: node.zoneId, appearanceId, isReference: true
            });
            return references.get(appearanceId);
        }
        zones.forEach((zone) => {
            (zone.references || []).forEach((entry) => reference(zone.id, entry.nodeId));
            (zone.sharedNodeIds || []).forEach((id) => reference(zone.id, id));
        });
        // Infer dependency references too, supporting older or minimal zone payloads.
        edges.forEach((edge) => reference(byId.get(edge.target).zoneId, edge.source));
        references.forEach((entry) => {
            if (!visibleZones.some((zone) => zone.id === entry.zoneId)) {
                const zone = zones.find((zone) => zone.id === entry.zoneId);
                visibleZones.push({ ...zone, minWidth: Math.max(220, Math.ceil(measure(zone.name) * 1.2) + 40) });
            }
        });
        return { nodes, edges, zones: visibleZones.sort(compare), references: [...references.values()].sort((a, b) => a.appearanceId.localeCompare(b.appearanceId)) };
    }

    /** Cache key includes topology, ownership, kinds, and label/header dimensions. */
    function signature(graph, measure) {
        const data = model(graph, measure);
        return JSON.stringify([
            data.nodes.map((node) => [node.id, node.kind, node.zoneId, node.width, node.height]),
            data.edges.map((edge) => [edge.source, edge.target]),
            data.zones.map((zone) => [zone.id, zone.minWidth]),
            data.references.map((node) => [node.appearanceId, node.nodeId, node.ownerZoneId, node.kind, node.width, node.height])
        ]);
    }

    /**
     * Compute one compound ELK layout, then flatten coordinates for SVG rendering.
     * ELK edge sections can be relative to an explicit `container`, even when
     * stored on the root graph. Resolve that container before drawing the route.
     * Original edge directions are retained when ELK breaks cycles for layout.
     *
     * @param {Object} graph Normalized backend Flow, optionally containing zones.
     * @param {Object} elk ELK instance exposing the asynchronous layout method.
     * @param {Function} [measure] Text width measurement at the renderer's font.
     * @returns {Promise<Object>} Positioned nodes, zone rectangles, and edge paths.
     */
    async function layout(graph, elk, measure) {
        const data = model(graph, measure);
        const appearance = (node) => node.isReference ? token("reference", node.appearanceId) : token("node", node.id);
        const port = (node, side) => token(side, appearance(node));
        const owned = new Map(data.nodes.map((node) => [node.id, node]));
        const references = new Map(data.references.map((node) => [node.appearanceId, node]));
        const inputFor = (edge) => references.get(JSON.stringify([owned.get(edge.target).zoneId, edge.source])) || owned.get(edge.source);
        const makeNode = (node) => ({
            id: appearance(node), width: node.width, height: node.height,
            layoutOptions: { "elk.portConstraints": "FIXED_POS" },
            ports: [
                { id: port(node, "in"), x: 0, y: 36, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } },
                { id: port(node, "out"), x: node.width, y: 36, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } }
            ]
        });
        const input = { id: "root", layoutOptions: { ...OPTIONS }, children: [], edges: data.edges.map((edge, index) => ({
            id: token("edge", index), sources: [port(inputFor(edge), "out")], targets: [port(owned.get(edge.target), "in")]
        })) };
        // Sharing affects the zone graph once per directed pair, not per item.
        const zonePairs = new Map();
        data.references.forEach((node) => {
            const key = JSON.stringify([node.ownerZoneId, node.zoneId]);
            if (!zonePairs.has(key)) zonePairs.set(key, {
                id: token("zone-link", key), sourceZoneId: node.ownerZoneId,
                targetZoneId: node.zoneId, nodeIds: []
            });
            zonePairs.get(key).nodeIds.push(node.nodeId);
        });
        const zoneLinks = [...zonePairs.values()].sort(compare);
        zoneLinks.forEach((edge) => {
            edge.nodeIds.sort();
            input.edges.push({ id: edge.id,
                sources: [token("zone-out", edge.sourceZoneId)],
                targets: [token("zone-in", edge.targetZoneId)] });
        });
        if (data.zones.length) {
            input.children = data.zones.map((zone) => {
                const children = [...data.nodes, ...data.references].filter((node) => node.zoneId === zone.id).map(makeNode);
                return {
                    id: token("zone", zone.id), children,
                    ports: [
                        { id: token("zone-in", zone.id), width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } },
                        { id: token("zone-out", zone.id), width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } }
                    ],
                    ...(children.length ? {} : { width: zone.minWidth, height: 130 }),
                    layoutOptions: { ...OPTIONS, "elk.padding": "[top=64,left=28,bottom=28,right=28]",
                        "elk.portConstraints": "FIXED_SIDE",
                        "elk.nodeSize.constraints": "MINIMUM_SIZE", "elk.nodeSize.minimum": `(${zone.minWidth},130)` }
                };
            });
        } else input.children = data.nodes.map(makeNode);
        const result = await elk.layout(input);
        const positions = new Map([["root", { x: 0, y: 0 }]]);
        const edgeSections = [];
        function visit(container, parentX, parentY) {
            const x = parentX + (container.x || 0);
            const y = parentY + (container.y || 0);
            positions.set(container.id, { x, y, width: container.width, height: container.height });
            (container.edges || []).forEach((edge) => edgeSections.push({ edge, parent: container.id }));
            (container.children || []).forEach((child) => visit(child, x, y));
        }
        visit(result, 0, 0);
        const positionNode = (node) => {
            const position = positions.get(appearance(node));
            if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error("ELK did not position every Flow item.");
            return { ...node, x: position.x + node.width / 2, y: position.y + 36 };
        };
        const nodes = data.nodes.map(positionNode);
        const referenceNodes = data.references.map(positionNode);
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const referenceById = new Map(referenceNodes.map((node) => [node.appearanceId, node]));
        const routes = new Map();
        edgeSections.forEach(({ edge, parent }) => {
            const offset = positions.get(edge.container || parent);
            if (!offset) throw new Error("ELK returned an unknown edge container.");
            const paths = (edge.sections || []).map((section) => [section.startPoint, ...(section.bendPoints || []), section.endPoint]
                .map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })));
            routes.set(edge.id, paths);
        });
        const route = (id, source, target) => {
            const paths = routes.get(id);
            if (!paths || !paths.length) throw new Error("ELK did not route every Flow connection.");
            // Ports reserve the whole label width; extend their routes to shapes.
            paths[0].unshift({ x: source.x + radius(source.kind), y: source.y });
            paths[paths.length - 1].push({ x: target.x - radius(target.kind), y: target.y });
            return paths;
        };
        const edges = data.edges.map((edge, index) => {
            const source = referenceById.get(JSON.stringify([byId.get(edge.target).zoneId, edge.source])) || byId.get(edge.source);
            return { ...edge, sourceAppearanceId: source.appearanceId || null,
                paths: route(token("edge", index), source, byId.get(edge.target)) };
        });
        return {
            nodes, edges, references: referenceNodes,
            zoneLinks: zoneLinks.map((edge) => {
                const paths = routes.get(edge.id);
                if (!paths || !paths.length) throw new Error("ELK did not route every zone connection.");
                return { ...edge, paths };
            }),
            zones: data.zones.map((zone) => ({ ...zone, ...positions.get(token("zone", zone.id)) })),
            bounds: { x: 0, y: 0, width: Math.max(1, result.width || 300), height: Math.max(1, result.height || 200) }
        };
    }
    return { layout, signature, labelLines };
}));
