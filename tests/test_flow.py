"""Exercise Flow normalization without Flask or the Dataiku runtime."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-lib'))
from visualflowdiff.flow import normalize_flow, normalize_zones


class FlowTest(unittest.TestCase):
    def normalize_zones(self, nodes, zones):
        return normalize_zones('PARENT', nodes, normalize_flow(nodes, {}), zones)

    def test_no_zones_assigns_all_nodes_to_default(self):
        response = self.normalize_zones({'input': {'type': 'COMPUTABLE_DATASET'}}, [])
        self.assertFalse(response['hasZones'])
        self.assertEqual(response['nodes'][0]['zoneId'], 'default')
        self.assertEqual(response['zones'][0]['nodeIds'], ['input'])
        self.assertEqual(response['zones'][0]['references'], [])

    def test_zones_preserve_default_metadata_empty_zones_and_unassigned_items(self):
        response = self.normalize_zones({'input': {'type': 'COMPUTABLE_DATASET'}}, [
            {'id': 'default', 'name': 'Unassigned', 'color': '#abcdef'},
            {'id': 'empty', 'name': 'Empty', 'color': '#123456'},
        ])
        default, empty = response['zones']
        self.assertTrue(default['isDefault'])
        self.assertEqual(default['name'], 'Unassigned')
        self.assertEqual(default['color'], '#abcdef')
        self.assertEqual(default['nodeIds'], ['input'])
        self.assertEqual(empty['nodeIds'], [])
        self.assertEqual(empty['references'], [])

    def test_shared_and_dependency_references_do_not_duplicate_or_move_nodes(self):
        nodes = {
            'input': {'type': 'COMPUTABLE_DATASET', 'successors': ['recipe']},
            'recipe': {'type': 'RUNNABLE_RECIPE'},
            'unused': {'type': 'COMPUTABLE_DATASET'},
        }
        zones = [{'id': 'prepare', 'name': 'Prepare', 'items': [
            {'objectType': 'RECIPE', 'objectId': 'recipe'}], 'shared': [
            {'objectType': 'DATASET', 'objectId': 'input'},
            {'objectType': 'DATASET', 'objectId': 'input'},
            {'objectType': 'DATASET', 'objectId': 'unused'}]}]
        originals = deepcopy((nodes, zones))
        response = self.normalize_zones(nodes, zones)
        default, prepare = response['zones']
        self.assertEqual(len(response['nodes']), 3)
        self.assertEqual(default['nodeIds'], ['input', 'unused'])
        self.assertEqual(prepare['nodeIds'], ['recipe'])
        self.assertEqual(prepare['sharedNodeIds'], ['input', 'unused'])
        self.assertEqual(prepare['references'], [
            {'appearanceId': '["prepare","input"]', 'nodeId': 'input', 'ownerZoneId': 'default', 'reasons': ['dependency', 'shared']},
            {'appearanceId': '["prepare","unused"]', 'nodeId': 'unused', 'ownerZoneId': 'default', 'reasons': ['shared']},
        ])
        self.assertEqual(response['edges'], [{'source': 'input', 'target': 'recipe'}])
        self.assertEqual((nodes, zones), originals)

    def test_zone_membership_distinguishes_object_types_and_foreign_projects(self):
        nodes = {
            'local-data': {'ref': 'same', 'type': 'COMPUTABLE_DATASET'},
            'foreign-data': {'ref': 'OTHER.same', 'type': 'COMPUTABLE_DATASET'},
            'local-recipe': {'ref': 'same', 'type': 'RUNNABLE_RECIPE'},
        }
        response = self.normalize_zones(nodes, [
            {'id': 'local', 'items': [{'objectType': 'DATASET', 'projectKey': 'PARENT', 'objectId': 'PARENT.same'}]},
            {'id': 'foreign', 'items': [{'objectType': 'DATASET', 'projectKey': 'OTHER', 'objectId': 'same'}]},
            {'id': 'recipe', 'items': [{'objectType': 'RECIPE', 'objectId': 'same'}]},
        ])
        self.assertEqual({node['id']: node['zoneId'] for node in response['nodes']}, {
            'local-data': 'local', 'foreign-data': 'foreign', 'local-recipe': 'recipe'})

    def test_implicit_recipe_follows_output_and_missing_metadata_stays_visible(self):
        nodes = {
            'input': {'type': 'COMPUTABLE_DATASET', 'successors': ['implicit']},
            'implicit': {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'successors': ['model']},
            'model': {'type': 'COMPUTABLE_SAVED_MODEL'},
        }
        response = self.normalize_zones(nodes, [{'id': 'train', 'items': [
            {'objectType': 'SAVED_MODEL', 'objectId': 'model'},
            {'objectType': 'DATASET', 'objectId': 'deleted'},
        ]}])
        train = next(zone for zone in response['zones'] if zone['id'] == 'train')
        self.assertEqual(train['nodeIds'], ['implicit', 'model'])
        self.assertEqual(train['references'][0]['nodeId'], 'input')
        self.assertEqual(train['unresolvedItems'], [{'source': 'items', 'objectType': 'DATASET', 'projectKey': 'PARENT', 'objectId': 'deleted'}])
        self.assertEqual(len(response['nodes']), 3)

    def test_zone_normalization_is_stable_when_settings_order_changes(self):
        nodes = {'a': {'type': 'COMPUTABLE_DATASET'}, 'b': {'type': 'COMPUTABLE_DATASET'}}
        zones = [{'id': key, 'name': key, 'items': [{'objectType': 'DATASET', 'objectId': key}]} for key in ['a', 'b']]
        first = self.normalize_zones(nodes, zones)
        second = self.normalize_zones(dict(reversed(list(nodes.items()))), list(reversed(zones)))
        self.assertEqual(first['zones'], second['zones'])


    def test_implicit_recipe_chains_follow_output_zone(self):
        nodes = {
            'first': {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'successors': ['second']},
            'second': {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'successors': ['model']},
            'model': {'type': 'COMPUTABLE_SAVED_MODEL'},
        }
        zones = [{'id': 'train', 'items': [{'objectType': 'SAVED_MODEL', 'objectId': 'model'}]}]
        for ordered_nodes in (nodes, dict(reversed(list(nodes.items())))):
            with self.subTest(order=list(ordered_nodes)):
                response = self.normalize_zones(ordered_nodes, zones)
                self.assertEqual({node['zoneId'] for node in response['nodes']}, {'train'})

    def test_cycles_outputless_and_mixed_zone_recipes_default_without_hanging(self):
        nodes = {
            'cycle-a': {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'successors': ['cycle-b']},
            'cycle-b': {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'successors': ['cycle-a']},
            'outputless': {'type': 'RUNNABLE_IMPLICIT_RECIPE'},
            'mixed': {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'successors': ['left', 'right']},
            'left': {'type': 'COMPUTABLE_DATASET'},
            'right': {'type': 'COMPUTABLE_DATASET'},
        }
        zones = [{'id': key, 'items': [{'objectType': 'DATASET', 'objectId': key}]}
                 for key in ('left', 'right')]
        response = self.normalize_zones(nodes, zones)
        self.assertEqual({node['id']: node['zoneId'] for node in response['nodes']}, {
            'cycle-a': 'default', 'cycle-b': 'default', 'outputless': 'default',
            'mixed': 'default', 'left': 'left', 'right': 'right'})

    def test_explicit_implicit_recipe_ownership_overrides_output_zone(self):
        nodes = {
            'recipe': {'type': 'RUNNABLE_IMPLICIT_RECIPE', 'successors': ['model']},
            'model': {'type': 'COMPUTABLE_SAVED_MODEL'},
        }
        zones = [
            {'id': 'explicit', 'items': [{'objectType': 'RECIPE', 'objectId': 'recipe'}]},
            {'id': 'output', 'items': [{'objectType': 'SAVED_MODEL', 'objectId': 'model'}]},
        ]
        response = self.normalize_zones(nodes, zones)
        self.assertEqual({node['id']: node['zoneId'] for node in response['nodes']}, {
            'recipe': 'explicit', 'model': 'output'})

    def test_conflicting_explicit_owners_are_rejected(self):
        zones = [{'id': key, 'items': [{'objectType': 'DATASET', 'objectId': 'input'}]}
                 for key in ('first', 'second')]
        with self.assertRaisesRegex(ValueError, 'multiple zones'):
            self.normalize_zones({'input': {'type': 'COMPUTABLE_DATASET'}}, zones)


if __name__ == '__main__':
    unittest.main()
