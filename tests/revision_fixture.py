"""Build DSS public Git diff payloads from real unified JSON patches."""
from difflib import unified_diff
import json


def settings_diff(before, after, path='params.json'):
    patch = list(unified_diff(json.dumps(before, indent=2).splitlines(), json.dumps(after, indent=2).splitlines(), lineterm=''))[2:]
    added = sum(line.startswith('+') for line in patch)
    removed = sum(line.startswith('-') for line in patch)
    return {'changedFiles': 1, 'addedLines': added, 'removedLines': removed, 'entries': [{
        'changeType': 'MODIFY', 'oldPath': path, 'newPath': path,
        'fileChange': {'addedLines': added, 'removedLines': removed, 'patch': patch}}]}
