"""Prepare archived, reusable DSS comparison projects using end user-scoped APIs.

A selected SQL dataset stores ownership and recovery records across restarts.
Only one preparation writer per registry dataset is supported.
"""
from copy import deepcopy
import hashlib
import json
import logging
import re
import threading
import time
import uuid

from .revision import archive_only_diff

LOGGER = logging.getLogger(__name__)
SHA = re.compile(r'^[0-9a-fA-F]{7,40}$')
PROJECT_KEY = re.compile(r'^[A-Za-z0-9_]+$')


class PreparationError(Exception):
    """An actionable error safe to return to a webapp end user."""

    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def identity(client, ref):
    """Identify a snapshot independently of the baseline/target role or caller."""

    return {
        'schema': 1, 
        'instance': client.host.rstrip('/'),
        'sourceProjectKey': ref['projectKey'], 
        'commitId': ref['commitId']
    }


def digest(value):
    """Hash a canonical identity for a stable registry record key."""
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def resolve_selection(client, payload):
    """Validate both inputs and resolve SHA prefixes before any project creation."""
    if not isinstance(payload, dict):
        raise PreparationError('A JSON comparison selection is required.', 400)

    # We need to check both the baseline and the target 
    # project/commit pairs to ensure they are valid and 
    # accessible:
    resolved = {}
    for side in ('baseline', 'target'):
        ref = payload.get(side)
        if (not isinstance(ref, dict) 
                or not isinstance(ref.get('projectKey'), str)
                or not PROJECT_KEY.fullmatch(ref['projectKey'])
                or not isinstance(ref.get('commitId'), str) 
                or not SHA.fullmatch(ref['commitId'])):
            raise PreparationError('Select a valid project and commit on both sides.', 400)
        
        project = client.get_project(ref['projectKey'])
        entries = project.get_project_git().log(start_commit=ref['commitId'], count=1).get('entries', [])
        full = entries[0].get('commit', '') if entries else ''
        if len(full) != 40 or not SHA.fullmatch(full) or not full.lower().startswith(ref['commitId'].lower()):
            raise PreparationError('A selected commit could not be resolved in its source project.', 400)
        
        # Verify access to both projects before creating either artifact.
        project.get_settings().get_raw()
        resolved[side] = {'projectKey': ref['projectKey'], 'commitId': full.lower()}
        
    return resolved


def project_missing(error):
    """Recognize DSS's explicit missing-project response, never permission errors."""
    return 'NotFoundException' in str(error) or 'Project does not exist:' in str(error)


def head(git):
    """Return the current repository HEAD as reported by DSS."""
    entries = git.log(count=1).get('entries', [])
    if not entries:
        raise PreparationError('The generated project has no readable Git HEAD.')
    return entries[0]['commit']


def verified_revision(git, project_key, selected):
    """Accept the selected revision and narrowly verified DSS bookkeeping commits.

    DSS may preserve target identity/permissions after checkout by committing
    invariant properties. Accept only that exact server message and an immediate
    selected parent, never general ancestry or an arbitrary later revision. A
    subsequent archive-only settings commit must also pass content verification.
    """
    entries = git.log(count=3).get('entries', [])
    if entries and entries[0].get('commit') == selected:
        return selected
    expected = 'Updated invariant properties of project %s after git switch operation.' % project_key
    if (len(entries) >= 2 and entries[0].get('message', '').strip() == expected
            and entries[1].get('commit') == selected):
        return entries[0]['commit']
    # A timeout after checkout can leave an archive commit written by error
    # cleanup before verifiedHead was persisted. Verify that exact short chain.
    if (len(entries) >= 2 and entries[0].get('message', '').strip() == 'Updated project settings for ' + project_key):
        parent = entries[1]
        selected_parent = parent.get('commit') == selected or (
            len(entries) >= 3 and parent.get('message', '').strip() == expected
            and entries[2].get('commit') == selected)
        if selected_parent and archive_only_diff(git.diff(commit_from=parent['commit'], commit_to=entries[0]['commit'])):
            return entries[0]['commit']
    raise PreparationError('The generated branch does not match the selected revision. It was retained for inspection; no source project was changed.')


def archive(project):
    """Archive only a generated project, preserving all unrelated settings."""
    settings = project.get_settings()
    if settings.get_raw().get('projectStatus') != 'Archived':
        settings.get_raw()['projectStatus'] = 'Archived'
        settings.save()
    if project.get_settings().get_raw().get('projectStatus') != 'Archived':
        raise PreparationError('The comparison project was created, but archiving could not be verified. Retry to resume archiving.', 502)


def verified_archive_head(git, project_key, expected):
    """Allow a single, diff-verified archive commit after an already verified HEAD."""
    entries = git.log(count=2).get('entries', [])
    if entries and entries[0].get('commit') == expected:
        return expected
    message = 'Updated project settings for ' + project_key
    if (len(entries) == 2 and entries[1].get('commit') == expected
            and entries[0].get('message', '').strip() == message
            and archive_only_diff(git.diff(commit_from=expected, commit_to=entries[0]['commit']))):
        return entries[0]['commit']
    actual = entries[0].get('commit') if entries else None
    LOGGER.warning('Unexpected comparison HEAD for %s: expected=%s actual=%s', project_key, expected, actual)
    raise PreparationError('The comparison revision changed beyond an archive-only settings update. It was retained for inspection.')


def record_source_origin(client, registry, key, record):
    """Persist source lineage (original project key) before duplication, or backfill an old record without this value.

    DSS preserves an existing GitInfo origin when copying a branch project.
    Keep this separate from identity.sourceProjectKey, which is the actual
    project selected by the viewer and remains the registry's reuse identity.
    """
    if 'sourceOriginProjectKey' not in record:
        source = client.get_project(record['identity']['sourceProjectKey'])
        origin = source.get_project_git().get_status().get('originProjectKey') or None
        if origin is not None and (not isinstance(origin, str) or not PROJECT_KEY.fullmatch(origin)):
            raise PreparationError('The source project has an invalid Git origin. No comparison project was modified.')
        
        record['sourceOriginProjectKey'] = origin
        registry.write(key, record)

    origin = record['sourceOriginProjectKey']
    if origin is not None and (not isinstance(origin, str) or not PROJECT_KEY.fullmatch(origin)):
        raise PreparationError('The comparison registry contains invalid source lineage.')


def check_owned(project, record):
    """Verify that a project is the comparison copy tracked by a registry record.

    Require both the unique bootstrap branch created during duplication and a
    DSS Git origin matching the selected source project or its inherited origin.
    Here, ownership means provenance from this app, not DSS user ownership.

    Args:
        project: Generated DSS project API handle to verify.
        record: Registry record containing the source identity, optional inherited
            sourceOriginProjectKey, and unique bootstrapBranch name.

    Returns:
        Tuple of the project's Git API handle, current Git status, and branch names.

    Raises:
        PreparationError: The origin or bootstrap branch does not match the record.
    """
    git = project.get_project_git()
    status = git.get_status()
    branches = git.list_branches()
    origins = { record['identity']['sourceProjectKey'] }
    if record.get('sourceOriginProjectKey'):
        origins.add(record['sourceOriginProjectKey'])

    bootstrap_present = record['bootstrapBranch'] in branches
    if status.get('originProjectKey') not in origins or not bootstrap_present:
        LOGGER.warning('Comparison provenance mismatch for %s: source=%s inheritedOrigin=%s actualOrigin=%s bootstrapPresent=%s',
                       record.get('projectKey'), 
                       record['identity']['sourceProjectKey'],
                       record.get('sourceOriginProjectKey'), 
                       status.get('originProjectKey'), 
                       bootstrap_present
        )
        raise PreparationError('A comparison project key is occupied by a project whose provenance does not match. It will not be modified.')
    
    return git, status, branches


def clean(status):
    """Reject edits in generated projects instead of silently resetting them."""
    if status.get('hasUncommittedChanges') or status.get('clean') is False:
        raise PreparationError('The generated comparison project has uncommitted changes. It will not be reset or replaced.')


def _revision_record(client, registry, ref):
    """Read or reserve a revision's recovery record and persist its source lineage.

    Args:
        client: End user-authenticated DSS API client.
        registry: Persistent preparation registry.
        ref: Selected source projectKey and full commitId.

    Returns:
        Tuple of registry key, mutable record, and whether it was already ready.
    """
    artifact_identity = identity(client, ref)
    key = digest(artifact_identity)
    record = registry.read(key)
    if record and record.get('identity') != artifact_identity:
        raise PreparationError('The comparison registry contains conflicting provenance.')
    
    reused = bool(record and record.get('state') == 'ready')
    if not record:
        prefix = re.sub('[^A-Z0-9_]', '_', ref['projectKey'].upper())[:20]
        record = {
            'identity': artifact_identity, 
            'baseKey': 'VFD_%s_%s' % (prefix, ref['commitId'][:8].upper()),
            'suffix': 0,
            'bootstrapBranch': 'vfd_init_' + uuid.uuid4().hex,
            'branchName': 'vfd_' + key[:24], 
            'state': 'reserved',
            'createdAt': time.time()
        }
        registry.write(key, record)

    # Get the source project's origin before any duplication:
    record_source_origin(client, registry, key, record)

    return key, record, reused


def _archive_partial_project(client, record, project, owned):
    """Archive a failed preparation's copy only after proving its provenance.

    Args:
        client: Viewer-authenticated DSS API client, used to reconcile a lost response.
        record: Recovery record identifying the reserved or generated project.
        project: Generated project handle, or None if it has not been retrieved.
        owned: Whether this attempt has already verified the project's provenance.
    """
    # A lost duplication response can still leave a complete remote project.
    # Reconcile only this reserved key and require both ownership proofs.
    if not owned and record.get('state') == 'duplicating':
        try:
            candidate_project = client.get_project(record['projectKey'])
            candidate_project.get_settings().get_raw()
            check_owned(candidate_project, record)
            project, owned = candidate_project, True
        except Exception:
            pass  # Unknown/unfinished or inaccessible projects are never modified.
    # Only a project with proven registry provenance is eligible for cleanup-by-archiving.
    if project is not None and owned and record.get('state') != 'ready':
        try:
            archive(project)
        except Exception:
            LOGGER.exception('Could not archive partial comparison project %s', record['projectKey'])


def _duplicate_revision_project(client, registry, key, record, ref, progress):
    """Create a copy or recover a timed-out duplication at its reserved project key.

    Persist the key and ownership marker before calling DSS. Only a confirmed
    name collision permits trying another key; uncertain outcomes stay resumable.

    Args:
        client: End user-authenticated DSS API client.
        registry: Persistent preparation registry.
        key: Registry record key.
        record: Mutable recovery record, updated as duplication advances.
        ref: Selected source projectKey and full commitId.
        progress: Callback accepting a user-facing progress message.

    Returns:
        Generated project handle with verified provenance.
    """
    project = None
    owned = False
    try:
        visible_keys = set(client.list_project_keys())  # Includes accessible archived projects.

        # Up to 100 attempts to find a unique project key, which should 
        # be more than enough for a 20-character prefix and numeric suffix:
        for attempt in range(100):
            # Construct the candidate project key from the base and suffix, 
            # then check for collisions with existing projects:
            candidate = record['baseKey'] + ('_%s' % record['suffix'] if record['suffix'] else '')
            if record['state'] == 'reserved' and candidate in visible_keys:
                record['suffix'] += 1
                continue
            record['projectKey'] = candidate

            # If the previous attempt timed out after DSS created 
            # a copy, verify its provenance and reuse it:
            if record['state'] == 'duplicating':
                try:
                    project = client.get_project(candidate)
                    project.get_settings().get_raw()

                except Exception as error:
                    if not project_missing(error):
                        raise
                    project = None

                if project is not None:
                    check_owned(project, record)
                    owned = True
                    record['state'] = 'duplicated'
                    registry.write(key, record)
                    break

            # Create a new copy of the source project at the reserved key. This project 
            # is created as a branch of the source project at the selected commit:
            record['state'] = 'duplicating'
            registry.write(key, record)
            progress('Duplicating source project %s…' % ref['projectKey'])
            try:
                result = client.get_project(ref['projectKey']).get_project_git().create_branch(
                    branch_name=record['bootstrapBranch'], 
                    commit=ref['commitId'], 
                    duplicate_project=True,
                    target_project_key=candidate
                )

            except Exception as error:
                # Only a confirmed name conflict permits choosing a new key.
                if re.search(r'Project\s+' + re.escape(candidate) + r'\s+already exists', str(error), re.I):
                    record['suffix'] += 1
                    record['state'] = 'reserved'
                    registry.write(key, record)
                    continue

                raise

            if not result.get('success'):
                raise PreparationError('Dataiku did not complete project duplication. Retry will inspect the reserved project rather than create another blindly.', 502)
            
            if result.get('targetProjectKey', candidate) != candidate:
                raise PreparationError('Dataiku returned an unexpected comparison project key.', 502)
            
            project = client.get_project(candidate)
            check_owned(project, record)
            owned = True
            record['state'] = 'duplicated'
            registry.write(key, record)
            break

        else:
            raise PreparationError('No available comparison project key was found.', 409)
        
        return project
    
    except Exception:
        _archive_partial_project(client, record, project, owned)
        raise


def _select_revision(project, git, status, branches, registry, key, record, ref, progress):
    """Select and verify the requested revision, or validate an already prepared copy.

    Args:
        project: Generated project whose provenance has been verified.
        git: Generated project's Git API handle.
        status: Current Git status, already checked for uncommitted edits.
        branches: Existing branch names returned by the provenance check.
        registry: Persistent preparation registry.
        key: Registry record key.
        record: Mutable recovery record receiving verified HEAD and stage updates.
        ref: Selected source projectKey and full commitId.
        progress: Callback accepting a user-facing progress message.
    """
    if record.get('verifiedHead'):
        if status.get('currentBranch') != record['branchName']:
            raise PreparationError('An existing comparison branch was modified. It will not be reset or duplicated.')
        
        # Recover copies retained by the previous archive/HEAD check, and a
        # lost registry-save response after a successful archive operation.
        record['verifiedHead'] = verified_archive_head(git, record['projectKey'], record['verifiedHead'])

    else:
        # Archive early as well as after checkout, keeping partial artifacts out of normal lists.
        archive(project)
        progress('Selecting commit %s in the generated project…' % ref['commitId'][:8])
        if record['branchName'] not in branches:
            record['state'] = 'branching'
            registry.write(key, record)
            result = git.create_branch(branch_name=record['branchName'], commit=ref['commitId'], duplicate_project=False)
            if not result.get('success'):
                raise PreparationError('Dataiku did not complete revision selection. Retry to resume the generated project.', 502)
            
        if git.get_current_branch() != record['branchName']:
            raise PreparationError('The generated project is on an unexpected branch. It will not be switched automatically.')
        
        record['verifiedHead'] = verified_revision(git, record['projectKey'], ref['commitId'])
        clean(git.get_status())
        record['state'] = 'revision-ready'
        registry.write(key, record)


def _finalize_revision(project, git, registry, key, record, progress):
    """Archive the copy, verify its final branch and HEAD, then mark it ready.

    Args:
        project: Generated project with a verified selected revision.
        git: Generated project's Git API handle.
        registry: Persistent preparation registry.
        key: Registry record key.
        record: Mutable recovery record receiving final HEAD and ready status.
        progress: Callback accepting a user-facing progress message.
    """
    progress('Archiving and verifying comparison project…')
    archive(project)
    record['verifiedHead'] = verified_archive_head(git, record['projectKey'], record['verifiedHead'])
    final_status = git.get_status()
    clean(final_status)
    if final_status.get('currentBranch') != record['branchName'] or head(git) != record['verifiedHead']:
        raise PreparationError('The comparison revision changed during final verification. It was retained for inspection.')
    
    record['state'] = 'ready'
    registry.write(key, record)


def prepare_revision(client, registry, ref, progress=lambda message: None):
    """Create or resume one snapshot without changing the source project.

    Stages are persisted so retries can recover completed DSS operations rather
    than repeat them. Existing copies must pass provenance and revision checks.

    Args:
        client: Viewer-authenticated DSS API client.
        registry: Persistent preparation registry.
        ref: Selected source projectKey and full commitId.
        progress: Optional callback accepting user-facing progress messages.

    Returns:
        Prepared project metadata, including its verified HEAD and reuse flag.
    """
    progress('Reading the comparison registry…')
    key, record, reused = _revision_record(client, registry, ref)
    project = None
    owned = False

    # Duplication handles its own failure recovery because it can fail after DSS
    # creates a copy but before returning its handle to this function:
    if record['state'] in ('reserved', 'duplicating'):
        project = _duplicate_revision_project(client, registry, key, record, ref, progress)
        owned = True

    try:
        if project is None:
            project = client.get_project(record['projectKey'])

        git, status, branches = check_owned(project, record)
        owned = True

        # Check for uncommitted changes before any branch or HEAD verification, because
        # a user could have modified the generated project after a previous preparation:
        clean(status)

        # Verify the selected revision and its HEAD, or recover a previously verified copy:
        _select_revision(project, git, status, branches, registry, key, record, ref, progress)

        # Finalize the copy by archiving it and verifying its branch and HEAD again, or
        # recover a previously finalized copy. This is the last step before marking it ready:
        _finalize_revision(project, git, registry, key, record, progress)

        return {
            'sourceProjectKey': ref['projectKey'], 
            'commitId': ref['commitId'],
            'projectKey': record['projectKey'], 
            'branchName': record['branchName'],
            'verifiedHead': record['verifiedHead'], 
            'archived': True, 
            'reused': reused
        }
    
    except Exception:
        _archive_partial_project(client, record, project, owned)
        raise


class PreparationJobs:
    """Run one preparation or cleanup at a time; persist recovery state in the registry."""

    def __init__(self):
        self.jobs = {}
        self.lock = threading.Lock()

    def start(self, client, owner, registry, refs):
        """Registers a preparation job, launches it in a background thread, and returns its ID 
        so the UI can poll for progress. Reuse identical retries; reject another job while 
        preparation is active.
        """
        # Simultaneous preparation jobs are not supported because they can create 
        # duplicate projects and race to write the same registry record. A single 
        # cleanup job is also exclusive:
        with self.lock:
            for job_id, job in list(self.jobs.items()):
                # Remove any expired jobs that have been idle for more than an hour.
                if job['state'] != 'preparing' and time.time() - job['updatedAt'] > 3600:
                    del self.jobs[job_id]

                # Reuse an identical preparation job if it is still preparing:
                elif job['owner'] == owner and job['refs'] == refs and job['state'] == 'preparing':
                    return job_id

            # Reject a new preparation job if any other is still preparing:    
            if any(job['state'] == 'preparing' for job in self.jobs.values()):
                raise PreparationError('A comparison is still preparing. Wait for it to finish before starting another.', 409)

            # Register a new preparation job and launch it in a background thread:
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = {
                'owner': owner, 
                'refs': refs, 
                'state': 'preparing',
                'message': 'Preparing comparison projects…', 
                'artifacts': {}, 
                'updatedAt': time.time()
            }

        # Launch the preparation job in a background thread so the UI can poll for 
        # progress. The thread is marked as a daemon so it won't block program exit.
        threading.Thread(target=self._run, args=(job_id, client, registry), daemon=True).start()

        return job_id

    def _update(self, job_id, **fields):
        """Update in-memory job fields and refresh the timestamp under the lock.

        Args:
            job_id: ID of the registered job to update.
            **fields: Job fields to set, such as state, message, or artifacts.
                The updatedAt timestamp is refreshed automatically.
        """
        with self.lock:
            self.jobs[job_id].update(fields, updatedAt=time.time())

    def start_cleanup(self, client, owner, registry, hosting_project_key):
        """Run cleanup with the same single-active-job guard as preparation."""
        with self.lock:
            if any(job['state'] == 'preparing' for job in self.jobs.values()):
                raise PreparationError('A comparison or cleanup is still running. Wait for it to finish before cleaning up.', 409)
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = {'owner': owner, 'refs': None, 'state': 'preparing',
                                 'message': 'Cleaning up registered comparison projects…', 'updatedAt': time.time()}
        threading.Thread(target=self._run_cleanup, args=(job_id, client, registry, hosting_project_key), daemon=True).start()
        return job_id

    def _run_cleanup(self, job_id, client, registry, hosting_project_key):
        """Report complete or partial cleanup through the existing status endpoint."""
        from .cleanup import cleanup_registry
        try:
            result = cleanup_registry(client, registry, hosting_project_key,
                                      lambda message: self._update(job_id, message=message))
            self._update(job_id, state='ready', result=result, message='Cleanup finished.')
        except Exception as error:
            LOGGER.exception('Registry cleanup job failed')
            message = str(error) if isinstance(error, PreparationError) else 'Unable to clean up comparison projects. Check backend logs and retry.'
            self._update(job_id, state='failed', error=message, message=message)

    def _run(self, job_id, client, registry):
        """Prepare both selected revisions in the background and report job status.

        Args:
            job_id: ID of the registered job containing baseline and target refs.
            client: DSS API client authenticated as the end user who started the job.
            registry: Persistent preparation registry used to resume or reuse
                generated projects and save preparation progress.
        """
        job = self.jobs[job_id]
        artifacts = {}
        try:
            for side in ('baseline', 'target'):
                artifact = prepare_revision(
                    client, registry, job['refs'][side],
                    lambda message, side=side: self._update(job_id, message=side.capitalize() + ': ' + message)
                )

                artifacts[side] = artifact
                self._update(job_id, artifacts=deepcopy(artifacts))

            self._update(job_id, state='ready', message='Comparison projects are ready and archived.')

        except Exception as error:
            LOGGER.exception('Comparison preparation failed for job %s', job_id)
            message = str(error) if isinstance(error, PreparationError) else (
                'Comparison preparation failed. Check source project admin/export rights, project creation and destination folder permissions, and backend logs. Retry to resume any projects already created.')
            
            message = side.capitalize() + ': ' + message
            self._update(job_id, state='failed', error=message, message=message)

    def get(self, job_id, owner):
        """Return public job state only to its initiating DSS viewer."""
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise PreparationError('Preparation status expired or the backend restarted. Retry to resume from the persistent registry.', 404)
            if job['owner'] != owner:
                raise PreparationError('This preparation belongs to another user.', 403)
            return deepcopy({key: value for key, value in job.items() if key not in ('owner', 'refs')})
