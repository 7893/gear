"""Real pg_dump/pg_restore roundtrip, disposable clusters and in-memory Storage."""
import hashlib
import importlib.util
import json
import io
from urllib.error import HTTPError
import os
from pathlib import Path
import tempfile
from unittest.mock import patch
from uuid import uuid4
from check_schema import ROOT,IDS,disposable_database,setup
from check_completion import migrate,get,reserve
from check_inventory import initialize,quoted
from check_evidence import finish,reserve as reserve_document
from check_flows import save,confirm,line

spec=importlib.util.spec_from_file_location('gear_backup',ROOT/'scripts/backup.py')
backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
class Storage(backup.Storage):
    """Run the real HTTP adapter against an isolated in-memory transport."""
    def __init__(self,objects=None):
        with patch.dict(os.environ,{'SUPABASE_URL':'https://backend.example.invalid/','GEAR_STORAGE_BUCKET':'example-evidence','SUPABASE_SECRET_KEY':'sb_secret_example'}):super().__init__()
        self.objects=dict(objects or {});self.puts=[];self.opener=self
    def open(self,request,timeout):
        assert timeout==60
        key=request.full_url.removeprefix(self.base)
        if request.method=='GET':
            if key not in self.objects:
                raise HTTPError(request.full_url,400,'example',{},io.BytesIO(b'{"statusCode":"404","code":"NoSuchKey","message":"Object not found"}'))
            return io.BytesIO(self.objects[key])
        assert request.method=='POST' and key not in self.objects
        assert request.get_header('X-upsert')=='false'
        self.objects[key]=request.data;self.puts.append(key)
        return io.BytesIO(b'{}')

def roundtrip(through):
 with disposable_database() as db, tempfile.TemporaryDirectory(prefix='gear-backup-check-') as temporary:
    if through>=21:migrate(db)
    else:
        setup(db)
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if 1<int(path.name.split('_',1)[0][-3:])<=through:db.run(path.read_text())
    base=Path(temporary);web=base/'web';web.mkdir();(web/'index.html').write_text('<html lang="zh-CN">示例设备簿</html>');(web/'app.js').write_text('console.log("example")')
    asset=get(db,initialize(db))['asset'];event=get(db,asset)['history'][0]['id']
    content=b'%PDF-example'+b'0'*88;assert len(content)==100
    if through>=18:
        item=reserve(db,asset,event,sha256=hashlib.sha256(content).hexdigest())
        item=finish(db,item,{'id':str(uuid4()),'document_no':'LR-20200101-0001'})
    else:
        today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
        document=confirm(db,save(db,{'kind':'receipt','handover_on':today,'from_kind':'external','to_kind':'inventory','from_label':'示例交付方','sender_name':'示例移交人','receiver_name':'示例接收人'},[line()]))
        item=reserve_document(db,document,sha256=hashlib.sha256(content).hexdigest())
        item=finish(db,item,document)
    storage=Storage({item['storage_key']:content});archive=base/'private.tar.gz'
    db.run('SELECT gear_private_2026.configure_account_notifications(true)')
    if through>=21:db.run("UPDATE gear_2026.app_settings SET due_mail_enabled=true,due_mail_enabled_at=now() WHERE id=1")
    db.run(f"INSERT INTO gear_2026.notification_outbox(dedup_key,notification_type,recipient_member_id,payload) VALUES('example-backup-pending','daily_due','{IDS['admin']}','{{}}')")
    expected={table:db.run(f'SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM gear_2026.{table} t') for table in ['assets','assignments','documents','attachments','members']}
    source_env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
    source_env.update(PGHOST=db.args[db.args.index('--host')+1],PGUSER='gear_test',PGDATABASE='gear_test',PG_BINDIR=str(Path(db.psql).parent))
    with patch.dict(os.environ,source_env,clear=True):
        fingerprint=backup.create_backup(archive,web,'gear_2026',storage)
        assert fingerprint==backup.digest(archive) and archive.stat().st_mode&0o777==0o600
        with tempfile.TemporaryDirectory() as out:
            manifest=backup.unpack_backup(archive,out);assert len(manifest['originals'])==1
        try:backup.create_backup(archive,web,'gear_2026',storage)
        except FileExistsError:pass
        else:raise AssertionError('overwrote original backup')
        try:backup.restore_backup(archive,base/'restored','bad-hash',Storage())
        except backup.BackupError:pass
        else:raise AssertionError('restored without confirmation')
    db.run('CREATE DATABASE gear_restore')
    target_env={**source_env,'PGDATABASE':'gear_restore'}
    identities=json.loads(db.run('SELECT jsonb_agg(to_jsonb(u)) FROM auth.users u'))
    with patch.dict(os.environ,target_env,clear=True):
        backup.psql('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting(\'request.jwt.claim.sub\', true),\'\')::uuid $$; GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated; CREATE SCHEMA unrelated; CREATE TABLE unrelated.sentinel(id integer); INSERT INTO unrelated.sentinel VALUES(7);')
        try:backup.restore_preflight(manifest,base/'restored')
        except backup.BackupError as error:assert 'Auth' in str(error)
        else:raise AssertionError('accepted missing Auth identities')
        for user in identities:
            stamp=quoted(user['email_confirmed_at']) if user['email_confirmed_at'] else 'NULL'
            backup.psql(f"INSERT INTO auth.users VALUES({quoted(user['id'])},{quoted(user['email'])},{stamp})")
        backup.restore_preflight(manifest,base/'restored')
        conflict=Storage({item['storage_key']:b'conflict'})
        try:backup.restore_backup(archive,base/'restored',fingerprint,conflict)
        except backup.BackupError as error:assert '覆盖' in str(error)
        else:raise AssertionError('overwrote conflicting original')
        assert backup.psql("SELECT count(*) FROM pg_namespace WHERE nspname='gear_2026'")=='0'
        restored_storage=Storage();result=backup.restore_backup(archive,base/'restored',fingerprint,restored_storage)
        assert result=={'restored':True,'mail_enabled':False,'new_originals':1}
        assert restored_storage.objects==storage.objects
        for table,value in expected.items():assert backup.psql(f'SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM gear_2026.{table} t')==value,table
        assert backup.psql('SELECT NOT outbound_mail_enabled AND notifications_enabled_at IS NULL FROM gear_2026.app_settings')=='t'
        if through>=21:assert backup.psql('SELECT NOT due_mail_enabled AND due_mail_enabled_at IS NULL FROM gear_2026.app_settings')=='t'
        assert backup.psql("SELECT status FROM gear_2026.notification_outbox WHERE dedup_key='example-backup-pending'")=='cancelled'
        identity_check=f"BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='{IDS['viewer']}'; SELECT gear_2026.get_asset('{asset['id']}'); COMMIT;"
        assert json.loads(backup.psql(identity_check))['asset']['id']==asset['id']
        assert backup.psql('SET ROLE service_role; SELECT gear_2026.claim_account_notification()')==''
        try:backup.psql("SET ROLE authenticated; UPDATE gear_2026.assets SET name='forbidden'")
        except backup.BackupError:pass
        else:raise AssertionError('restored table ACL allowed direct writes')
        assert backup.psql('SELECT id FROM unrelated.sentinel')=='7'
        assert (base/'restored/index.html').read_bytes()==(web/'index.html').read_bytes()
        try:backup.restore_backup(archive,base/'restored',fingerprint,restored_storage)
        except backup.BackupError:pass
        else:raise AssertionError('restored onto live target')
        assert len(restored_storage.puts)==1
    print(f'PASS migration {through}: native database/website/original roundtrip; HTTP 400 missing-key upload, hashes, no-overwrite, restored ACL and available mail switches disabled')

def main():
    latest=max(int(p.name.split('_',1)[0][-3:]) for p in (ROOT/'database/migrations').glob('*.sql'))
    for through in [13,latest]:roundtrip(through)
    print(json.dumps({'backup_restore_checks':'passed','production_access':False}))
if __name__=='__main__':main()
