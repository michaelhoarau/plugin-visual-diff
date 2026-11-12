"""Compare configuration snapshots independently of generated project identities."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-lib'))
from visualflowdiff.comparison import add_agent_tools, build_snapshot, compare_snapshots
from unittest.mock import Mock


def fixture(project_key='BASE', payload='{"steps": []}'):
    raw = {'data': {'type': 'COMPUTABLE_DATASET', 'ref': project_key + '.data'},
           'recipe': {'type': 'RUNNABLE_RECIPE', 'subType': 'shaker', 'ref': 'recipe'}}
    flow = {'nodes': [{'id': 'data', 'name': 'data', 'kind': 'dataset', 'zoneId': 'default'},
                      {'id': 'recipe', 'name': 'recipe', 'kind': 'recipe', 'zoneId': 'default'}],
            'edges': [{'source': 'data', 'target': 'recipe'}],
            'zones': [{'id': 'default', 'name': 'Default', 'color': '#cccccc', 'isDefault': True}]}
    dataset = {'name': 'data', 'projectKey': project_key, 'versionTag': {'versionNumber': 99 if project_key == 'BASE' else 100},
               'schema': {'columns': [{'name': 'value', 'type': 'string'}]}}
    recipe = {'name': 'recipe', 'type': 'shaker', 'versionTag': {'versionNumber': 1},
              'inputs': {'main': {'items': [{'ref': project_key + '.data'}]}}}
    project = SimpleNamespace(
        get_dataset=lambda ref: SimpleNamespace(get_settings=lambda: SimpleNamespace(get_raw=lambda: dataset)),
        get_recipe=lambda ref: SimpleNamespace(get_settings=lambda: SimpleNamespace(
            get_recipe_raw_definition=lambda: recipe, str_payload=payload)))
    return build_snapshot(project, project_key, flow, raw)


class ComparisonTest(unittest.TestCase):
    def search_tool_snapshot(self, project_key='BASE', swap=False, include_logs=True):
        dep = 'agentdep->' + project_key + '.agent'
        raw = {'logs': {'type': 'COMPUTABLE_RETRIEVABLE_KNOWLEDGE', 'ref': 'logs'},
               'attachments': {'type': 'COMPUTABLE_RETRIEVABLE_KNOWLEDGE', 'ref': 'attachments'},
               'agent': {'type': 'COMPUTABLE_SAVED_MODEL', 'ref': 'agent'},
               dep: {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'ref': dep}}
        tools = [{'toolRef': 'screenshots'}] + ([{'toolRef': 'search_logs'}] if include_logs else [])
        agent = {'savedModelType': 'TOOLS_USING_AGENT', 'activeVersion': 'v1', 'name': 'Draft message answer',
                 'inlineVersions': [{'versionId': 'v1', 'toolsUsingAgentSettings': {'tools': tools}}]}
        configs = {'screenshots': {'name': 'Search screenshots', 'type': 'VectorStoreSearch',
                                  'params': {'knowledgeBankRef': project_key + ('.attachments' if swap else '.logs')}},
                   'search_logs': {'name': 'Search logs', 'type': 'VectorStoreSearch',
                                   'params': {'knowledgeBankRef': 'logs' if swap else 'attachments'}}}
        def handle(settings):
            return SimpleNamespace(get_settings=lambda: SimpleNamespace(get_raw=lambda: settings))
        project = SimpleNamespace(get_saved_model=lambda ref: handle(agent),
                                  get_knowledge_bank=lambda ref: handle({'name': 'embedded-' + ref}),
                                  get_agent_tool=lambda ref: handle(configs[ref]))
        flow = {'nodes': [{'id': key, 'name': 'Draft message answer' if key == 'agent' else key, 'kind': 'model' if key == 'agent' else
                          'ml-recipe' if key == dep else 'dataset',
                          'zoneId': 'agent-zone' if key in ('agent', dep) else 'source-zone'} for key in raw],
                'edges': [{'source': 'logs', 'target': dep}, {'source': 'attachments', 'target': dep},
                          {'source': dep, 'target': 'agent'}],
                'zones': [{'id': 'source-zone', 'name': 'Sources', 'color': '#123456'},
                          {'id': 'agent-zone', 'name': 'Agents', 'color': '#654321', 'sharedNodeIds': [dep]}]}
        return build_snapshot(project, project_key, flow, raw)

    def test_search_tools_connect_to_their_configured_banks_and_replace_aggregate(self):
        snapshot = self.search_tool_snapshot()
        objects = snapshot['model']['objects']
        self.assertEqual(len(objects), 5)
        self.assertFalse(snapshot['warnings'])
        self.assertFalse(any(node['type'] == 'RUNNABLE_IMPLICIT_RECIPE' for node in objects.values()))
        screenshots = objects['["AGENT_TOOL","screenshots"]']
        logs = objects['["AGENT_TOOL","search_logs"]']
        self.assertEqual(screenshots['name'], 'Search screenshots')
        self.assertEqual(screenshots['inputs'], ['["COMPUTABLE_RETRIEVABLE_KNOWLEDGE","logs"]'])
        self.assertEqual(logs['name'], 'Search logs')
        self.assertEqual(logs['inputs'], ['["COMPUTABLE_RETRIEVABLE_KNOWLEDGE","attachments"]'])
        self.assertEqual(screenshots['outputs'], ['["COMPUTABLE_SAVED_MODEL","agent"]'])
        self.assertEqual(screenshots['zoneId'], 'agent-zone')
        self.assertEqual(objects[screenshots['inputs'][0]]['zoneId'], 'source-zone')
        self.assertEqual(compare_snapshots(snapshot, self.search_tool_snapshot('TARGET'))['counts']['unchanged'], 5)

    def test_changed_search_tool_bank_produces_real_edge_changes(self):
        result = compare_snapshots(self.search_tool_snapshot(), self.search_tool_snapshot('TARGET', swap=True))
        self.assertEqual(result['counts']['modified'], 4)
        self.assertEqual(sum(edge['diffStatus'] == 'added' for edge in result['graph']['edges']), 2)
        self.assertEqual(sum(edge['diffStatus'] == 'deleted' for edge in result['graph']['edges']), 2)

    def test_unresolved_agent_resources_are_retained_with_a_readable_label(self):
        snapshot = self.search_tool_snapshot(include_logs=False)
        dep = next(node for node in snapshot['model']['objects'].values() if node['type'] == 'RUNNABLE_IMPLICIT_RECIPE')
        self.assertEqual(dep['name'], 'Dependencies for Draft message answer')
        self.assertIn('["COMPUTABLE_RETRIEVABLE_KNOWLEDGE","attachments"]', dep['inputs'])
        self.assertEqual(snapshot['warnings'], ['Dependencies for Draft message answer: graph-only configuration coverage'])

    def knowledge_snapshot(self, project_key='BASE', embedding='embedding-model', agent_id='agent', foreign=None):
        dependency = 'agentdep->%s.%s' % (foreign or project_key, agent_id)
        flow = {'nodes': [{'id': 'kb', 'name': 'o4axj8mR', 'kind': 'dataset'},
                          {'id': dependency, 'name': dependency, 'kind': 'ml-recipe'}],
                'edges': [{'source': 'kb', 'target': dependency}], 'zones': []}
        raw = {'kb': {'type': 'COMPUTABLE_RETRIEVABLE_KNOWLEDGE', 'ref': project_key + '.o4axj8mR',
                      'fullId': project_key + '.o4axj8mR'},
               dependency: {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'fullId': dependency}}
        settings = {'name': 'Embedded logs', 'projectKey': project_key,
                    'embeddingLLMId': embedding, 'vectorStoreType': 'CHROMA',
                    'versionTag': {'versionNumber': 1}}
        self.knowledge_reader = Mock(return_value=SimpleNamespace(get_settings=lambda: SimpleNamespace(get_raw=lambda: settings)))
        project = SimpleNamespace(get_knowledge_bank=self.knowledge_reader)
        return build_snapshot(project, project_key, flow, raw)

    def test_knowledge_bank_settings_and_name_are_read(self):
        snapshot = self.knowledge_snapshot()
        self.knowledge_reader.assert_called_once_with('o4axj8mR')
        bank = snapshot['model']['objects']['["COMPUTABLE_RETRIEVABLE_KNOWLEDGE","o4axj8mR"]']
        self.assertEqual(bank['coverage'], 'settings')
        self.assertEqual(bank['name'], 'Embedded logs')
        self.assertEqual(bank['config']['embeddingLLMId'], 'embedding-model')
        self.assertNotIn('versionTag', bank['config'])
        self.assertFalse(any('o4axj8mR:' in warning for warning in snapshot['warnings']))

    def test_generated_agent_dependency_namespace_does_not_change_objects_or_edges(self):
        before = self.knowledge_snapshot('VFD_FARAH_ACTIVITY_SUMMA_360B5B93')
        after = self.knowledge_snapshot('VFD_FARAH_ACTIVITY_SUMMA_35AD4D5F')
        self.assertEqual(before['model'], after['model'])
        result = compare_snapshots(before, after)
        self.assertEqual(result['counts'], {'added': 0, 'deleted': 0, 'modified': 0, 'unchanged': 2})
        self.assertEqual(result['graph']['edges'][0]['diffStatus'], 'unchanged')
        self.assertEqual(before['warnings'], ['agentdep->$project.agent: graph-only configuration coverage'])

    def test_knowledge_bank_configuration_change_is_detected(self):
        before = self.knowledge_snapshot()
        after = self.knowledge_snapshot('TARGET', embedding='different-embedding')
        result = compare_snapshots(before, after)
        self.assertEqual(result['counts']['modified'], 1)
        self.assertEqual(next(node for node in result['graph']['nodes'] if node['type'] == 'COMPUTABLE_RETRIEVABLE_KNOWLEDGE')['diffStatus'], 'modified')

    def test_changed_agent_dependency_is_preserved_as_a_real_topology_change(self):
        result = compare_snapshots(self.knowledge_snapshot(), self.knowledge_snapshot('TARGET', agent_id='different'))
        self.assertEqual(result['counts']['added'], 1)
        self.assertEqual(result['counts']['deleted'], 1)
        self.assertEqual(result['counts']['modified'], 1)
        self.assertEqual({edge['diffStatus'] for edge in result['graph']['edges']}, {'added', 'deleted'})

    def test_foreign_agent_dependencies_are_not_normalized_as_local(self):
        before = self.knowledge_snapshot(foreign='FOREIGN')
        after = self.knowledge_snapshot('TARGET', foreign='FOREIGN')
        self.assertEqual(before['model'], after['model'])
        dep = before['model']['objects']['["RUNNABLE_IMPLICIT_RECIPE","agentdep->FOREIGN.agent"]']
        self.assertEqual(dep['coverage'], 'external-reference')
        changed = self.knowledge_snapshot('TARGET', foreign='OTHER')
        self.assertEqual(compare_snapshots(before, changed)['counts']['added'], 1)

    def test_knowledge_bank_settings_failure_is_not_silently_graph_only(self):
        reader = Mock(side_effect=RuntimeError('unreadable knowledge bank'))
        flow = {'nodes': [{'id': 'kb', 'name': 'KB', 'kind': 'dataset'}], 'edges': [], 'zones': []}
        with self.assertRaisesRegex(RuntimeError, 'unreadable knowledge bank'):
            build_snapshot(SimpleNamespace(get_knowledge_bank=reader), 'BASE', flow,
                           {'kb': {'type': 'COMPUTABLE_RETRIEVABLE_KNOWLEDGE', 'ref': 'kb'}})

    def agent_snapshot(self, tool_config=None, tools=None, structured=False, project_key='BASE'):
        tools = tools if tools is not None else [{'toolRef': project_key + '.lookup'}]
        settings_key = 'structuredAgentSettings' if structured else 'toolsUsingAgentSettings'
        settings = {'blocks': [{'type': 'CORE_LOOP', 'tools': tools},
                               {'type': 'MANUAL_TOOL_CALL', 'tool': {'toolRef': 'lookup'}}]} if structured else {'tools': tools}
        config = {'savedModelType': 'STRUCTURED_AGENT' if structured else 'TOOLS_USING_AGENT',
                  'activeVersion': 'v1', 'inlineVersions': [
                      {'versionId': 'v1', settings_key: settings},
                      {'versionId': 'old', settings_key: {'tools': [{'toolRef': 'inactive'}]}}]}
        self.project = SimpleNamespace(
            get_saved_model=lambda ref: SimpleNamespace(get_settings=lambda: SimpleNamespace(get_raw=lambda: config)),
            get_agent_tool=Mock(return_value=SimpleNamespace(get_settings=lambda: SimpleNamespace(
                get_raw=lambda: tool_config or {'name': 'Lookup', 'type': 'PYTHON', 'params': {'code': 'return 1'}}))))
        flow = {'nodes': [{'id': 'agent', 'name': 'Agent', 'kind': 'model', 'zoneId': 'z'}],
                'edges': [], 'zones': [{'id': 'z', 'name': 'Agents', 'color': '#123456'}]}
        return build_snapshot(self.project, project_key, flow,
                              {'agent': {'type': 'COMPUTABLE_SAVED_MODEL', 'ref': 'agent'}})

    def test_tools_using_and_structured_agents_expose_deduplicated_tools(self):
        for structured in (False, True):
            snapshot = self.agent_snapshot(structured=structured)
            objects = snapshot['model']['objects']
            tool = objects['["AGENT_TOOL","lookup"]']
            agent = objects['["COMPUTABLE_SAVED_MODEL","agent"]']
            self.assertEqual(len(objects), 2)
            self.assertEqual(tool['kind'], 'agent-tool')
            self.assertEqual(tool['coverage'], 'settings')
            self.assertEqual(tool['zoneId'], 'z')
            self.assertEqual(tool['outputs'], [agent['id']])
            self.assertEqual(agent['inputs'], [tool['id']])
            self.project.get_agent_tool.assert_called_once_with('lookup')

    def test_tool_code_and_configuration_changes_are_independently_modified(self):
        before = self.agent_snapshot()
        for config in ({'name': 'Lookup', 'type': 'PYTHON', 'params': {'code': 'return 2'}},
                       {'name': 'Lookup', 'type': 'PYTHON', 'params': {'code': 'return 1', 'timeout': 30}}):
            after = self.agent_snapshot(tool_config=config, project_key='TARGET')
            result = compare_snapshots(before, after)
            self.assertEqual(result['counts']['modified'], 1)
            self.assertEqual(next(node for node in result['graph']['nodes'] if node['kind'] == 'agent-tool')['diffStatus'], 'modified')

    def test_removed_tool_and_connection_remain_in_union(self):
        before = self.agent_snapshot()
        after = self.agent_snapshot(tools=[])
        result = compare_snapshots(before, after)
        self.assertEqual(result['counts']['deleted'], 1)
        self.assertEqual(result['graph']['edges'][0]['diffStatus'], 'deleted')

    def test_external_tool_is_visible_with_explicit_limited_coverage(self):
        snapshot = self.agent_snapshot(tools=[{'toolRef': 'OTHER.lookup'}])
        self.project.get_agent_tool.assert_not_called()
        self.assertEqual(len(snapshot['warnings']), 1)
        self.assertEqual(snapshot['model']['objects']['["AGENT_TOOL","OTHER.lookup"]']['coverage'], 'external-reference')

    def test_tool_read_failure_fails_snapshot(self):
        snapshot = self.agent_snapshot()
        agent = deepcopy(snapshot['model']['objects']['["COMPUTABLE_SAVED_MODEL","agent"]'])
        self.project.get_agent_tool.side_effect = RuntimeError('unreadable')
        with self.assertRaisesRegex(RuntimeError, 'unreadable'):
            add_agent_tools(self.project, 'BASE', {agent['id']: agent}, [])

    def test_shared_tool_is_read_once_and_links_to_each_agent(self):
        snapshot = self.agent_snapshot()
        agent = deepcopy(snapshot['model']['objects']['["COMPUTABLE_SAVED_MODEL","agent"]'])
        other = deepcopy(agent)
        other.update(id='other', zoneId='other-zone')
        self.project.get_agent_tool.reset_mock()
        objects = {agent['id']: agent, other['id']: other}
        add_agent_tools(self.project, 'BASE', objects, [])
        self.project.get_agent_tool.assert_called_once_with('lookup')
        tool = objects['["AGENT_TOOL","lookup"]']
        self.assertEqual(set(tool['outputs']), {agent['id'], other['id']})
        self.assertEqual(tool['zoneId'], agent['zoneId'])

    def test_tool_addition_and_version_bookkeeping(self):
        before = self.agent_snapshot(tools=[])
        after = self.agent_snapshot()
        result = compare_snapshots(before, after)
        self.assertEqual(result['counts']['added'], 1)
        self.assertEqual(result['graph']['edges'][0]['diffStatus'], 'added')
        equivalent = self.agent_snapshot(tool_config={'name': 'Lookup', 'type': 'PYTHON',
                                        'params': {'code': 'return 1'}, 'versionTag': {'versionNumber': 42}})
        self.assertEqual(compare_snapshots(after, equivalent)['counts']['modified'], 0)

    def test_model_export_provenance_is_ignored_but_model_settings_still_compare(self):
        def model_snapshot(project_key, export_source, threshold=0.5):
            settings = {'name': 'model', 'lastTrainIndex': 1, 'threshold': threshold,
                        'lastExportedFrom': export_source}
            project = SimpleNamespace(get_saved_model=lambda ref: SimpleNamespace(
                get_settings=lambda: SimpleNamespace(get_raw=lambda: settings)))
            flow = {'nodes': [{'id': 'model', 'name': 'Model', 'kind': 'model'}], 'edges': [], 'zones': []}
            raw = {'model': {'type': 'COMPUTABLE_SAVED_MODEL', 'ref': 'model'}}
            return build_snapshot(project, project_key, flow, raw)

        before = model_snapshot('BASE', 'SOURCE_A-model-version')
        after = model_snapshot('TARGET', 'SOURCE_B-model-version')
        result = compare_snapshots(before, after)
        self.assertEqual(result['counts'], {'added': 0, 'deleted': 0, 'modified': 0, 'unchanged': 1})
        self.assertEqual(before['model'], after['model'])
        self.assertNotIn('lastExportedFrom', result['graph']['nodes'][0]['config'])
        self.assertNotIn('lastExportedFrom', result['baseline']['model']['objects']['["COMPUTABLE_SAVED_MODEL","model"]']['config'])
        changed = model_snapshot('TARGET', 'SOURCE_B-model-version', threshold=0.7)
        self.assertEqual(compare_snapshots(before, changed)['counts']['modified'], 1)

    def test_export_provenance_exclusion_preserves_nested_recipe_payload_fields(self):
        before = fixture(payload='{"lastExportedFrom": "business-value-a"}')
        after = fixture(payload='{"lastExportedFrom": "business-value-b"}')
        self.assertEqual(compare_snapshots(before, after)['counts']['modified'], 1)

    def test_generated_namespace_and_version_tags_do_not_mark_every_object_modified(self):
        before, after = fixture('BASE'), fixture('TARGET', '{ "steps" : [] }')
        result = compare_snapshots(before, after)
        self.assertEqual(before['model'], after['model'])
        self.assertEqual(result['counts'], {'added': 0, 'deleted': 0, 'modified': 0, 'unchanged': 2})
        self.assertEqual(before['projectKey'], 'BASE')

    def test_recipe_payload_and_dataset_schema_changes_are_modified(self):
        before = fixture()
        after = fixture(payload='{"steps": [{"type": "filter", "column": "date"}]}')
        dataset = next(value for value in after['model']['objects'].values() if value['kind'] == 'dataset')
        dataset['config']['schema']['columns'].append({'name': 'new', 'type': 'int'})
        result = compare_snapshots(before, after)
        self.assertEqual(result['counts']['modified'], 2)
        self.assertTrue(all(edge['diffStatus'] == 'modified' for edge in result['graph']['edges']))

    def test_union_keeps_deleted_and_added_components_and_connections(self):
        before, after = fixture(), fixture()
        old = next(key for key, value in after['model']['objects'].items() if value['kind'] == 'recipe')
        new = 'new-recipe'
        node = after['model']['objects'].pop(old)
        node.update(id=new, name='new-recipe')
        after['model']['objects'][new] = node
        for value in after['model']['objects'].values():
            value['outputs'] = [new if key == old else key for key in value['outputs']]
        result = compare_snapshots(before, after)
        self.assertEqual(result['counts'], {'added': 1, 'deleted': 1, 'modified': 1, 'unchanged': 0})
        self.assertEqual({edge['diffStatus'] for edge in result['graph']['edges']}, {'added', 'deleted'})
        self.assertEqual(len(result['graph']['nodes']), 3)

    def test_zone_moves_and_explicit_sharing_are_compared(self):
        before, after = fixture(), fixture()
        node = next(iter(after['model']['objects'].values()))
        node.update(zoneId='other', sharedWith=['default'])
        after['model']['zones']['other'] = {'id': 'other', 'name': 'Other', 'color': '#123456', 'isDefault': False}
        result = compare_snapshots(before, after)
        self.assertEqual(result['counts']['modified'], 1)
        self.assertTrue(result['graph']['hasZones'])
        self.assertEqual(next(zone for zone in result['graph']['zones'] if zone['id'] == 'default')['sharedNodeIds'], [node['id']])

    def test_unknown_and_external_objects_explicitly_report_limited_coverage(self):
        flow = {'nodes': [{'id': 'x', 'name': 'External', 'kind': 'dataset'}, {'id': 'y', 'name': 'Train', 'kind': 'ml-recipe'}], 'edges': [], 'zones': []}
        raw = {'x': {'type': 'COMPUTABLE_DATASET', 'ref': 'FOREIGN.data'}, 'y': {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'ref': 'train'}}
        snapshot = build_snapshot(SimpleNamespace(), 'BASE', flow, raw)
        self.assertEqual(len(snapshot['warnings']), 2)
        self.assertEqual({node['coverage'] for node in snapshot['model']['objects'].values()}, {'external-reference', 'graph-only'})

    def test_model_comparison_does_not_mutate_either_snapshot(self):
        before, after = fixture(), fixture('TARGET')
        original = deepcopy((before, after))
        compare_snapshots(before, after)
        self.assertEqual((before, after), original)


if __name__ == '__main__':
    unittest.main()
