"""Read DSS Flow data and normalize graph nodes, dependencies, and zones."""
import json


ML_RECIPE_TYPES = {
    'prediction_training', 'prediction_scoring', 'clustering_training',
    'clustering_scoring', 'clustering_complete', 'clustering_cluster',
    'evaluation', 'standalone_evaluation',
}


def normalize_flow(raw_nodes, labels):
    """Convert DSS graph nodes to display nodes and directed dependency edges.

    Preserve graph IDs (including foreign references) and disconnected items.
    Names for saved models and managed folders come from their metadata, since
    their graph references can be opaque IDs.

    Args:
        raw_nodes: Mapping of graph node IDs to raw DSS node dictionaries.
        labels: Mapping of (DSS node type, object reference) pairs to display names.
    """
    nodes = []
    edges = set()

    for key, node in raw_nodes.items():
        node_type = node.get('type', '')
        if node_type == 'COMPUTABLE_SAVED_MODEL':
            kind = 'model'
        elif node_type == 'AGENT_TOOL':
            kind = 'agent-tool'
        elif node_type == 'RUNNABLE_IMPLICIT_RECIPE' or node.get('subType') in ML_RECIPE_TYPES:
            kind = 'ml-recipe'
        elif node_type.startswith('RUNNABLE'):
            kind = 'recipe'
        else:
            kind = 'dataset'

        ref = node.get('ref') or key
        nodes.append({
            'id': key, 
            'name': labels.get((node_type, ref)) or node.get('name') or ref,
            'kind': kind
        })

        if kind in ('recipe', 'ml-recipe'):
            nodes[-1]['subType'] = node.get('subType') or ('prediction_training' if node_type == 'RUNNABLE_IMPLICIT_RECIPE' else None)

        for target in node.get('successors', []):
            if target in raw_nodes:
                edges.add((key, target))

        for source in node.get('predecessors', []):
            if source in raw_nodes:
                edges.add((source, key))

    return {
        'nodes': nodes, 
        'edges': [{
            'source': source, 
            'target': target
        } for source, target in sorted(edges)]
    }


def normalize_zones(project_key, raw_nodes, graph, settings):
    """Add zone ownership and references while preserving flat graph identities.

    ``settings`` is a list of dictionaries from the public zone settings API.
    Match smart references by object type and project-qualified name, not display
    labels. Unassigned items belong to the default zone; implicit recipes follow
    their output when all resolved outputs belong to one zone. Keep unresolved
    metadata references visible for diagnosis rather than inventing graph nodes.

    Each zone lists owned ``nodeIds``, explicitly pre-shared ``sharedNodeIds``,
    and non-owning ``references`` caused by sharing or incoming dependencies.
    Reference appearance IDs encode the zone/node pair, independently of names.
    This function mutates only the normalized response, never DSS settings.

    Args:
        project_key: DSS project key used to resolve local and foreign references.
        raw_nodes: Mapping of graph node IDs to raw DSS node dictionaries.
        graph: Normalized nodes and edges; updated in place with zone ownership
            and zone metadata.
        settings: List of raw zone settings dictionaries returned by DSS.
    """
    zones, owners, shared = _collect_zone_membership(project_key, raw_nodes, settings)
    _infer_zone_owners(raw_nodes, graph['edges'], owners)

    return _assemble_zones(graph, zones, owners, shared)


def _resolve_zone_item(item, project_key, lookup):
    """Find the Flow node ID matching a typed object reference from DSS zone settings.

    Args:
        item: Zone object reference containing objectType, objectId, and an
            optional projectKey.
        project_key: Key of the project whose Flow is being normalized; used when
            the reference does not specify a project.
        lookup: Mapping of (zone object type, object reference) pairs to graph IDs.
    """
    object_type = item.get('objectType')
    if object_type == 'GENAI_EVALUATION_STORE':
        object_type = 'MODEL_EVALUATION_STORE'

    ref = item.get('objectId', '')
    owner_project = item.get('projectKey') or project_key

    if owner_project != project_key and not ref.startswith(owner_project + '.'):
        ref = owner_project + '.' + ref

    elif owner_project == project_key and ref.startswith(project_key + '.'):
        ref = ref[len(project_key) + 1:]

    return lookup.get((object_type, ref)) if object_type else None


def _collect_zone_membership(project_key, raw_nodes, settings):
    """Resolve explicit owners, shared items, and unresolved zone metadata.

    Args:
        project_key: Key of the project whose zone references are being resolved.
        raw_nodes: Mapping of graph node IDs to raw DSS node dictionaries.
        settings: List of raw DSS zone dictionaries containing zone metadata and
            optional items (owned nodes) and shared (additional appearances).
    """

    # Graph nodes and zone settings use different names for the same object
    # types. Translate graph types so both APIs can be matched by type and ref.
    object_types = {
        'COMPUTABLE_DATASET': 'DATASET', 'COMPUTABLE_SAVED_MODEL': 'SAVED_MODEL',
        'COMPUTABLE_FOLDER': 'MANAGED_FOLDER', 'RUNNABLE_RECIPE': 'RECIPE',
        'RUNNABLE_IMPLICIT_RECIPE': 'RECIPE', 'RUNNABLE_LABELING_TASK': 'LABELING_TASK',
        'COMPUTABLE_MODEL_EVALUATION_STORE': 'MODEL_EVALUATION_STORE',
        'COMPUTABLE_STREAMING_ENDPOINT': 'STREAMING_ENDPOINT',
        'COMPUTABLE_RETRIEVABLE_KNOWLEDGE': 'RETRIEVABLE_KNOWLEDGE',
        'AGENT_TOOL': 'AGENT_TOOL',
    }
    # Keep the type in the lookup key: a dataset and a recipe may share a name.
    # The value is the existing graph ID, which can differ from the object's ref.
    lookup = {(object_types.get(node.get('type')), node.get('ref') or key): key
              for key, node in raw_nodes.items()}

    # Track zone metadata, each node's explicit owner, and the nodes shared into
    # each zone separately.
    zones = {}
    owners = {}
    shared = {}
    for raw in settings:
        # Create every configured zone, including empty ones. Node lists and
        # reference appearances are populated later, after ownership is inferred.
        zone_id = raw['id']
        zones[zone_id] = {
            'id': zone_id, 
            'name': raw.get('name') or zone_id,
            'color': raw.get('color') or '#D1D8DA', 
            'isDefault': zone_id == 'default',
            'nodeIds': [], 
            'sharedNodeIds': [], 
            'references': [], 
            'unresolvedItems': []
        }

        # 'items' assigns ownership (listing nodes that belongs to this zone)
        # 'shared' lists nodes displayed in this zone while still owned by another zone. 
        # Both are optional, but at least one must be present to create a zone.
        # Also, both contain typed object references that must resolve to graph nodes.
        shared[zone_id] = set()
        for field in ('items', 'shared'):
            for item in raw.get(field, []):
                node_id = _resolve_zone_item(item, project_key, lookup)

                if node_id is None:
                    # If a zone refers to an object we can’t find in the Flow 
                    # graph, we keep a record of that reference in unresolvedItems.
                    zones[zone_id]['unresolvedItems'].append({
                        'source': field, 
                        'objectType': item.get('objectType'),
                        'projectKey': item.get('projectKey') or project_key,
                        'objectId': item.get('objectId'),
                    })

                elif field == 'shared':
                    # Sets collapse repeated sharing entries for the same node.
                    shared[zone_id].add(node_id)

                else:
                    # Repeated entries in one zone are harmless, but assigning
                    # the same node to different owning zones is inconsistent.
                    if node_id in owners and owners[node_id] != zone_id:
                        raise ValueError('A Flow item belongs to multiple zones')
                    
                    owners[node_id] = zone_id

    # Preserve DSS's default-zone metadata when it was supplied in settings.
    if 'default' not in zones:
        zones['default'] = {
            'id': 'default', 
            'name': 'Default', 
            'color': '#D1D8DA', 
            'isDefault': True,
            'nodeIds': [], 
            'sharedNodeIds': [], 
            'references': [], 
            'unresolvedItems': []
        }
        shared['default'] = set()

    return zones, owners, shared


def _infer_zone_owners(raw_nodes, edges, owners):
    """Assign unowned items, following implicit-recipe outputs until stable.

    Args:
        raw_nodes: Mapping of graph node IDs to raw DSS node dictionaries.
        edges: List of normalized dependency edges with source and target IDs.
        owners: Mapping of node IDs to explicitly assigned zone IDs; updated in
            place with inferred ownership and default-zone assignments.
    """
    pending = set()
    successors = {key: [] for key in raw_nodes}
    for edge in edges:
        successors[edge['source']].append(edge['target'])

    for key, node in raw_nodes.items():
        if key in owners:
            continue
        if node.get('type') == 'RUNNABLE_IMPLICIT_RECIPE':
            pending.add(key)
        else:
            owners[key] = 'default'

    while pending:
        resolved = set()
        for key in pending:
            outputs = successors[key]
            if outputs and all(output in owners for output in outputs):
                output_zones = {owners[output] for output in outputs}
                owners[key] = next(iter(output_zones)) if len(output_zones) == 1 else 'default'
                resolved.add(key)

        if not resolved:
            break

        pending -= resolved

    for key in pending:
        owners[key] = 'default'


def _assemble_zones(graph, zones, owners, shared):
    """Attach ownership and deduplicated reference appearances to the graph.

    Args:
        graph: Normalized nodes and edges; updated in place with node zone IDs,
            sorted zones, and the hasZones flag.
        zones: Mapping of zone IDs to zone response dictionaries; updated in place
            with owned nodes, shared nodes, and reference appearances.
        owners: Complete mapping of graph node IDs to their owning zone IDs.
        shared: Mapping of zone IDs to sets of graph node IDs explicitly shared
            into each zone.
    """
    references = {zone_id: {} for zone_id in zones}

    def add_reference(zone_id, node_id, reason):
        """Accumulate reasons for a non-owning appearance, without duplication.

        Args:
            zone_id: ID of the zone in which the node should appear.
            node_id: Existing graph node ID; ignored if this zone already owns it.
            reason: Reason for the appearance, such as 'shared' or 'dependency'.
        """
        if owners[node_id] != zone_id:
            references[zone_id].setdefault(node_id, set()).add(reason)

    for zone_id, node_ids in shared.items():
        zones[zone_id]['sharedNodeIds'] = sorted(node_ids)
        for node_id in node_ids:
            add_reference(zone_id, node_id, 'shared')

    for edge in graph['edges']:
        add_reference(owners[edge['target']], edge['source'], 'dependency')

    for node in graph['nodes']:
        node['zoneId'] = owners[node['id']]
        zones[node['zoneId']]['nodeIds'].append(node['id'])

    for zone_id, zone in zones.items():
        zone['nodeIds'].sort()
        zone['unresolvedItems'].sort(key=lambda item: json.dumps(item, sort_keys=True))
        zone['references'] = [
            {'appearanceId': json.dumps([zone_id, node_id], separators=(',', ':')),
             'nodeId': node_id, 'ownerZoneId': owners[node_id], 'reasons': sorted(reasons)}
            for node_id, reasons in sorted(references[zone_id].items())
        ]

    graph['zones'] = sorted(zones.values(), key=lambda zone: (
        not zone['isDefault'], zone['name'].casefold(), zone['id']))
    graph['hasZones'] = any(not zone['isDefault'] for zone in graph['zones'])

    return graph


def read_project_flow(project, project_key):
    """Read graph, labels, and zones once for rendering or comparison snapshots.

    Args:
        project: DSS project API handle authenticated as the end user, used to read
            the Flow, zones, saved-model names, and managed-folder names.
        project_key: Key of that project, used to qualify object references.
    """
    project_flow = project.get_flow()
    graph = project_flow.get_graph()
    zone_settings = [zone.get_settings().get_raw() for zone in project_flow.list_zones()]
    labels = {}

    if any(node.get('type') == 'COMPUTABLE_SAVED_MODEL' for node in graph.nodes.values()):
        for model in project.list_saved_models(include_shared=True):
            ref = model['id']
            if model.get('projectKey') and model['projectKey'] != project_key:
                ref = model['projectKey'] + '.' + ref

            labels[('COMPUTABLE_SAVED_MODEL', ref)] = model.get('name') or ref

    if any(node.get('type') == 'COMPUTABLE_FOLDER' for node in graph.nodes.values()):
        for folder in project.list_managed_folders():
            labels[('COMPUTABLE_FOLDER', folder['id'])] = folder.get('name') or folder['id']

    normalized = normalize_zones(project_key, graph.nodes, normalize_flow(graph.nodes, labels), zone_settings)

    return normalized, graph.nodes