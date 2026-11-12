"""Serve project selection, archived comparison preparation, and Flow data.

DSS injects the Flask ``app`` into this module. Each route uses the end user's
browser ticket for project access. The selected registry dataset is accessed
as the configured backend identity. API failures are
logged server-side and returned as generic messages without exception details.
"""
import dataiku
import dataikuapi
import logging
import re
import threading

from flask import jsonify, request
from dataiku.customwebapp import get_webapp_config

from visualflowdiff.preparation import PreparationError, PreparationJobs, resolve_selection
from visualflowdiff.registry import Registry
from visualflowdiff.flow import read_project_flow
from visualflowdiff.comparison import build_snapshot, compare_snapshots


logger = logging.getLogger(__name__)
preparation_jobs = PreparationJobs()
membership_registry_cache = {}
membership_registry_lock = threading.Lock()


class ViewerAuthenticationError(Exception):
    """Expose a safe, actionable message when DSS cannot authenticate the end user or authorize end user impersonation."""

    def __init__(self, message, status):
        """Initialize a viewer authentication error.

        Args:
            message: Safe authentication message suitable for display to the end user.
            status: HTTP status code to return for the authentication failure.
        """
        super().__init__(message)
        self.status = status


def error_response(error, message):
    """Distinguish end user authentication failures from upstream API failures.

    Args:
        error: Caught exception. Recognized authentication and preparation errors
            supply their own safe message and HTTP status.
        message: Generic public message returned for other exceptions, whose
            details must not be exposed to the end user.
    """
    if isinstance(error, (ViewerAuthenticationError, PreparationError)):
        return jsonify(error=str(error)), error.status
    
    return jsonify(error=message), 502


def registry_dataset_location(config):
    """Validate the selected registry and resolve its hosting project.

    Args:
        config: Webapp configuration mapping whose registry_dataset value names
            the selected dataset in the hosting project.
    """
    name = config.get('registry_dataset')
    if not isinstance(name, str) or not name.strip():
        raise PreparationError('Select the comparison registry dataset in the webapp settings before preparing projects.', 503)
    
    return dataiku.default_project_key(), name.strip()


def open_registry(project_key, name, *, initialize=True):
    """Open the registry as the backend identity, optionally initializing it.

    Args:
        project_key: Key of the DSS project containing the registry dataset.
        name: Registry dataset name, already validated and stripped of whitespace.
        initialize: Whether to initialize and verify registry storage and schema.
            Defaults to True; False opens existing metadata for read-only lookups.
    """
    dataset = dataiku.Dataset(name, project_key=project_key)

    return Registry(dataset, dataiku.SQLExecutor2(dataset=dataset), initialize=initialize)


def preparation_registry(config):
    """Open and initialize the selected backend registry for preparation.

    Args:
        config: Webapp configuration mapping containing the registry_dataset
            selection to open and initialize.
    """
    location = registry_dataset_location(config)

    try:
        return open_registry(*location)
    
    except PreparationError:
        raise
    
    except Exception as error:
        raise PreparationError('Unable to access the registry dataset as the webapp backend user. Check its configuration and permissions.', 503) from error


@app.route('/registry-membership', methods=['GET'])
def registry_membership():
    """Look up registry membership badges independently of history, reusing metadata. After
    each commits page loads, this route is automatically triggered to load the badges for 
    the visible commits. The registry dataset is opened once per project and cached.

    End user access is checked on every request. Only registry metadata/executor
    are cached; membership results remain fresh after preparation and cleanup.
    The lock also prevents concurrent use of the cached SQL executor.

    Query parameters:
        projectKey: Required source project key whose access is checked.
        commitIds: Comma-separated list of 1 to 50 full, 40-character commit IDs.
    """
    project_key = request.args.get('projectKey', '').strip()
    commit_ids = request.args.get('commitIds', '').split(',')
    if (not project_key or not 1 <= len(commit_ids) <= 50 or
            any(not re.fullmatch(r'[0-9a-fA-F]{40}', sha) for sha in commit_ids)):
        
        return jsonify(error='A project key and up to 50 full commit IDs are required.'), 400
    
    try:
        # Verify end user access to this project before returning registry membership:
        client = browser_client()
        client.get_project(project_key).get_settings()

        # Cache key is a tuple of (project_key, dataset_name) to avoid
        # re-opening the registry for every membership check:
        cache_key = registry_dataset_location(get_webapp_config())

        # We can have multiple threads checking membership at the same time. For instance, 
        # we have the list of baseline commmits and the list of comparison commits. Each 
        # of these lists can have multiple commits and we check the membership for each 
        # commit in a separate thread. So we need to lock the access to the cache to avoid 
        # race conditions.
        with membership_registry_lock:
            try:
                # Reuse metadata and the SQL executor across commit pages to avoid
                # repeated dataset/schema lookups. Configuration changes restart
                # the backend and clear this cache; membership results stay fresh.
                reader = membership_registry_cache.get(cache_key)
                if reader is None:
                    reader = open_registry(*cache_key, initialize=False)
                    membership_registry_cache.clear()
                    membership_registry_cache[cache_key] = reader

                registered = reader.registered_commits(client.host, project_key, commit_ids)

            except Exception:
                membership_registry_cache.pop(cache_key, None)
                raise

        return jsonify(registeredCommitIds=sorted(registered))
    
    except Exception as error:
        logger.warning('Unable to check registry membership for project %s', project_key, exc_info=True)
        return error_response(error, 'Registry status unavailable. Check registry dataset settings and access, then reload commits.')


@app.route('/prepare-comparison', methods=['POST'])
def prepare_comparison():
    """Start end user-owned preparation for both selected source/commit pairs. This route
    is taken when the user clicks the "Confirm selection" button after selecting both commits.
    It also reruns when they refresh the flow.

    Accept only an explicit JSON request, then validate both inputs before any
    project creation. Return a job ID immediately; polling reports progress and
    partial results. Project mutations run using the end user's DSS API ticket.

    JSON body:
        baseline: Object containing the source projectKey and selected commitId.
        target: Object containing the target projectKey and selected commitId.

    Request headers:
        Content-Type: Must identify a JSON body.
        X-Requested-With: Must be XMLHttpRequest.
    """
    if not request.is_json or request.headers.get('X-Requested-With') != 'XMLHttpRequest':
        return jsonify(error='Preparation requires an explicit JSON webapp request.'), 400
    
    try:
        client = browser_client()
        config = get_webapp_config()
        registry = preparation_registry(config)

        # Get both the baseline and target project/commit pairs, 
        # validating their format and existence in the same step. 
        # This avoids creating a baseline project if the target 
        # is invalid for instance:
        refs = resolve_selection(client, request.get_json(silent=True))
        owner = client.get_auth_info()['authIdentifier']

        # Start the preparation job, which runs asynchronously 
        # and returns a job ID for polling:
        job_id = preparation_jobs.start(client, owner, registry, refs)

        return jsonify(jobId=job_id, state='preparing'), 202
    
    except Exception as error:
        logger.exception('Unable to start comparison preparation')
        return error_response(error, 'Unable to prepare the comparison. Check project access, webapp settings, and backend logs.')


@app.route('/preparation/<job_id>', methods=['GET'])
def preparation_status(job_id):
    """Read preparation progress only as the DSS end user who started the job. This runs automatically
    while preparation of the comparison flow or the cleanup jobs run.

    Args:
        job_id: Preparation or cleanup job ID supplied through the route URL;
            access is restricted to the end user who started the job.
    """
    try:
        owner = browser_client().get_auth_info()['authIdentifier']
        return jsonify(**preparation_jobs.get(job_id, owner))
    
    except Exception as error:
        return error_response(error, 'Unable to read comparison preparation status. Sign in and retry.')


@app.route('/cleanup-projects', methods=['POST'])
def cleanup_projects():
    """Start confirmed cleanup of registered copies using the end user's rights. This route is taken
    when the user clieks the "Delete registered comparison projects" button after confirming the action.

    Args:
        None. Reads the JSON confirmation and browser headers from Flask's request.

    JSON body:
        confirmed: Must be the boolean True to authorize deletion.

    Request headers:
        Content-Type: Must identify a JSON body.
        X-Requested-With: Must be XMLHttpRequest.
    """
    if not request.is_json or request.headers.get('X-Requested-With') != 'XMLHttpRequest':
        return jsonify(error='Cleanup requires an explicit JSON webapp request.'), 400
    
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or payload.get('confirmed') is not True:
        return jsonify(error='Confirm deletion of registered comparison projects first.'), 400
    
    try:
        client = browser_client()
        owner = client.get_auth_info()['authIdentifier']
        registry = preparation_registry(get_webapp_config())
        job_id = preparation_jobs.start_cleanup(client, owner, registry, dataiku.default_project_key())

        return jsonify(jobId=job_id, state='preparing'), 202
    
    except Exception as error:
        logger.exception('Unable to start comparison project cleanup')
        return error_response(error, 'Unable to start cleanup. Check registry access and project administration rights.')


@app.route('/comparison', methods=['GET'])
def comparison():
    """Return normalized snapshots of both projects and a combined Flow graph showing changes from 
    baseline to target. This is run automatically after both revision copies are ready. This fetches 
    the comparison graph and the object differences.

    Args:
        None. Reads query parameters and browser headers from Flask's request.

    Query parameters:
        baselineProjectKey: Required prepared baseline project key.
        targetProjectKey: Required prepared target project key.
    """
    baseline = request.args.get('baselineProjectKey', '').strip()
    target = request.args.get('targetProjectKey', '').strip()
    if not baseline or not target:
        return jsonify(error='Both prepared project keys are required.'), 400
    
    try:
        client = browser_client()
        snapshots = []
        for key in (baseline, target):
            project = client.get_project(key)
            graph, raw_nodes = read_project_flow(project, key)
            snapshots.append(build_snapshot(project, key, graph, raw_nodes))

        return jsonify(**compare_snapshots(*snapshots))
    
    except Exception as error:
        logger.exception('Unable to compare prepared projects %s and %s', baseline, target)
        return error_response(error, 'Unable to compare the prepared project configurations. Check access to both projects and their Flow objects, then retry.')


def browser_client():
    """Create a DSS API client authenticated as the current webapp end user.

    Must run inside a Flask request context. The backend's run-as user needs
    DSS webapp impersonation permission for the end user. Authentication errors
    propagate to the route; there is no fallback to the run-as user's access.

    Returns:
        dataikuapi.DSSClient: Client using a ticket derived from browser headers.
    """
    backend_client = dataiku.api_client()
    try:
        ticket = backend_client.get_ticket_from_browser_headers(dict(request.headers))

    except Exception as error:
        # DSS wraps the Java exception type in its Python API exception message.
        if 'NotAuthenticatedException' in str(error):
            raise ViewerAuthenticationError(
                'DSS could not identify your browser session. Sign in to DSS and reload the webapp. '
                'If this persists, check whether browser or proxy settings block DSS session cookies.', 401) from error
        
        if 'DKUSecurityException' in str(error) or 'UnauthorizedException' in str(error):
            raise ViewerAuthenticationError(
                'DSS denied end user impersonation. Ask an administrator to check the webapp run-as '
                'user\'s Impersonation in webapps permission.', 403) from error
        
        raise

    return dataikuapi.DSSClient(backend_client.host, internal_ticket=ticket)


def selectable_projects(client):
    """Exclude archived projects from selection using DSS's lifecycle status.

    Args:
        client: Viewer-authenticated DSS API client used to list accessible projects.
    """
    return [project for project in client.list_projects() if project.get('projectStatus') != 'Archived']


@app.route('/projects', methods=['GET'])
def projects():
    """Handle GET /projects with the viewer's accessible non-archived choices. This action
    is called when the WebApp is opened or when the user clicks the "Retry loading projects"
    button. It's also called when finishing cleanup.

    Args:
        None. Reads browser headers from Flask's request; no query parameters
            or JSON body are required.

    Returns:
        flask.Response: JSON containing ``projects`` (key/name pairs sorted by
        case-insensitive name, then key) and ``currentProjectKey``.
        On authentication or API failure, returns an error response and HTTP 502.
    """
    try:
        client = browser_client()
        entries = [
            {
                'key': project['projectKey'],
                'name': project.get('name') or project['projectKey']
            }
            for project in selectable_projects(client)
        ]
        entries.sort(key=lambda project: (project['name'].casefold(), project['key']))

        return jsonify(projects=entries, currentProjectKey=dataiku.default_project_key())

    except Exception as error:
        logger.exception('Unable to list projects for the webapp viewer')

        return error_response(error, 'Unable to load projects. Check your DSS access and the webapp impersonation settings.')


@app.route('/branches', methods=['GET'])
def branches():
    """List accessible non-archived branches of the requested baseline. This route is
    taken when the user switches to cross-project comparison mode. In this case, the use
    selects a baseline project and a comparison one that must be in the same Git family.
    Only the baseline's direct branches are returned but related projects with the same
    origin are excluded.

    Args:
        None. Reads query parameters and browser headers from Flask's request.

    Query parameters:
        projectKey: Required baseline project key from the viewer's project list.

    Returns:
        flask.Response: JSON containing sorted ``branches`` (key/name pairs and
        their current Git branch) and an ``incomplete`` flag if some projects'
        Git status could not be read. Such projects are excluded rather than
        treated as related. Relationships use DSS ``originProjectKey``, not
        project names; only direct branches of the baseline are included.
        Missing input returns HTTP 400, an unavailable baseline HTTP 404, and
        authentication or project-list failure HTTP 502.
    """
    project_key = request.args.get('projectKey', '').strip()
    if not project_key:
        return jsonify(error='A baseline project key is required.'), 400

    try:
        client = browser_client()
        available = selectable_projects(client)
        if not any(project['projectKey'] == project_key for project in available):
            return jsonify(error='The baseline project is unavailable.'), 404

        entries = []
        incomplete = False
        for project in available:
            key = project['projectKey']
            if key == project_key:
                continue

            try:
                status = client.get_project(key).get_project_git().get_status()

            except Exception:
                logger.warning('Unable to read branch relationship for project %s', key, exc_info=True)
                incomplete = True
                continue

            if status.get('originProjectKey') == project_key:
                entries.append({
                    'key': key, 
                    'name': project.get('name') or key,
                    'branch': status.get('currentBranch')
                })

        entries.sort(key=lambda project: (project['name'].casefold(), project['key']))

        return jsonify(branches=entries, incomplete=incomplete)

    except Exception as error:
        logger.exception('Unable to list branch projects for baseline %s', project_key)
        return error_response(error, 'Unable to load project branches. Check project access and retry.')


@app.route('/commits', methods=['GET'])
def commits():
    """Handle GET /commits with one page of a project's Git history. This route is
    taken after a project is selected (either automatically when the WebApp opens 
    or manually when the user selects another project). Also taken when loading
    older commits or retrying a failed commit load.

    Args:
        None. Reads query parameters and browser headers from Flask's request.

    Query parameters:
        projectKey: Required, nonblank DSS project key.
        startCommit: Optional pagination cursor from a previous response.

    Returns:
        flask.Response: JSON containing up to 50 ``commits`` in API history
        order and a nullable ``nextCommit`` cursor. Each commit includes its
        full ``id``, message, author, timestamp, and available tag names.
        Registry membership is fetched separately to keep history loading fast.
        Invalid input returns an
        error response and HTTP 400; authentication or API failure returns
        an error response and HTTP 502.
    """
    project_key = request.args.get('projectKey', '').strip()

    if not project_key:
        return jsonify(error='A project key is required.'), 400

    try:
        client = browser_client()
        history = client.get_project(project_key).get_project_git().log(
            start_commit=request.args.get('startCommit') or None, count=50
        )

        entries = [
            {
                'id': entry['commit'], 
                'message': entry.get('message') or '(No commit message)',
                'author': entry.get('author') or 'Unknown author',
                'timestamp': entry.get('timestamp'),
                'tags': [tag.get('shortName') or tag.get('name') for tag in (entry.get('tags') or [])
                         if isinstance(tag, dict) and (tag.get('shortName') or tag.get('name'))]
            }
            for entry in history.get('entries', [])
        ]

        return jsonify(commits=entries, nextCommit=history.get('nextCommit'))

    except Exception as error:
        logger.exception('Unable to load commit history for project %s', project_key)
        
        return error_response(error, 'Unable to load commits. Check project access and retry.')
