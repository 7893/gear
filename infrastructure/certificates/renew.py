"""Renew Google certificates from a private config; never print private values."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


def execute(command, *, env=None, input=None, timeout=90, allowed=(0,)):
    result = subprocess.run(command, env=env, input=input, capture_output=True,
                            text=True, timeout=timeout)
    if result.returncode not in allowed:
        raise RuntimeError('Certificate operation failed; command output suppressed')
    return result


def verify_certificate(domain, cert_root):
    directory = Path(cert_root) / (domain + '_ecc')
    cert, key, chain = directory / (domain + '.cer'), directory / (domain + '.key'), directory / 'ca.cer'
    issuer = execute(['openssl', 'x509', '-in', str(cert), '-noout', '-issuer']).stdout
    if 'Google Trust Services' not in issuer:
        raise RuntimeError('Unexpected certificate issuer')
    execute(['openssl', 'x509', '-in', str(cert), '-noout', '-checkend', '1209600'])
    execute(['openssl', 'verify', '-verify_hostname', domain, '-untrusted', str(chain), str(cert)])
    pub_cert = execute(['openssl', 'x509', '-in', str(cert), '-noout', '-pubkey']).stdout
    pub_key = execute(['openssl', 'pkey', '-in', str(key), '-pubout']).stdout
    if pub_cert != pub_key:
        raise RuntimeError('Certificate key mismatch')
    return cert, key, chain, directory / 'fullchain.cer'


def fingerprint(cert):
    # Hash the PEM file consistently with the private state created at setup.
    return hashlib.sha256(cert.read_bytes()).hexdigest()


def install_origin(config, fullchain, key):
    script = r'''
import json,os,pathlib,subprocess,sys
os.umask(0o077)
data=json.load(sys.stdin)
root=pathlib.Path('/etc/nginx/gear')
targets={root/'fullchain.pem':data['fullchain'],root/'private.key':data['key']}
before={path:path.read_bytes() for path in targets}
try:
    for path,content in targets.items():
        stage=path.with_suffix(path.suffix+'.new')
        stage.write_text(content);stage.chmod(0o600);stage.replace(path)
    if subprocess.run(['nginx','-t'],capture_output=True).returncode:
        raise RuntimeError('Nginx validation failed')
    subprocess.run(['systemctl','reload','nginx'],check=True,capture_output=True)
except Exception:
    for path,content in before.items():path.write_bytes(content);path.chmod(0o600)
    raise SystemExit('Origin certificate update failed; previous files restored')
print('Origin certificate installed')
'''
    execute(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', config['ssh_host'],
             'sudo -n python3 -c ' + shlex.quote(script)],
            input=json.dumps({'fullchain': fullchain.read_text(), 'key': key.read_text()}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--check', action='store_true', help='Only validate local certificate files')
    args = parser.parse_args()
    os.umask(0o077)
    if args.config.stat().st_mode & 0o077:
        raise RuntimeError('Private config must be accessible only by its owner')
    config = json.loads(args.config.read_text())
    state_path = Path(config['state_file'])
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    for kind in ['frontend', 'origin']:
        domain = config[kind + '_domain']
        if not args.check:
            command = [config['acme_client'], '--home', config['acme_home'],
                       '--config-home', config['config_home'], '--cert-home', config['cert_home'],
                       '--accountconf', str(Path(config['config_home']) / 'account.conf'),
                       '--server', 'google', '--renew', '-d', domain, '--ecc']
            result = execute(command, env=dict(os.environ, CLOUDSDK_CORE_PROJECT=config['gcp_project']),
                             timeout=600, allowed=(0, 2))
            # Raw ACME logs can contain DNS identifiers: keep them in private storage.
            (args.config.parent / ('renew-' + kind + '.log')).write_text(result.stdout + result.stderr)
        cert, key, chain, fullchain = verify_certificate(domain, config['cert_home'])
        if args.check:
            continue
        digest = fingerprint(cert)
        if state.get(kind) == digest:
            continue
        if kind == 'frontend':
            execute(['aws', '--profile', config['aws_profile'], 'acm', 'import-certificate',
                     '--region', 'us-east-1', '--certificate-arn', config['certificate_arn'],
                     '--certificate', 'fileb://' + str(cert), '--private-key', 'fileb://' + str(key),
                     '--certificate-chain', 'fileb://' + str(chain), '--no-cli-pager'])
        else:
            install_origin(config, fullchain, key)
        state[kind] = digest
        stage = state_path.with_suffix('.tmp')
        stage.write_text(json.dumps(state)); stage.chmod(0o600); stage.replace(state_path)
    print(json.dumps({'certificate_check': 'passed', 'mode': 'check' if args.check else 'renew'}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'certificate_check': 'failed', 'details': 'suppressed'}), file=sys.stderr)
        sys.exit(1)
