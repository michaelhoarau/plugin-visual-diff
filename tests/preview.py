"""Local UI fixture server; uses synthetic projects/commits, never DSS credentials."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
import threading
import uuid
import sys
from copy import deepcopy
from pathlib import Path
from urllib.parse import parse_qs, urlparse

WEBAPP = Path(__file__).resolve().parents[1] / 'webapps/webapp'
RESOURCE = WEBAPP.parents[1] / 'resource'
sys.path.insert(0, str(WEBAPP.parents[1] / 'python-lib'))
from visualflowdiff.comparison import compare_snapshots
JOBS = {}
ARTIFACTS = {}
PREVIEW_LOCK = threading.Lock()


def snapshot_fixture(project_key, source, target=False):
    """Make inspectable synthetic configs with added/deleted/modified examples."""
    if source in ('SPLIT', 'PREPARE', 'MAPPINGS', 'IF_RULE', 'TRAINING'):
        fixture_file = {'SPLIT': 'split_recipe.json', 'PREPARE': 'prepare_recipe.json', 'MAPPINGS': 'prepare_mappings.json', 'IF_RULE': 'prepare_if_rule.json', 'TRAINING': 'training_recipe.json'}[source]
        fixtures = json.loads((Path(__file__).parent / 'fixtures' / fixture_file).read_text())
        recipe = fixtures['after' if target else 'before']
        definition = recipe['config']['definition']
        inputs = [item['ref'] for item in definition['inputs']['main']['items']]
        outputs = [item['ref'] for item in definition['outputs']['main']['items']]
        recipe.update(id=recipe['name'], type='RUNNABLE_RECIPE', subType=definition['type'], coverage='settings',
                      inputs=inputs, outputs=outputs, zoneId='default', sharedWith=[])
        objects = {recipe['id']: recipe}
        for name in inputs + outputs:
            objects[name] = dict(id=name, name=name, kind='model' if source == 'TRAINING' and name in outputs else 'dataset',
                                 type='COMPUTABLE_SAVED_MODEL' if source == 'TRAINING' and name in outputs else 'COMPUTABLE_DATASET',
                                 config={'type': 'Snowflake'}, inputs=[recipe['id']] if name in outputs else [],
                                 outputs=[recipe['id']] if name in inputs else [], zoneId='default', sharedWith=[])
        return {'schemaVersion': 1, 'projectKey': project_key, 'warnings': [], 'model': {'objects': objects, 'zones': {}}}
    flow = deepcopy(images_fixture() if source == 'IMAGES' else flow_fixture())
    if source == 'EMPTY':
        flow.update(nodes=[], edges=[])
    if target and flow['nodes']:
        removed = 'embedded-attachments' if source == 'IMAGES' else 'web_new_customers_filtered'
        flow['nodes'] = [node for node in flow['nodes'] if node['id'] != removed]
        flow['edges'] = [edge for edge in flow['edges'] if removed not in (edge['source'], edge['target'])]
        upstream = 'documents-metadata' if source == 'IMAGES' else 'revenue_prediction_copy'
        zone = 'images' if source == 'IMAGES' else 'score'
        flow['nodes'].append({'id': 'prediction_rules', 'name': 'prediction_rules', 'kind': 'dataset', 'zoneId': zone})
        flow['edges'].append({'source': upstream, 'target': 'prediction_rules'})
    objects = {}
    for node in flow['nodes']:
        config = {'schema': {'columns': [{'name': 'id', 'type': 'string'}]}} if node['kind'] == 'dataset' else {
            'payload': {'steps': [{'type': 'filter', 'condition': 'value > 10' if target and node['kind'] == 'recipe' else 'value > 0'}]}}
        if node['kind'] == 'dataset':
            config['type'] = 'CustomConnector' if node['id'] == 'prediction_rules' else 'Filesystem'
        elif node['kind'] in ('recipe', 'ml-recipe'):
            recipe_type = ('prediction_training' if 'train' in node['id'] else 'prediction_scoring') if node['kind'] == 'ml-recipe' else (
                'filter' if 'filter' in node['id'] else 'shaker')
            config['definition'] = {'type': recipe_type}
            if node['id'] == 'copy_predictions':
                config['definition']['type'] = 'python'
                config['payload'] = ('import dataiku\n\n'
                                     'def copy_predictions():\n'
                                     '    source = dataiku.Dataset("revenue_prediction")\n'
                                     '    frame = source.get_dataframe()\n'
                                     + ('    frame = frame.dropna()\n' if target else '')
                                     + '    target = dataiku.Dataset("revenue_prediction_copy")\n'
                                     '    target.write_with_schema(frame)\n\n'
                                     'copy_predictions()\n')
        elif node['kind'] == 'model':
            config['modelType'] = 'MLflow'
        objects[node['id']] = dict(node, type=node['kind'], coverage='settings', config=config, inputs=[], outputs=[], sharedWith=[])
    for edge in flow['edges']:
        objects[edge['source']]['outputs'].append(edge['target'])
        objects[edge['target']]['inputs'].append(edge['source'])
    zones = {zone['id']: {key: zone[key] for key in ('id', 'name', 'color', 'isDefault') if key in zone} for zone in flow.get('zones', [])}
    return {'schemaVersion': 1, 'projectKey': project_key, 'warnings': [], 'model': {'objects': objects, 'zones': zones}}


def flow_fixture():
    """Return a synthetic branched Flow containing every requested node shape."""
    kinds = {
        'web_new_customers': 'dataset', 'prepare_new_customers': 'recipe',
        'web_new_customers_enriched': 'dataset', 'filter_customers': 'recipe',
        'web_new_customers_filtered': 'dataset', 'web_last_month': 'dataset',
        'crm_last_month': 'dataset', 'prepare_history': 'recipe',
        'web_last_month_enriched': 'dataset', 'train_revenue_model': 'ml-recipe',
        'revenue_model': 'model', 'score_customers': 'ml-recipe',
        'revenue_prediction': 'dataset', 'copy_predictions': 'recipe',
        'revenue_prediction_copy': 'dataset', 'crm_history': 'dataset',
        'web_history': 'dataset', 'join_history': 'recipe', 'combined_history': 'dataset',
    }
    links = [
        ('web_new_customers', 'prepare_new_customers'), ('prepare_new_customers', 'web_new_customers_enriched'),
        ('web_new_customers_enriched', 'filter_customers'), ('filter_customers', 'web_new_customers_filtered'),
        ('web_last_month', 'prepare_history'), ('crm_last_month', 'prepare_history'),
        ('prepare_history', 'web_last_month_enriched'), ('web_last_month_enriched', 'train_revenue_model'),
        ('train_revenue_model', 'revenue_model'), ('revenue_model', 'score_customers'),
        ('web_new_customers_enriched', 'score_customers'), ('score_customers', 'revenue_prediction'),
        ('revenue_prediction', 'copy_predictions'), ('copy_predictions', 'revenue_prediction_copy'),
        ('crm_history', 'join_history'), ('web_history', 'join_history'), ('join_history', 'combined_history'),
    ]
    ownership = {name: 'default' for name in kinds}
    for name in ['prepare_new_customers', 'web_new_customers_enriched', 'filter_customers',
                 'web_new_customers_filtered', 'prepare_history', 'web_last_month_enriched',
                 'join_history', 'combined_history']:
        ownership[name] = 'prepare'
    for name in ['train_revenue_model', 'revenue_model']:
        ownership[name] = 'train'
    for name in ['score_customers', 'revenue_prediction', 'copy_predictions', 'revenue_prediction_copy']:
        ownership[name] = 'score'
    zones = []
    for zone_id, name, color in [('default', 'Default', '#D1D8DA'), ('prepare', 'Prepare', '#27a9df'),
                                 ('train', 'Train', '#25b466'), ('score', 'Score', '#fbbf32')]:
        references = sorted({source for source, target in links
                             if ownership[target] == zone_id and ownership[source] != zone_id})
        zones.append({'id': zone_id, 'name': name, 'color': color, 'isDefault': zone_id == 'default',
                      'nodeIds': sorted(key for key in kinds if ownership[key] == zone_id),
                      'sharedNodeIds': [], 'unresolvedItems': [], 'references': [
                          {'appearanceId': json.dumps([zone_id, key], separators=(',', ':')),
                           'nodeId': key, 'ownerZoneId': ownership[key], 'reasons': ['dependency']}
                          for key in references]})
    return {'hasZones': True, 'zones': zones,
            'nodes': [{'id': name, 'name': name, 'kind': kind, 'zoneId': ownership[name]} for name, kind in kinds.items()],
            'edges': [{'source': source, 'target': target} for source, target in links]}


def images_fixture():
    """Reproduce an external attachments-metadata input in an image analysis zone."""
    kinds = {
        'attachments-metadata': 'dataset', 'attachments-documents': 'dataset',
        'compute_images-metadata': 'recipe', 'documents-metadata': 'dataset',
        'compute_embedded-attachments': 'recipe', 'embedded-attachments': 'dataset',
        'attachments-documents_embedded_images': 'dataset',
    }
    external = {'attachments-metadata', 'attachments-documents'}
    return {
        'hasZones': True,
        'nodes': [{'id': key, 'name': key, 'kind': kind, 'zoneId': 'attachments' if key in external else 'images'} for key, kind in kinds.items()],
        'zones': [
            {'id': 'attachments', 'name': 'Attachments', 'color': '#27a9df'},
            {'id': 'images', 'name': 'Images and documents analyzer', 'color': '#8e24aa', 'sharedNodeIds': sorted(external)},
        ],
        'edges': [{'source': source, 'target': target} for source, target in [
            ('attachments-metadata', 'compute_images-metadata'),
            ('compute_images-metadata', 'documents-metadata'),
            ('attachments-documents', 'compute_embedded-attachments'),
            ('documents-metadata', 'compute_embedded-attachments'),
            ('compute_embedded-attachments', 'embedded-attachments'),
            ('compute_embedded-attachments', 'attachments-documents_embedded_images'),
        ]],
    }


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        """Simulate preparation only; never create real projects in the preview."""
        path = urlparse(self.path).path
        if path not in ('/api/prepare-comparison', '/api/cleanup-projects'):
            self.send_error(404)
            return
        selected = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if path == '/api/cleanup-projects' and selected.get('confirmed') is not True:
            self.send_error(400, 'Explicit confirmation required')
            return
        with PREVIEW_LOCK:
            if path == '/api/cleanup-projects':
                result = {'deletedProjects': sorted({artifact['projectKey'] for artifact in ARTIFACTS.values()}),
                          'alreadyMissingProjects': [], 'removedRecords': len(ARTIFACTS), 'failures': []}
                ARTIFACTS.clear()
                job_id = uuid.uuid4().hex
                JOBS[job_id] = {'cleanupResult': result, 'polls': 0}
            else:
                artifacts = {}
                for side in ('baseline', 'target'):
                    ref = selected[side]
                    identity = (ref['projectKey'], ref['commitId'])
                    reused = identity in ARTIFACTS
                    ARTIFACTS.setdefault(identity, {
                        'sourceProjectKey': ref['projectKey'], 'commitId': ref['commitId'],
                        'projectKey': 'SNAP_' + ref['projectKey'] + '_' + ref['commitId'][:8],
                        'branchName': 'vfd_' + ref['commitId'][:24], 'archived': True,
                    })
                    artifacts[side] = dict(ARTIFACTS[identity], reused=reused)
                job_id = uuid.uuid4().hex
                JOBS[job_id] = {'artifacts': artifacts, 'polls': 0}
        self.send_response(202)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'jobId': job_id, 'state': 'preparing'}).encode())

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        mime = 'application/json'
        status = 200
        if url.path == '/':
            mime = 'text/html'
            content = ('<!DOCTYPE html><html><head><base href="/plugins/visual-flow-diff/webapps/webapp/"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Flow Diff · Test preview</title><link rel="stylesheet" href="/style.css"></head><body>'
                       + (WEBAPP / 'body.html').read_text()
                       + '<script>function getWebAppBackendUrl(path) { return "/api/" + path; }</script><script src="/app.js"></script></body></html>')
        elif url.path in ('/app.js', '/style.css'):
            mime = 'text/javascript' if url.path.endswith('.js') else 'text/css'
            content = (WEBAPP / url.path[1:]).read_text()
        elif url.path in ('/plugins/visual-flow-diff/resource/flow-layout.js',
                           '/plugins/visual-flow-diff/resource/flow-comparison.js',
                           '/plugins/visual-flow-diff/resource/vendor/elk.bundled.js',
                           '/plugins/visual-flow-diff/resource/vendor/elk-worker.min.js'):
            mime = 'text/javascript'
            content = (RESOURCE / url.path.split('/resource/', 1)[1]).read_text()
        elif url.path.startswith('/plugins/visual-flow-diff/resource/icons/') and Path(url.path).suffix in ('.svg', '.png'):
            icon = RESOURCE / 'icons' / Path(url.path).name
            mime = 'image/svg+xml' if icon.suffix == '.svg' else 'image/png'
            status, content = (200, icon.read_bytes()) if icon.is_file() else (404, '')
        elif url.path == '/api/projects':
            content = json.dumps({'projects': [{'key': 'PARENT', 'name': 'Customer analytics'}, {'key': 'BRANCH', 'name': 'Customer analytics · feature branch'}, {'key': 'IMAGES', 'name': 'Images and documents'}, {'key': 'SPLIT', 'name': 'Split recipe comparison'}, {'key': 'PREPARE', 'name': 'Prepare recipe comparison'}, {'key': 'TRAINING', 'name': 'Model training comparison'}, {'key': 'MAPPINGS', 'name': 'Prepare mappings comparison'}, {'key': 'IF_RULE', 'name': 'Visual If Rule comparison'}, {'key': 'EMPTY', 'name': 'Empty project'}, {'key': 'DENIED', 'name': 'Unavailable project'}], 'currentProjectKey': 'PARENT'})
        elif url.path == '/api/branches':
            project = query.get('projectKey', [''])[0]
            if project == 'DENIED':
                status = 502
                content = json.dumps({'error': 'Unable to load project branches. Check project access and retry.'})
            else:
                content = json.dumps({'branches': [{'key': 'BRANCH', 'name': 'Customer analytics · feature branch', 'branch': 'feature/segmentation'}] if project == 'PARENT' else [], 'incomplete': False})
        elif url.path.startswith('/api/preparation/'):
            with PREVIEW_LOCK:
                job = JOBS.get(url.path.rsplit('/', 1)[-1])
                if job is None:
                    status, content = 404, json.dumps({'error': 'Unknown preview job.'})
                else:
                    job['polls'] += 1
                    if 'cleanupResult' in job:
                        content = json.dumps({'state': 'preparing' if job['polls'] == 1 else 'ready',
                                              'message': 'Cleaning up comparison projects…' if job['polls'] == 1 else 'Cleanup finished.',
                                              'result': job['cleanupResult']})
                    else:
                        content = json.dumps({'state': 'preparing' if job['polls'] == 1 else 'ready',
                                          'message': 'Preparing archived comparison projects…' if job['polls'] == 1 else 'Comparison projects are ready and archived.',
                                              'artifacts': {} if job['polls'] == 1 else job['artifacts']})
        elif url.path == '/api/comparison':
            keys = [query.get(field, [''])[0] for field in ('baselineProjectKey', 'targetProjectKey')]
            with PREVIEW_LOCK:
                sources = [next((ref['sourceProjectKey'] for ref in ARTIFACTS.values() if ref['projectKey'] == key), key) for key in keys]
            content = json.dumps(compare_snapshots(snapshot_fixture(keys[0], sources[0]), snapshot_fixture(keys[1], sources[1], target=True)))
        elif url.path == '/api/registry-membership':
            ids = query.get('commitIds', [''])[0].split(',')
            registered = hashlib.sha1('Add transaction enrichment'.encode()).hexdigest()
            content = json.dumps({'registeredCommitIds': [registered] if registered in ids else []})
        elif url.path == '/api/commits':
            project = query.get('projectKey', [''])[0]
            older = bool(query.get('startCommit'))
            if project == 'DENIED':
                status = 502
                content = json.dumps({'error': 'Unable to load commits. Check project access and retry.'})
            else:
                messages = ['Refine customer segmentation', 'Add transaction enrichment', 'Create initial Flow'] if not older else ['Import source datasets']
                content = json.dumps({'commits': [] if project == 'EMPTY' else [{'id': hashlib.sha1(message.encode()).hexdigest(), 'message': message, 'author': 'Alex Martin', 'timestamp': '2026-11-03T10:20:00Z'} for i, message in enumerate(messages)], 'nextCommit': None if older or project == 'EMPTY' else 'older-page'})
        else:
            status, content = 404, '{}'
        self.send_response(status)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.end_headers()
        self.wfile.write(content if isinstance(content, bytes) else content.encode())


if __name__ == '__main__':
    print('Synthetic UI preview: http://127.0.0.1:8765', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8765), Handler).serve_forever()
