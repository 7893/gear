"""Publish the checked static page and gateway using dedicated CI credentials."""

from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / 'infrastructure/smoke-page'
GATEWAY = ROOT / 'infrastructure/gateway'
REQUIRED = (
    'DEPLOY_HOST', 'DEPLOY_PORT', 'CI_DEPLOY_USER', 'DEPLOY_SSH_KEY',
    'DEPLOY_KNOWN_HOSTS', 'PUBLIC_APP_URL', 'PUBLIC_API_URL',
    'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL', 'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_NAME', 'BACKEND_DNS_NAME',
    'GEAR_DB_SCHEMA', 'GEAR_STORAGE_BUCKET', 'GEAR_FUNCTION_PREFIX',
    'AWS_DEPLOY_ROLE_ARN', 'AWS_CLOUDFRONT_DISTRIBUTION_ID',
    'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
)


def https_origin(value):
    url = urlsplit(value)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment):
        raise ValueError('An HTTPS origin without credentials is required')
    return value.rstrip('/')


def validate(env):
    missing = [name for name in REQUIRED if not env.get(name)]
    if missing:
        raise ValueError('Missing configuration names: ' + ', '.join(missing))
    if (env.get('GITHUB_REF') != 'refs/heads/main'
            or env.get('GITHUB_EVENT_NAME') not in ('push', 'workflow_dispatch')
            or not re.fullmatch(r'[a-f0-9]{40}', env.get('GITHUB_SHA', ''))):
        raise ValueError('Deployment requires a main branch workflow commit')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:-]*', env['DEPLOY_HOST']):
        raise ValueError('Invalid deployment host')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*', env['CI_DEPLOY_USER']):
        raise ValueError('Invalid deployment user')
    if not env['DEPLOY_PORT'].isdigit() or not 1 <= int(env['DEPLOY_PORT']) <= 65535:
        raise ValueError('Invalid deployment port')
    for name in ('PUBLIC_APP_URL', 'PUBLIC_API_URL', 'SUPABASE_URL'):
        https_origin(env[name])
    if not env['SUPABASE_PUBLISHABLE_KEY'].startswith('sb_publishable_'):
        raise ValueError('Only a Supabase publishable key may enter the page')
    if not re.fullmatch(r'arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+', env['AWS_DEPLOY_ROLE_ARN']):
        raise ValueError('Invalid deployment role')


def public_files(directory):
    files = []
    for path in sorted(directory.rglob('*')):
        relative = path.relative_to(directory)
        if (path.is_symlink() or any(part.startswith('.') for part in relative.parts)
                or path.suffix.lower() in ('.pem', '.key', '.p12', '.pfx')):
            raise ValueError('Unsafe file in browser output')
        if path.is_file():
            if b'sb_secret_' in path.read_bytes():
                raise ValueError('Server secret prefix found in browser output')
            files.append(path)
    if not (directory / 'index.html').is_file():
        raise ValueError('Browser output has no index')
    return files


def selected_version(versions, revision):
    matches = [version for version in versions
               if version.get('annotations', {}).get('workers/message') == 'Deploy ' + revision]
    if not matches:
        raise RuntimeError('Uploaded gateway version is not available')
    selected = max(matches, key=lambda version: version.get('number', 0))
    if not re.fullmatch(r'[a-f0-9-]{36}', selected.get('id', '')):
        raise RuntimeError('Uploaded gateway version has an invalid identifier')
    return selected['id']


def run(stage, args, *, cwd=ROOT, env=None, timeout=180):
    print(f'{stage}: running', flush=True)
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True,
                            text=True, timeout=timeout)
    if result.returncode:
        # Tool output can contain resource identifiers and URLs. Do not publish it.
        raise RuntimeError(f'{stage}: failed (exit {result.returncode}); tool output withheld')
    print(f'{stage}: passed', flush=True)
    return result.stdout


def assume_role(env):
    query = env['ACTIONS_ID_TOKEN_REQUEST_URL']
    query += ('&' if '?' in query else '?') + urlencode({'audience': 'sts.amazonaws.com'})
    request = Request(query, headers={
        'Authorization': 'bearer ' + env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
    })
    with urlopen(request, timeout=30) as response:
        token = json.load(response)['value']
    body = urlencode({
        'Action': 'AssumeRoleWithWebIdentity', 'Version': '2011-06-15',
        'RoleArn': env['AWS_DEPLOY_ROLE_ARN'],
        'RoleSessionName': 'gear-' + env['GITHUB_SHA'][:12],
        'WebIdentityToken': token, 'DurationSeconds': '900',
    }).encode()
    with urlopen(Request('https://sts.us-east-1.amazonaws.com/', data=body), timeout=30) as response:
        document = ET.fromstring(response.read())
    ns = {'s': 'https://sts.amazonaws.com/doc/2011-06-15/'}
    credentials = document.find('.//s:Credentials', ns)
    if credentials is None:
        raise RuntimeError('AWS temporary credentials unavailable')
    return {
        target: credentials.findtext('s:' + source, namespaces=ns)
        for target, source in (
            ('AWS_ACCESS_KEY_ID', 'AccessKeyId'),
            ('AWS_SECRET_ACCESS_KEY', 'SecretAccessKey'),
            ('AWS_SESSION_TOKEN', 'SessionToken'),
        )
    }


@contextmanager
def private_files():
    previous = os.umask(0o077)
    try:
        with tempfile.TemporaryDirectory(prefix='gear-publish-') as directory:
            yield Path(directory)
    finally:
        os.umask(previous)


def deploy(env):
    validate(env)
    # Build processes receive configuration names they need, without deployment credentials.
    clean = {name: env[name] for name in ('PATH', 'HOME', 'CI', 'RUNNER_TEMP') if name in env}
    clean.update(CF_SEND_TELEMETRY='false', DO_NOT_TRACK='1')
    gateway_env = dict(clean, **{name: env[name] for name in (
        'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_NAME', 'BACKEND_DNS_NAME',
    )})
    run('Gateway production build', ['pnpm', 'run', 'build'], cwd=GATEWAY, env=gateway_env)
    run('Gateway deployment preview', ['pnpm', 'exec', 'cf', 'workers', 'versions', 'create', '--prebuilt',
        '--mode', 'production', '--dry-run'], cwd=GATEWAY, env=gateway_env)
    run('Page production build', ['pnpm', 'run', 'build'], cwd=PAGE, env=clean)
    dist = PAGE / 'dist'
    (dist / 'runtime-config.json').write_text(json.dumps({
        'apiUrl': https_origin(env['PUBLIC_API_URL']),
        'publishableKey': env['SUPABASE_PUBLISHABLE_KEY'],
        'release': env['GITHUB_SHA'],
    }) + '\n')
    files = public_files(dist)
    # Verify AWS trust before making any publication changes.
    aws_env = dict(clean, **assume_role(env), AWS_DEFAULT_REGION='us-east-1', AWS_PAGER='')
    with private_files() as temporary:
        bindings = temporary / 'bindings.json'
        bindings.write_text(json.dumps({
            'SUPABASE_URL': https_origin(env['SUPABASE_URL']),
            'FRONTEND_ORIGIN': https_origin(env['PUBLIC_APP_URL']),
            **{name: env[name] for name in ('GEAR_DB_SCHEMA', 'GEAR_STORAGE_BUCKET', 'GEAR_FUNCTION_PREFIX')},
        }))
        key, hosts = temporary / 'identity', temporary / 'known_hosts'
        key.write_text(env['DEPLOY_SSH_KEY'].rstrip() + '\n')
        hosts.write_text(env['DEPLOY_KNOWN_HOSTS'].rstrip() + '\n')
        ssh = shlex.join(['ssh', '-i', str(key), '-p', env['DEPLOY_PORT'],
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + str(hosts), '-o', 'ConnectTimeout=15'])
        host = env['DEPLOY_HOST']
        if ':' in host:
            host = '[' + host + ']'
        remote = env['CI_DEPLOY_USER'] + '@' + host + ':'
        # rrsync confines this key to the project root and prohibits deletion.
        # Assets arrive before HTML; previous assets stay available to cached pages.
        common = ['rsync', '--recursive', '--times', '--chmod=D755,F644', '-e', ssh]
        run('Restricted upload access', common + ['--dry-run', '--',
            str(dist / 'index.html'), remote + './'], env=clean)
        worker_env = dict(gateway_env, CLOUDFLARE_API_TOKEN=env['CLOUDFLARE_API_TOKEN'])
        run('Gateway version upload', ['pnpm', 'exec', 'cf', 'workers', 'versions', 'create',
            '--prebuilt', '--mode', 'production', '--secrets-file', str(bindings),
            '--message', 'Deploy ' + env['GITHUB_SHA']], cwd=GATEWAY, env=worker_env)
        versions = json.loads(run('Gateway version lookup', ['pnpm', 'exec', 'cf', 'workers',
            'versions', 'list', '--worker-id', env['CLOUDFLARE_GATEWAY_NAME'], '--per-page', '25'],
            cwd=GATEWAY, env=worker_env))
        version = selected_version(versions, env['GITHUB_SHA'])
        run('Gateway version publication', ['pnpm', 'exec', 'cf', 'workers', 'deployments',
            'create', '--worker', env['CLOUDFLARE_GATEWAY_NAME'], '--strategy', 'percentage',
            '--versions', json.dumps([{'version_id': version, 'percentage': 100}])],
            cwd=GATEWAY, env=worker_env)
        directories = sorted({path.relative_to(dist).parts[0] for path in files
                              if len(path.relative_to(dist).parts) > 1})
        for directory in directories:
            run('Static resource upload', common + ['--', str(dist / directory) + '/',
                remote + directory + '/'], env=clean)
        for path in sorted((p for p in files if p.parent == dist), key=lambda p: p.name == 'index.html'):
            run('Page file upload', common + ['--', str(path), remote + './'], env=clean)

    distribution = env['AWS_CLOUDFRONT_DISTRIBUTION_ID']
    result = json.loads(run('CDN entry refresh', ['aws', 'cloudfront', 'create-invalidation',
        '--distribution-id', distribution, '--paths', '/', '/index.html', '/runtime-config.json',
        '--output', 'json'], env=aws_env))
    invalidation = result['Invalidation']['Id']
    for _ in range(36):
        result = json.loads(run('CDN refresh status', ['aws', 'cloudfront', 'get-invalidation',
            '--distribution-id', distribution, '--id', invalidation, '--output', 'json'], env=aws_env))
        if result['Invalidation']['Status'] == 'Completed':
            break
        time.sleep(5)
    else:
        raise RuntimeError('CDN refresh did not complete before the deadline')
    output = run('Live browser verification', ['pnpm', 'run', 'test:live'], cwd=PAGE,
        env=dict(clean, SMOKE_BASE_URL=env['PUBLIC_APP_URL'],
                 SMOKE_EXPECTED_REVISION=env['GITHUB_SHA']), timeout=110)
    # Print a fixed success summary; no response bodies or deployment identifiers.
    if '"supabase":"passed"' not in output:
        raise RuntimeError('Live browser verification did not return its success summary')
    print('Deployment verified: page, CDN, gateway, Supabase and retry passed.')


if __name__ == '__main__':
    try:
        deploy(dict(os.environ))
    except Exception as error:
        # Exceptions from HTTP libraries can embed actual endpoints; show only controlled messages.
        if isinstance(error, (ValueError, RuntimeError)):
            print(str(error), file=sys.stderr)
        else:
            print('Deployment failed; sensitive diagnostics withheld (' + type(error).__name__ + ')', file=sys.stderr)
        sys.exit(1)
