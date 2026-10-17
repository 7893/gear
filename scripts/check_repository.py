"""Offline checks for tracked documentation and public configuration only."""

from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_DIRS = {'.private', 'private', 'local', 'secrets', 'credentials',
                'data', 'uploads', 'exports', 'backups', 'logs'}
PRIVATE_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.db', '.sqlite',
                    '.sqlite3', '.dump', '.backup'}


def private_path(name):
    path = PurePosixPath(name)
    return (bool(set(path.parts[:-1]) & PRIVATE_DIRS)
            or (path.name.startswith('.env') and not path.name.endswith('.example'))
            or path.suffix in PRIVATE_SUFFIXES
            or bool(re.match(r'(client_secret|google-oauth-client|google-mail-token|'
                             r'service[-_]account|application_default_credentials).*\.json$',
                             path.name)))


def template_errors(content):
    errors, names = [], set()
    for number, line in enumerate(content.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=', line)
        if not match or match[1] in names:
            errors.append(f'line {number}: require a unique NAME= with an empty value')
        if match:
            names.add(match[1])
    return errors


def without_fences(content):
    lines, fence = [], None
    for line in content.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            if fence is None:
                fence = marker[1][0]
            elif fence == marker[1][0]:
                fence = None
            continue
        if fence is None:
            lines.append(line)
    return '\n'.join(lines)


def heading_ids(content):
    counts, result = {}, set()
    for title in re.findall(r'^#{1,6}\s+(.+?)\s*#*$', without_fences(content), re.M):
        title = re.sub(r'\[([^]]+)\]\([^)]+\)', r'\1', title)
        slug = ''.join(c for c in title.lower() if c.isalnum() or c in '_- ')
        slug = slug.replace(' ', '-')
        count = counts.get(slug, 0)
        result.add(f'{slug}-{count}' if count else slug)
        counts[slug] = count + 1
    return result


def link_errors(name, content, files):
    errors = []
    for match in re.finditer(r'\]\(([^)\n]+)\)', without_fences(content)):
        raw = match[1].strip()
        destination = raw[1:raw.index('>')] if raw.startswith('<') and '>' in raw else raw.split()[0]
        link = urlsplit(destination)
        if link.scheme or link.netloc:
            continue  # No external requests during documentation validation.
        target = (ROOT / PurePosixPath(name).parent / unquote(link.path)).resolve()
        try:
            relative = target.relative_to(ROOT).as_posix()
        except ValueError:
            errors.append('local link escapes the repository')
            continue
        if relative not in files:
            errors.append('local link does not point to a tracked regular file')
        elif link.fragment and target.suffix == '.md':
            if unquote(link.fragment) not in heading_ids(files[relative]):
                errors.append('local link has an unknown heading anchor')
    return errors


def main():
    entries = subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=ROOT)
    files, errors = {}, []
    for entry in entries.decode().split('\0'):
        if not entry:
            continue
        metadata, name = entry.split('\t', 1)
        if private_path(name):
            errors.append('A private file is tracked; remove it before publishing')
            continue
        if metadata.split()[0] != '100644' and metadata.split()[0] != '100755':
            errors.append('Only regular tracked files are supported by this checker')
            continue
        path = ROOT / name
        if path.is_symlink():
            errors.append('Tracked files must not resolve through a symlink')
            continue
        try:
            content = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue  # Binary assets are handled by the secret scanner.
        files[name] = content
        if not content.endswith('\n'):
            errors.append(f'{name}: missing final newline')
        if path.name.startswith('.env') and path.name.endswith('.example'):
            errors.extend(f'{name}: {error}' for error in template_errors(content))
    for name, content in files.items():
        if name.endswith('.md'):
            errors.extend(f'{name}: {error}' for error in link_errors(name, content, files))
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print(f'Public file and documentation checks passed ({len(files)} text files).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
