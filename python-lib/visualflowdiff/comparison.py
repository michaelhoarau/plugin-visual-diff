"""Canonical Flow snapshots and a baseline-to-comparison union graph.

Only configuration is compared, never dataset contents or execution results.
Names/IDs match objects within a DSS object type; renames appear as delete/add.
"""
import json
from copy import deepcopy


# Export provenance changes when objects are copied between projects; it does
# not change their configuration. Ignore it only at the settings root.
VOLATILE = {'versionTag', 'creationTag', 'creationOrigin', 'projectKey', 'lastExportedFrom'}
READERS = {'COMPUTABLE_DATASET': 'get_dataset', 'COMPUTABLE_FOLDER': 'get_managed_folder',
           'COMPUTABLE_SAVED_MODEL': 'get_saved_model', 'AGENT_TOOL': 'get_agent_tool',
           'COMPUTABLE_RETRIEVABLE_KNOWLEDGE': 'get_knowledge_bank'}
CODE_RECIPES = {'python', 'sql', 'r', 'shell', 'pyspark', 'spark_sql', 'sparkr', 'spark_scala'}


def canonical(value, project_key):
    """Sort dictionaries and normalize only the generated project's namespace."""
    if isinstance(value, dict):
        return {key: canonical(item, project_key) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [canonical(item, project_key) for item in value]
    if isinstance(value, str):
        if value == project_key:
            return '$project'
        if value.startswith(project_key + '.'):
            return '$project.' + value[len(project_key) + 1:]
        if value.startswith('agentdep->' + project_key + '.'):
            return 'agentdep->$project.' + value[len('agentdep->' + project_key + '.'):]
    return value


def definition(raw, project_key):
    """Omit automatic root identity/version metadata, retaining business settings."""
    return canonical({key: value for key, value in raw.items() if key not in VOLATILE}, project_key)


def agent_tool_refs(config):
    """Find explicit tools in the active agent version, including nested blocks.

    Ignore unused settings for other agent types and inactive saved versions.
    Never infer dependencies from executable code or prompt text.
    """
    settings_key = {'TOOLS_USING_AGENT': 'toolsUsingAgentSettings',
                    'STRUCTURED_AGENT': 'structuredAgentSettings',
                    'PYTHON_AGENT': 'pythonAgentSettings',
                    'PLUGIN_AGENT': 'pluginAgentSettings'}.get(config.get('savedModelType'))
    if settings_key is None:
        return set()
    refs = set()

    def walk(value):
        if isinstance(value, dict):
            ref = value.get('toolRef')
            if isinstance(ref, str) and ref:
                refs.add(ref)
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for version in config.get('inlineVersions', []):
        if version.get('versionId') == config.get('activeVersion'):
            walk(version.get(settings_key, {}))
    return refs


def add_agent_tools(project, project_key, objects, warnings):
    """Expose referenced tools once, with dependency edges toward their agents."""
    for agent in list(objects.values()):
        for ref in sorted(agent_tool_refs(agent['config'])):
            if ref.startswith('$project.'):
                ref = ref[len('$project.'):]
            key = json.dumps(['AGENT_TOOL', ref], separators=(',', ':'))
            if key not in objects:
                external = '.' in ref
                config = ({'externalReference': ref} if external else
                          definition(project.get_agent_tool(ref).get_settings().get_raw(), project_key))
                coverage = 'external-reference' if external else 'settings'
                name = config.get('name') or ref
                objects[key] = {'id': key, 'name': name, 'kind': 'agent-tool',
                                'type': 'AGENT_TOOL', 'subType': config.get('type'),
                                'zoneId': agent['zoneId'], 'coverage': coverage,
                                'config': config, 'inputs': [], 'outputs': [], 'sharedWith': []}
                if external:
                    warnings.append('%s: external-reference configuration coverage' % name)
            if key not in agent['inputs']:
                agent['inputs'].append(key)
            if agent['id'] not in objects[key]['outputs']:
                objects[key]['outputs'].append(agent['id'])


def connect_tool_knowledge_banks(project, project_key, objects):
    """Use the tool's explicit bank reference, never its display name, to wire inputs."""
    for tool in list(objects.values()):
        if tool['type'] != 'AGENT_TOOL' or tool['config'].get('type') != 'VectorStoreSearch':
            continue
        ref = tool['config'].get('params', {}).get('knowledgeBankRef')
        if not isinstance(ref, str) or not ref:
            continue
        if ref.startswith('$project.'):
            ref = ref[len('$project.'):]
        key = json.dumps(['COMPUTABLE_RETRIEVABLE_KNOWLEDGE', ref], separators=(',', ':'))
        if key not in objects:
            external = '.' in ref
            config = ({'externalReference': ref} if external else
                      definition(project.get_knowledge_bank(ref).get_settings().get_raw(), project_key))
            objects[key] = {'id': key, 'name': config.get('name') or ref, 'kind': 'dataset',
                            'type': 'COMPUTABLE_RETRIEVABLE_KNOWLEDGE', 'subType': None,
                            'zoneId': tool['zoneId'], 'coverage': 'external-reference' if external else 'settings',
                            'config': config, 'inputs': [], 'outputs': [], 'sharedWith': []}
        if key not in tool['inputs']:
            tool['inputs'].append(key)
        if tool['id'] not in objects[key]['outputs']:
            objects[key]['outputs'].append(tool['id'])

    # DSS aggregates the agent's resources through an implicit recipe. Replace
    # that aggregate only when every input is represented by an explicit tool
    # dependency for each destination agent. Retain unresolved resources.
    for key, dependency in list(objects.items()):
        identity = json.loads(key)
        if dependency['type'] != 'RUNNABLE_IMPLICIT_RECIPE' or not identity[1].startswith('agentdep->$project.'):
            continue
        destinations = [objects[target] for target in dependency['outputs']]
        resolved = bool(destinations)
        for agent in destinations:
            tool_inputs = {source for tool_key in agent['inputs']
                           if objects[tool_key]['type'] == 'AGENT_TOOL'
                           for source in objects[tool_key]['inputs']}
            if not set(dependency['inputs']).issubset(tool_inputs):
                resolved = False
        if resolved:
            for source in dependency['inputs']:
                objects[source]['outputs'].remove(key)
            for agent in destinations:
                agent['inputs'].remove(key)
            del objects[key]
        elif destinations:
            dependency['name'] = 'Dependencies for ' + ', '.join(agent['name'] for agent in destinations)


def build_snapshot(project, project_key, flow, raw_nodes):
    """Read supported object settings through viewer-scoped public DSS APIs.

    External objects and implicit/unsupported objects retain graph metadata and
    explicitly report partial coverage. Failed supported settings reads fail the
    comparison instead of incorrectly calling unreadable objects unchanged.
    """
    objects, mapping, warnings = {}, {}, []
    displayed = {node['id']: node for node in flow['nodes']}
    for graph_id, raw in sorted(raw_nodes.items()):
        ref = raw.get('ref') or graph_id
        if ref.startswith(project_key + '.'):
            ref = ref[len(project_key) + 1:]
        # DSS embeds the generated project's key inside implicit agent dependency
        # identities. Keep the dependency marker and agent ID, normalize only
        # this project's namespace; foreign-project dependencies remain distinct.
        agent_dependency = (raw.get('type') == 'RUNNABLE_IMPLICIT_RECIPE'
                            and ref.startswith('agentdep->'))
        if agent_dependency:
            ref = canonical(ref, project_key)
        key = json.dumps([raw.get('type', 'UNKNOWN'), ref], separators=(',', ':'))
        if key in objects:
            raise ValueError('Duplicate canonical Flow object identity')
        mapping[graph_id] = key
        node = displayed[graph_id]
        name = node['name']
        if agent_dependency and name in (raw.get('ref'), graph_id):
            name = ref
        coverage = 'settings'
        dependency_ref = ref[len('agentdep->'):] if agent_dependency else ref
        external = '.' in dependency_ref and not (agent_dependency and dependency_ref.startswith('$project.'))
        if external:
            config, coverage = {'externalReference': ref}, 'external-reference'
        elif raw.get('type') == 'RUNNABLE_RECIPE':
            settings = project.get_recipe(ref).get_settings()
            recipe_definition = settings.get_recipe_raw_definition()
            payload = settings.str_payload
            if isinstance(payload, str) and recipe_definition.get('type', raw.get('subType')) not in CODE_RECIPES:
                try:
                    payload = json.loads(payload)
                except ValueError:
                    pass
            config = {'definition': definition(recipe_definition, project_key),
                      'payload': canonical(payload, project_key)}
        elif raw.get('type') in READERS:
            handle = getattr(project, READERS[raw['type']])(ref)
            config = definition(handle.get_settings().get_raw(), project_key)
            if raw['type'] in ('COMPUTABLE_RETRIEVABLE_KNOWLEDGE', 'AGENT_TOOL'):
                name = config.get('name') or name
        else:
            config = definition({name: value for name, value in raw.items()
                                 if name not in ('predecessors', 'successors', 'ref', 'name')}, project_key)
            coverage = 'graph-only'
        if coverage != 'settings':
            warnings.append('%s: %s configuration coverage' % (name, coverage))
        objects[key] = {'id': key, 'name': name, 'kind': node['kind'],
                        'type': raw.get('type'), 'subType': raw.get('subType'),
                        'zoneId': node.get('zoneId', 'default'), 'coverage': coverage,
                        'config': config, 'inputs': [], 'outputs': [], 'sharedWith': []}
    edges = sorted({(mapping[edge['source']], mapping[edge['target']]) for edge in flow['edges']})
    for source, target in edges:
        objects[source]['outputs'].append(target)
        objects[target]['inputs'].append(source)
    add_agent_tools(project, project_key, objects, warnings)
    connect_tool_knowledge_banks(project, project_key, objects)
    zones = {}
    for zone in flow.get('zones', []):
        zones[zone['id']] = {'id': zone['id'], 'name': zone['name'], 'color': zone['color'],
                             'isDefault': zone.get('isDefault', False)}
        for node_id in zone.get('sharedNodeIds', []):
            if node_id in mapping and mapping[node_id] in objects:
                objects[mapping[node_id]]['sharedWith'].append(zone['id'])
    for node in objects.values():
        node['sharedWith'].sort()
        node['inputs'].sort()
        node['outputs'].sort()
    warnings = ['%s: %s configuration coverage' % (node['name'], node['coverage'])
                for node in objects.values() if node['coverage'] != 'settings']
    return {'schemaVersion': 1, 'projectKey': project_key, 'warnings': sorted(warnings),
            'model': {'objects': dict(sorted(objects.items())), 'zones': dict(sorted(zones.items()))}}


def compare_snapshots(baseline, target):
    """Classify object/zone settings and preserve both sides of deleted topology."""
    before, after = baseline['model'], target['model']
    objects, zones, counts = [], [], dict.fromkeys(('added', 'deleted', 'modified', 'unchanged'), 0)
    statuses = {}
    for key in sorted(set(before['objects']) | set(after['objects'])):
        left, right = before['objects'].get(key), after['objects'].get(key)
        status = 'added' if left is None else 'deleted' if right is None else 'unchanged' if left == right else 'modified'
        statuses[key] = status
        counts[status] += 1
        objects.append(dict(deepcopy(right if right is not None else left), diffStatus=status))
    for key in sorted(set(before['zones']) | set(after['zones'])):
        left, right = before['zones'].get(key), after['zones'].get(key)
        status = 'added' if left is None else 'deleted' if right is None else 'unchanged' if left == right else 'modified'
        zones.append(dict(deepcopy(right if right is not None else left), diffStatus=status, sharedNodeIds=[]))
    def edge_set(model):
        return {(key, target) for key, node in model['objects'].items() for target in node['outputs']}
    old_edges, new_edges = edge_set(before), edge_set(after)
    edges = []
    for source, destination in sorted(old_edges | new_edges):
        edge = (source, destination)
        status = 'added' if edge not in old_edges else 'deleted' if edge not in new_edges else (
            'modified' if statuses[source] == 'modified' or statuses[destination] == 'modified' else 'unchanged')
        edges.append({'source': source, 'target': destination, 'diffStatus': status})
    zone_map = {zone['id']: zone for zone in zones}
    for node in objects:
        for zone in node['sharedWith']:
            zone_map[zone]['sharedNodeIds'].append(node['id'])
    zone_counts = {status: sum(zone['diffStatus'] == status for zone in zones) for status in counts}
    return {'schemaVersion': 1, 'baseline': baseline, 'target': target, 'counts': counts, 'zoneCounts': zone_counts,
            'graph': {'nodes': objects, 'edges': edges, 'zones': zones,
                      'hasZones': any(not zone.get('isDefault') for zone in zones)}}
