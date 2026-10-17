"""Check real contributor commits, excluding GitHub's synthetic PR merge."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def valid_subject(subject):
    return (bool(subject) and subject.isascii() and bool(re.search('[A-Za-z]', subject))
            and len(subject.split()) <= 7)


def revision_range(event_name, event, sha):
    if event_name == 'pull_request':
        return f"{event['pull_request']['base']['sha']}..{event['pull_request']['head']['sha']}"
    before = event.get('before', '')
    if event_name == 'push' and before and set(before) != {'0'}:
        return f'{before}..{sha}'
    return sha  # Initial push or manual check: inspect all reachable commits.


def verification(repository, sha, token):
    request = Request(f'https://api.github.com/repos/{repository}/commits/{sha}', headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    # A newly pushed signature can briefly be pending GitHub verification.
    for attempt in range(3):
        with urlopen(request, timeout=30) as response:
            result = json.load(response)['commit']['verification']
        if result.get('verified') or result.get('reason') not in {
            'gpgverify_error', 'gpgverify_unavailable'}:
            return bool(result.get('verified'))
        if attempt < 2:
            time.sleep(2)
    return False


def main():
    token = os.environ.get('GH_TOKEN', '')
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    if not token or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        print('Run in Actions with a read-only GitHub token.', file=sys.stderr)
        return 1
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    revisions = revision_range(os.environ['GITHUB_EVENT_NAME'], event, os.environ['GITHUB_SHA'])
    if not re.fullmatch(r'[0-9a-f]{40}(?:\.\.[0-9a-f]{40})?', revisions):
        print('Invalid commit range.', file=sys.stderr)
        return 1
    shas = subprocess.check_output(['git', 'rev-list', revisions], text=True).splitlines()
    errors = []
    for sha in shas:
        subject = subprocess.check_output(['git', 'show', '-s', '--format=%s', sha], text=True).strip()
        if not valid_subject(subject):
            errors.append(f'{sha[:12]}: require an English subject of at most seven words')
        if not verification(repository, sha, token):
            errors.append(f'{sha[:12]}: GitHub did not verify the commit signature')
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print(f'Commit subjects and signatures verified ({len(shas)} commits).')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (HTTPError, URLError, OSError, KeyError, ValueError, subprocess.CalledProcessError):
        # Do not dump API bodies, credentials, event data or commit subjects into logs.
        print('Commit verification unavailable; failing closed.', file=sys.stderr)
        sys.exit(1)
