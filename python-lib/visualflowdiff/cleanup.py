"""Delete proven generated projects and remove their registry entries afterward."""
import logging
import re
from .preparation import PreparationError, check_owned, digest, record_source_origin

LOGGER = logging.getLogger(__name__)


def absent(error, key, client):
    """Recognize DSS missing-project responses without hiding access failures.

    DSS 15 checks permissions before returning project settings. Its permission
    loader masks a missing project as UnauthorizedException with the exact text
    'Failed to read project permissions'. Confirm that response against a fresh
    viewer project list. Ordinary 'Action forbidden', authentication failures,
    and a project still visible in that list remain errors, not absence.
    """
    message = str(error)
    escaped_key = re.escape(key)
    if re.search(r'Project (?:does not exist:\s*' + escaped_key + r'|' + escaped_key + r' does not exist)(?![A-Za-z0-9_])', message):
        return True

    masked_missing = ('UnauthorizedException' in message and 'Failed to read project permissions' in message)
    if masked_missing:
        return key not in set(client.list_project_keys())
        
    return False


def cleanup_registry(client, registry, hosting_project_key, progress=lambda message: None):
    """Clean registered copies as the viewer, retaining failed records for retry.

    Project deletion clears dataset/folder data. Provenance is rechecked
    immediately before deletion; source and hosting projects are protected.
    A failed or ambiguous deletion keeps its record, including after a timeout.
    """
    records = registry.list_records()

    if records:
        registry.check_cleanup_access()

    instance = client.host.rstrip('/')
    protected = {hosting_project_key}
    for key, record in records:
        origin = record.get('identity', {}) if isinstance(record, dict) else {}
        if isinstance(origin, dict) and origin.get('instance') == instance:
            protected.add(origin.get('sourceProjectKey'))

    result = {'deletedProjects': [], 'alreadyMissingProjects': [], 'removedRecords': 0, 'failures': []}
    for index, (key, record) in enumerate(records):
        project_key = record.get('projectKey') if isinstance(record, dict) else None
        progress('Cleaning registry entry %s of %s%s…' % (index + 1, len(records), ' · ' + project_key if isinstance(project_key, str) else ''))

        stage = 'validating registry provenance'
        try:
            origin = record.get('identity') if isinstance(record, dict) else None
            if (not isinstance(origin, dict) or origin.get('schema') != 1
                    or not isinstance(origin.get('sourceProjectKey'), str) or not origin['sourceProjectKey']
                    or not isinstance(origin.get('commitId'), str) or not origin['commitId']
                    or digest(origin) != key):
                raise PreparationError('Invalid registry provenance. The entry was retained.')

            if origin.get('instance') != instance:
                raise PreparationError('This entry belongs to another DSS instance. It was retained.')

            if not project_key:
                if record.get('state') != 'reserved':
                    raise PreparationError('The registry entry has no generated project key. It was retained.')

            else:
                if not isinstance(project_key, str) or project_key in protected:
                    raise PreparationError('A source or hosting project is protected from cleanup. The entry was retained.')

                stage = 'checking project access'
                try:
                    project = client.get_project(project_key)
                    project.get_settings().get_raw()

                except Exception as error:
                    if not absent(error, project_key, client):
                        raise
                    result['alreadyMissingProjects'].append(project_key)

                else:
                    record_source_origin(client, registry, key, record)
                    check_owned(project, record)
                    stage = 'deleting project'
                    project.delete(
                        clear_managed_datasets=True,
                        clear_output_managed_folders=True,
                        clear_job_and_scenario_logs=True, 
                        wait=True
                    )

                    stage = 'verifying project deletion'
                    try:
                        client.get_project(project_key).get_settings().get_raw()

                    except Exception as error:
                        if not absent(error, project_key, client):
                            raise

                    else:
                        raise PreparationError('Project deletion could not be verified. Its registry entry was retained; retry cleanup.')

                    result['deletedProjects'].append(project_key)

            stage = 'removing registry record'
            registry.remove(key)
            result['removedRecords'] += 1

        except Exception as error:
            LOGGER.exception('Cleanup failed while %s for registry entry %s (project %s)', stage, key, project_key)
            message = str(error) if isinstance(error, PreparationError) else (
                'Cleanup failed while %s. Check the webapp Python backend logs and retry. The registry record was retained.' % stage)
            result['failures'].append({'projectKey': project_key, 'recordKey': key, 'stage': stage, 'message': message})

    return result
