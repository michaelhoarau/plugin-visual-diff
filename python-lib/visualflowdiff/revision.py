"""Verify the precise JSON changes made by archiving a generated DSS project."""
import json
import re


def _without_archive_metadata(lines):
    """Remove root status/versionTag properties from a unified-diff side.

    DSS writes pretty-printed JSON with two-space root properties. Require a
    complete versionTag object in the hunk; unfamiliar/truncated formats fail
    verification rather than granting a broad exception for project settings.
    """
    text = '\n'.join(lines) + '\n'
    statuses = []
    pattern = re.compile(r'^  "(projectStatus|versionTag)"\s*:\s*', re.M)
    offset = 0
    remaining = []
    decoder = json.JSONDecoder()
    for match in pattern.finditer(text):
        if match.start() < offset:
            continue
        remaining.append(text[offset:match.start()])
        value, length = decoder.raw_decode(text[match.end():])
        end = match.end() + length
        newline = text.find('\n', end)
        if newline < 0 or text[end:newline].strip() not in ('', ','):
            raise ValueError('Incomplete root metadata property')
        if match.group(1) == 'versionTag':
            if not isinstance(value, dict):
                raise ValueError('Unexpected version metadata')
        else:
            if value is not None and not isinstance(value, str):
                raise ValueError('Unexpected project status')
            statuses.append(value)
        offset = newline + 1
    remaining.append(text[offset:])
    # A property inserted/removed at the end of an object also changes a comma.
    normalized = '\n'.join(line.rstrip().rstrip(',') for line in ''.join(remaining).splitlines())
    return normalized, statuses


def archive_only_diff(diff):
    """Accept only an Archived status change plus versionTag in params.json.

    Inspect all hunks and their line counts. Recipe/dataset changes, renames,
    other project settings, missing patches, and malformed patches fail closed.
    """
    try:
        entries = diff['entries']
        if diff['changedFiles'] != 1 or len(entries) != 1:
            return False
        entry = entries[0]
        if (entry['changeType'] != 'MODIFY' or entry['oldPath'] != 'params.json'
                or entry['newPath'] != 'params.json'):
            return False
        change = entry['fileChange']
        hunks = []
        old, new = None, None
        added = removed = 0
        for line in change['patch']:
            if line.startswith('@@ '):
                header = re.fullmatch(r'@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@.*', line)
                if not header:
                    return False
                old, new = [], []
                hunks.append((old, new, int(header.group(1) or 1), int(header.group(2) or 1)))
            elif old is None or not line:
                return False
            elif line[0] == ' ':
                old.append(line[1:])
                new.append(line[1:])
            elif line[0] == '-':
                old.append(line[1:])
                removed += 1
            elif line[0] == '+':
                new.append(line[1:])
                added += 1
            else:
                return False
        if (not hunks or added != change['addedLines'] or removed != change['removedLines']
                or added != diff['addedLines'] or removed != diff['removedLines']):
            return False
        old_statuses, new_statuses = [], []
        for old, new, old_count, new_count in hunks:
            if len(old) != old_count or len(new) != new_count:
                return False
            old_text, old_values = _without_archive_metadata(old)
            new_text, new_values = _without_archive_metadata(new)
            if old_text != new_text:
                return False
            old_statuses.extend(old_values)
            new_statuses.extend(new_values)
        return new_statuses == ['Archived'] and old_statuses != new_statuses
    except (KeyError, TypeError, ValueError, AttributeError):
        return False
