"""Private, manual website/database/original-file backup and empty-target restore.

No production connection is inferred. libpq PG* environment/service files select
PostgreSQL; Storage credentials come only from the process environment. See docs.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_TOTAL = 2 * 1024 ** 3
MAX_FILES = 10000
FORMAT = 'gear-backup-v1'
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
OBJECT = re.compile(r'^[a-f0-9-]{36}/[a-f0-9-]{36}$')


class BackupError(Exception):
    pass


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def private_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('xb') as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def names(schema):
    if not re.fullmatch(r'gear_[0-9]{4}', schema):
        raise BackupError('GEAR_DB_SCHEMA 必须是已部署的项目年份模式。')
    return schema, schema.replace('gear_', 'gear_private_', 1)


def program(name):
    bindir = os.environ.get('PG_BINDIR')
    candidate = Path(bindir) / name if bindir else None
    result = str(candidate) if candidate and candidate.is_file() else shutil.which(name)
    if not result:
        raise BackupError('需要安装与源数据库兼容的 PostgreSQL 客户端工具。')
    return result


def command(args, *, sql=None, output=None):
    try:
        result = subprocess.run(args, input=sql, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BackupError('本地 PostgreSQL 工具运行失败；未显示连接信息。') from error
    if result.returncode:
        raise BackupError('数据库操作失败；请在私有环境核对连接、权限和工具版本。') from subprocess.CalledProcessError(result.returncode, [args[0]], stderr=result.stderr)
    return result.stdout


def psql(sql):
    return command([program('psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], sql=sql.encode()).decode().strip()


@contextmanager
def snapshot():
    process = subprocess.Popen([program('psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               text=True)
    try:
        process.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n')
        process.stdin.flush()
        identity = process.stdout.readline().strip()
        if not re.fullmatch(r'[A-Fa-f0-9]+-[A-Fa-f0-9]+-[A-Fa-f0-9]+', identity):
            raise BackupError('无法建立只读一致性快照。')
        yield identity
    finally:
        if process.poll() is None:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdout.close()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Storage:
    def __init__(self):
        url = urlsplit(os.environ.get('SUPABASE_URL', ''))
        self.bucket = os.environ.get('GEAR_STORAGE_BUCKET', '')
        key = os.environ.get('SUPABASE_SECRET_KEY') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment or not re.fullmatch(r'[a-z0-9-]{3,63}', self.bucket) or not key:
            raise BackupError('请通过私有环境提供 Storage 地址、桶和服务端凭据。')
        self.base = f'{url.scheme}://{url.netloc}/storage/v1/object/{self.bucket}/'
        self.headers = {'apikey': key, 'Authorization': '' if key.startswith('sb_secret_') else 'Bearer ' + key}
        self.opener = build_opener(NoRedirect())

    def request(self, key, data=None, media='application/octet-stream'):
        if not OBJECT.fullmatch(key):
            raise BackupError('备份原件路径无效。')
        headers = {**self.headers, 'Content-Type': media, 'x-upsert': 'false'}
        request = Request(self.base + quote(key, safe='/'), data=data, headers=headers,
                          method='GET' if data is None else 'POST')
        try:
            with self.opener.open(request, timeout=60) as response:
                content = response.read(20971521 if data is None else 65537)
                if data is None and len(content) > 20971520:
                    raise BackupError('原件超过允许大小。')
                return content
        except HTTPError as error:
            if data is None and self.missing_object(error):
                return None
            raise BackupError('Storage 操作失败；不会覆盖现有原件。') from error
        except (URLError, OSError) as error:
            raise BackupError('Storage 连接失败。') from error

    @staticmethod
    def missing_object(error):
        # Storage's compatibility API can use HTTP 400 for a semantic 404.
        # Never treat missing buckets, denied access or arbitrary 404s as keys.
        if error.code not in (400, 404):
            return False
        try:
            body = error.read(65537)
            if len(body) > 65536:
                return False
            detail = json.loads(body)
        except (ValueError, UnicodeError, OSError):
            return False
        if not isinstance(detail, dict):
            return False
        code = detail.get('code')
        if code is not None:
            return code == 'NoSuchKey' and str(detail.get('statusCode', 404)) == '404'
        return (str(detail.get('statusCode')) == '404'
                and detail.get('error') in ('not_found', 'Object not found')
                and detail.get('message') == 'Object not found')

    def get(self, key):
        return self.request(key)

    def put(self, key, data, media):
        self.request(key, data, media)


def web_files(root):
    root = Path(root)
    if not root.is_dir() or not (root / 'index.html').is_file() or root.is_symlink():
        raise BackupError('网站目录必须是含 index.html 的构建产物目录。')
    result = {}
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if path.is_symlink() or any(p.startswith('.') or p in {'node_modules', 'credentials', 'secrets', 'backups'} for p in relative.parts):
            raise BackupError('网站构建目录含链接、隐藏文件或非构建目录，请先核对。')
        if path.is_file():
            result['website/' + relative.as_posix()] = path
    return result


def create_backup(output, web_root, schema, storage):
    schema, private_schema = names(schema)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='gear-backup-') as temporary:
        base = Path(temporary)
        sources = web_files(web_root)
        if sum(path.stat().st_size for path in sources.values()) > MAX_TOTAL:
            raise BackupError('网站构建产物超过备份上限。')
        files = {}
        for name, source in sources.items():
            staged = base / name
            private_write(staged, source.read_bytes())
            files[name] = staged
        with snapshot() as identity:
            dump = base / 'database.dump'
            command([program('pg_dump'), '--format=custom', '--no-owner', '--schema=' + schema,
                     '--schema=' + private_schema, '--snapshot=' + identity, '--file=' + str(dump)])
            os.chmod(dump, 0o600)
            metadata = json.loads(psql(f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
                SET TRANSACTION SNAPSHOT '{identity}';
                SELECT jsonb_build_object('auth_ids',coalesce((SELECT jsonb_agg(auth_user_id::text ORDER BY auth_user_id)
                    FROM {schema}.members WHERE auth_user_id IS NOT NULL),'[]'::jsonb),
                    'originals',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'storage_key',storage_key,
                        'size_bytes',size_bytes,'sha256',sha256,'media_type',media_type) ORDER BY id)
                        FROM {schema}.attachments WHERE upload_state='ready'),'[]'::jsonb)); COMMIT;"""))
        current_sources = web_files(web_root)
        if set(current_sources) != set(sources) or any(digest(path) != digest(files[name]) for name, path in current_sources.items()):
            raise BackupError('网站构建产物在导出期间变化，请在构建完成后重新导出。')
        files['database.dump'] = dump
        for item in metadata['originals']:
            content = storage.get(item['storage_key'])
            if content is None or len(content) != item['size_bytes'] or hashlib.sha256(content).hexdigest() != item['sha256']:
                raise BackupError('原件缺失或校验失败，未生成可用备份。')
            name = 'originals/' + item['id']
            path = base / name
            private_write(path, content)
            files[name] = path
        if len(files) > MAX_FILES or sum(path.stat().st_size for path in files.values()) > MAX_TOTAL:
            raise BackupError('备份超过本工具的小型项目上限（2 GB / 10000 文件）。')
        manifest = {'format': FORMAT, 'created_at': datetime.now(timezone.utc).isoformat(),
                    'schema': schema, 'private_schema': private_schema, **metadata,
                    'files': {name: {'size': path.stat().st_size, 'sha256': digest(path)} for name, path in files.items()}}
        manifest_path = base / 'manifest.json'
        private_write(manifest_path, (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode())
        # Exclusive creation prevents accidental overwrite. Remove incomplete artifacts.
        created = False
        try:
            with output.open('xb') as target:
                created = True
                os.chmod(output, 0o600)
                with tarfile.open(fileobj=target, mode='w:gz') as archive:
                    for name, path in {**files, 'manifest.json': manifest_path}.items():
                        info = archive.gettarinfo(str(path), arcname=name)
                        info.uid = info.gid = 0
                        info.uname = info.gname = ''
                        info.mode = 0o600
                        with path.open('rb') as source:
                            archive.addfile(info, source)
        except BaseException:
            if created:
                output.unlink(missing_ok=True)
            raise
    return digest(output)


def unpack_backup(archive_path, destination):
    destination = Path(destination)
    seen = set()
    total = 0
    with tarfile.open(archive_path, 'r:gz') as archive:
        for item in archive:
            path = PurePosixPath(item.name)
            if not item.isfile() or item.name in seen or path.is_absolute() or '..' in path.parts or '\\' in item.name or path.as_posix() != item.name or item.size < 0:
                raise BackupError('备份含重复、链接或不安全路径。')
            if item.name.startswith('website/') and any(part.startswith('.') or part in {'node_modules', 'credentials', 'secrets', 'backups'} for part in path.parts[1:]):
                raise BackupError('备份网站目录含私有或隐藏文件。')
            if not (item.name in {'manifest.json', 'database.dump'} or item.name.startswith(('website/', 'originals/'))):
                raise BackupError('备份含未知文件。')
            seen.add(item.name)
            total += item.size
            if len(seen) > MAX_FILES + 1 or total > MAX_TOTAL or (item.name == 'manifest.json' and item.size > 8 * 1024 ** 2):
                raise BackupError('备份超出大小或文件数量限制。')
            source = archive.extractfile(item)
            path = destination / item.name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with path.open('xb') as target:
                os.chmod(path, 0o600)
                shutil.copyfileobj(source, target, 1024 * 1024)
    try:
        manifest = json.loads((destination / 'manifest.json').read_text())
        schema, private_schema = names(manifest['schema'])
        if manifest['format'] != FORMAT or manifest['private_schema'] != private_schema or not isinstance(manifest['files'], dict) or set(manifest['files']) != seen - {'manifest.json'}:
            raise ValueError()
        if 'database.dump' not in seen or 'website/index.html' not in seen:
            raise ValueError()
        for name, expected in manifest['files'].items():
            path = destination / name
            if path.stat().st_size != expected['size'] or digest(path) != expected['sha256']:
                raise ValueError()
        if not isinstance(manifest['auth_ids'], list) or any(not UUID.fullmatch(i) for i in manifest['auth_ids']):
            raise ValueError()
        ids = set()
        keys = set()
        for item in manifest['originals']:
            path = destination / 'originals' / item['id']
            if not UUID.fullmatch(item['id']) or not OBJECT.fullmatch(item['storage_key']) or item['id'] in ids or item['storage_key'] in keys or path.stat().st_size != item['size_bytes'] or digest(path) != item['sha256'] or item['media_type'] not in ('application/pdf', 'image/png', 'image/jpeg'):
                raise ValueError()
            ids.add(item['id'])
            keys.add(item['storage_key'])
        if {name for name in seen if name.startswith('originals/')} != {'originals/' + i for i in ids}:
            raise ValueError()
    except (KeyError, TypeError, ValueError, OSError) as error:
        raise BackupError('备份清单或 SHA-256 校验失败。') from error
    return manifest


def restore_preflight(manifest, web_root):
    root = Path(web_root)
    if root.is_symlink() or (root.exists() and (not root.is_dir() or any(root.iterdir()))):
        raise BackupError('网站恢复目标必须是空目录或尚未创建的目录。')
    schema, private_schema = names(manifest['schema'])
    existing = psql(f"SELECT count(*) FROM pg_namespace WHERE nspname IN ('{schema}','{private_schema}')")
    if existing != '0':
        raise BackupError('数据库恢复目标已存在项目模式；拒绝覆盖，请使用隔离空目标。')
    auth_ids = set(json.loads(psql("SELECT coalesce(jsonb_agg(id::text),'[]'::jsonb) FROM auth.users")))
    if not set(manifest['auth_ids']).issubset(auth_ids):
        raise BackupError('目标缺少原 Auth 身份；不迁移共享认证，不伪造或丢弃账号。')
    if psql("SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')") != '3':
        raise BackupError('目标缺少 Supabase 应用角色。')


def notification_quarantine_sql(schema):
    schema, _ = names(schema)
    # Old and current application dumps share the same recovery safeguard.
    # Probe optional columns in the restored schema instead of assuming migration 021.
    return f"""
        DO $gear_restore$
        DECLARE changes text := 'outbound_mail_enabled=false,notifications_enabled_at=NULL';
        BEGIN
            IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='{schema}.app_settings'::regclass
                AND attname='due_mail_enabled' AND NOT attisdropped) THEN
                changes:=changes||',due_mail_enabled=false';
            END IF;
            IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='{schema}.app_settings'::regclass
                AND attname='due_mail_enabled_at' AND NOT attisdropped) THEN
                changes:=changes||',due_mail_enabled_at=NULL';
            END IF;
            EXECUTE 'UPDATE {schema}.app_settings SET '||changes||' WHERE id=1';
        END;
        $gear_restore$;
        UPDATE {schema}.notification_outbox SET status='cancelled',lease_until=NULL,lease_token=NULL,
            delivery_started_at=NULL,error_code='restored_quarantine'
            WHERE status IN ('pending','failed','processing');
        INSERT INTO {schema}.events(scope,event_type,actor_label,actor_source,after_data,reason)
            VALUES('settings','settings_updated','恢复维护工具','system',
            '{{"outbound_mail_enabled":false,"restored_quarantine":true}}','从私有整体备份恢复，已有通知发送开关保持关闭');
    """


def restore_backup(archive_path, web_root, confirm, storage):
    fingerprint = digest(archive_path)
    if confirm != fingerprint:
        raise BackupError('恢复写操作必须明确提供已核对备份的 SHA-256。')
    with tempfile.TemporaryDirectory(prefix='gear-restore-') as temporary:
        base = Path(temporary)
        manifest = unpack_backup(archive_path, base)
        restore_preflight(manifest, web_root)
        schema, private_schema = names(manifest['schema'])
        pending = []
        for item in manifest['originals']:
            current = storage.get(item['storage_key'])
            if current is None:
                pending.append(item)
            elif len(current) != item['size_bytes'] or hashlib.sha256(current).hexdigest() != item['sha256']:
                raise BackupError('目标已有同路径不同内容的原件，拒绝覆盖。')
        sql_path = base / 'restore.sql'
        # Native pg_restore reconstructs PostgreSQL objects, ACLs, sequences and data.
        with sql_path.open('wb') as target:
            os.chmod(sql_path, 0o600)
            target.write(f"BEGIN; SELECT pg_advisory_xact_lock(hashtext('gear-restore')); DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('{schema}','{private_schema}')) THEN RAISE EXCEPTION 'restore_target_not_empty'; END IF; END; $$;\n".encode())
            target.flush()
            command([program('pg_restore'), '--no-owner', '--file=-', str(base / 'database.dump')], output=target)
            target.write(notification_quarantine_sql(schema).encode())
            target.write(b'\nCOMMIT;\n')
        try:
            for item in pending:
                content = (base / 'originals' / item['id']).read_bytes()
                storage.put(item['storage_key'], content, item['media_type'])
                check = storage.get(item['storage_key'])
                if check is None or hashlib.sha256(check).hexdigest() != item['sha256']:
                    raise BackupError('恢复原件回读校验失败。')
            command([program('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--file=' + str(sql_path)])
            root = Path(web_root)
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            for source in (base / 'website').rglob('*'):
                if source.is_file():
                    private_write(root / source.relative_to(base / 'website'), source.read_bytes())
        except BaseException as error:
            raise BackupError('恢复未完成；不会删除已有对象。新增原件可能保留，请根据私有备份清单核对后重试。') from error
    return {'restored': True, 'mail_enabled': False, 'new_originals': len(pending)}


def main():
    os.umask(0o077)
    os.environ.setdefault('PGCONNECT_TIMEOUT', '10')
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    export = sub.add_parser('export')
    export.add_argument('--output', required=True, type=Path)
    export.add_argument('--web-root', required=True, type=Path)
    for name in ('verify', 'restore'):
        item = sub.add_parser(name)
        item.add_argument('archive', type=Path)
        if name == 'restore':
            item.add_argument('--web-root', required=True, type=Path)
            item.add_argument('--confirm-sha256')
    args = parser.parse_args()
    try:
        if args.action == 'export':
            if not args.output.name.endswith('.gear-backup.tar.gz'):
                raise BackupError('请使用 .gear-backup.tar.gz 后缀，确保私有备份被版本库忽略。')
            result = {'sha256': create_backup(args.output, args.web_root, os.environ.get('GEAR_DB_SCHEMA', ''), Storage())}
        elif args.action == 'verify' or not args.confirm_sha256:
            with tempfile.TemporaryDirectory(prefix='gear-backup-verify-') as temporary:
                manifest = unpack_backup(args.archive, temporary)
                if args.action == 'restore':
                    restore_preflight(manifest, args.web_root)
                result = {'verified': True, 'sha256': digest(args.archive), 'files': len(manifest['files']),
                          'originals': len(manifest['originals']), 'writes_applied': False}
        else:
            result = restore_backup(args.archive, args.web_root, args.confirm_sha256, Storage())
        print(json.dumps(result, ensure_ascii=False))
    except (BackupError, OSError, tarfile.TarError, json.JSONDecodeError) as error:
        message = str(error) if isinstance(error, BackupError) else '备份文件操作失败；未显示私有路径或连接信息。'
        parser.exit(1, message + '\n')


if __name__ == '__main__':
    main()
