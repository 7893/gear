"""Exercise migrations in a disposable PostgreSQL cluster, never a supplied URL.

Requires PostgreSQL 16+ server binaries (PG_BINDIR may select their directory).
Auth/roles below are isolated test doubles, not a replacement for Supabase Auth.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
IDS = {name: f'00000000-0000-4000-8000-{i:012d}' for i, name in enumerate(
    ['admin', 'operator', 'viewer', 'pending', 'other', 'disabled', 'unverified',
     'person', 'person2', 'team', 'organization', 'asset', 'asset2', 'draft',
     'other_draft', 'formal', 'item', 'new_item', 'attachment'], 1)}


class Database:
    def __init__(self, bindir, socket):
        self.psql = str(bindir / 'psql') if (bindir / 'psql').exists() else shutil.which('psql')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        self.args = [self.psql, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                     '--host', str(socket), '--username', 'gear_test', '--dbname', 'gear_test']

    def run(self, sql, fail=None):
        result = subprocess.run(self.args, input=sql, text=True, capture_output=True,
                                env=self.env, timeout=30)
        if fail:
            assert result.returncode != 0, 'Unexpectedly accepted invalid operation'
            assert fail in result.stderr, result.stderr
        elif result.returncode:
            raise AssertionError(result.stderr)
        return result.stdout.strip()

    def as_user(self, name, sql, fail=None):
        return self.run(f"BEGIN; SET LOCAL ROLE authenticated; "
                        f"SET LOCAL request.jwt.claim.sub = '{IDS[name]}'; {sql}; COMMIT;", fail)


@contextmanager
def disposable_database():
    configured = os.environ.get('PG_BINDIR')
    candidates = [Path(configured)] if configured else sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True)
    bindir = next((p for p in candidates if (p / 'initdb').exists()), None)
    if bindir is None:
        raise SystemExit('PostgreSQL server binaries required; set PG_BINDIR to their bin directory.')
    with tempfile.TemporaryDirectory(prefix='gear-schema-') as temporary:
        base = Path(temporary)
        data, socket = base / 'data', base / 'socket'
        socket.mkdir(mode=0o700)
        clean_env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        def command(args):
            completed = subprocess.run(args, text=True, capture_output=True, env=clean_env, timeout=45)
            if completed.returncode:
                raise AssertionError(completed.stderr + completed.stdout)
        command([str(bindir / 'initdb'), '-D', str(data), '-U', 'gear_test',
                 '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--no-locale'])
        command([str(bindir / 'pg_ctl'), '-D', str(data), '-l', str(base / 'server.log'),
                 '-o', f"-F -k {socket} -h ''", '-w', 'start'])
        try:
            subprocess.run([str(bindir / 'createdb') if (bindir / 'createdb').exists() else 'createdb',
                            '-h', str(socket), '-U', 'gear_test', 'gear_test'],
                           check=True, capture_output=True, env=clean_env, timeout=15)
            yield Database(bindir, socket)
        finally:
            command([str(bindir / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'])


def setup(db):
    db.run("""
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
        $$;
        GRANT USAGE ON SCHEMA auth TO authenticated;
        GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
        CREATE SCHEMA unrelated;
        CREATE TABLE unrelated.sentinel (id integer PRIMARY KEY);
        INSERT INTO unrelated.sentinel VALUES (7);
    """)
    migration = ROOT / 'database/migrations/202610170001_initial_schema.sql'
    db.run(migration.read_text())
    db.run(migration.read_text(), fail='already exists')
    assert db.run('SELECT id FROM unrelated.sentinel') == '7'
    assert db.run("SELECT count(*) FROM pg_tables WHERE schemaname='gear'") == '11'
    assert db.run("SELECT count(*) FROM pg_tables WHERE schemaname='gear' AND rowsecurity") == '11'
    assert db.run("SELECT count(*) FROM gear.app_settings WHERE NOT outbound_mail_enabled") == '1'
    for name in ['admin', 'operator', 'viewer', 'pending', 'other', 'disabled', 'unverified']:
        verified = 'NULL' if name == 'unverified' else 'now()'
        db.run(f"INSERT INTO auth.users VALUES ('{IDS[name]}', '{name}@example.invalid', {verified});")
        if name == 'other':
            continue
        status = name if name in ['pending', 'disabled'] else 'active'
        role = name if name in ['admin', 'operator', 'viewer'] else 'viewer'
        role_sql = f"'{role}'" if status == 'active' else 'NULL'
        db.run(f"INSERT INTO gear.members (id,auth_user_id,display_name,status,role) "
               f"VALUES ('{IDS[name]}','{IDS[name]}','Example {name}','{status}',{role_sql});")
    for name in ['person', 'person2', 'organization']:
        kind = 'organization' if name == 'organization' else 'person'
        db.run(f"INSERT INTO gear.parties (id,kind,name,created_by) "
               f"VALUES ('{IDS[name]}','{kind}','Example party','{IDS['admin']}');")
    db.run(f"INSERT INTO gear.parties (id,kind,name,default_responsible_id,created_by) "
           f"VALUES ('{IDS['team']}','team','Example team','{IDS['person']}','{IDS['admin']}');")
    for name in ['asset', 'asset2']:
        db.run(f"INSERT INTO gear.assets (id,asset_code,legacy_code,name,category,condition,created_by) "
               f"VALUES ('{IDS[name]}','TEST-{name}','duplicate-old-code','Example device','computer','normal','{IDS['admin']}');")
    for name, owner in [('draft', 'operator'), ('other_draft', 'admin'), ('formal', 'operator')]:
        db.run(f"INSERT INTO gear.documents (id,create_request_id,kind,created_by) "
               f"VALUES ('{IDS[name]}',gen_random_uuid(),'receipt','{IDS[owner]}');")
    db.run(f"INSERT INTO gear.documents (create_request_id,kind,created_by) "
           f"SELECT create_request_id,kind,created_by FROM gear.documents WHERE id='{IDS['draft']}'", fail='unique constraint')


def assignments(db):
    event = db.run(f"INSERT INTO gear.events (scope,event_type,asset_id,actor_label,actor_source) "
                   f"VALUES ('asset','asset_initialized','{IDS['asset']}','Example admin','bootstrap') RETURNING id")
    insert = ("INSERT INTO gear.assignments (asset_id,holder_party_id,responsible_person_id,usage_kind,"
              "opened_event_id,followup_member_id) VALUES "
              f"('{IDS['asset']}','{IDS['person']}','{IDS['person']}','long_term',{event},'{IDS['admin']}')")
    def attempt(_):
        try:
            db.run(insert)
            return True
        except AssertionError as error:
            assert 'assignments_one_current_asset' in str(error), error
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, range(2))) == [False, True]
    assert db.run(f"SELECT started_on IS NULL FROM gear.assignments WHERE asset_id='{IDS['asset']}'") == 't'
    db.run(f"UPDATE gear.assets SET management_status='lost' WHERE id='{IDS['asset']}'", fail='invalid assignment relation')
    db.run(f"UPDATE gear.assignments SET responsible_person_id='{IDS['person2']}'", fail='invalid assignment relation')
    before = db.run('SELECT id::text FROM gear.assignments')
    db.run(f"UPDATE gear.assignments SET holder_party_id='{IDS['team']}'")
    db.run(f"UPDATE gear.assignments SET responsible_person_id='{IDS['person2']}'")
    assert db.run('SELECT id::text FROM gear.assignments') == before
    assert db.run("SELECT started_on IS NULL AND due_on IS NULL FROM gear.assignments") == 't'
    db.run(f"UPDATE gear.assets SET asset_code='changed' WHERE id='{IDS['asset']}'", fail='asset identity is permanent')
    db.run('UPDATE gear.events SET actor_label=actor_label', fail='events are append only')
    db.run('DELETE FROM gear.events', fail='events are append only')
    db.run(f"INSERT INTO gear.members (display_name,status,role) VALUES ('Invalid','pending','admin')", fail='check constraint')
    db.run(f"UPDATE gear.members SET party_id='{IDS['team']}' WHERE id='{IDS['viewer']}'", fail='responsible party must be a person')


def permissions(db):
    for name in ['pending', 'other', 'disabled', 'unverified']:
        assert db.as_user(name, 'SELECT count(*) FROM gear.assets') == '0'
        assert db.as_user(name, 'SELECT count(*) FROM gear.asset_ledger') == '0'
    assert db.as_user('pending', 'SELECT count(*) FROM gear.members') == '1'
    assert db.as_user('other', 'SELECT count(*) FROM gear.members') == '0'
    assert db.as_user('viewer', 'SELECT count(*) FROM gear.members') == '1'
    assert db.as_user('admin', 'SELECT count(*) FROM gear.members') == '6'
    for name in ['viewer', 'operator', 'admin']:
        assert db.as_user(name, 'SELECT count(*) FROM gear.assets') == '2'
        db.as_user(name, 'UPDATE gear.assets SET name=name', fail='permission denied')
        db.as_user(name, 'INSERT INTO gear.document_counters VALUES (current_date,1,now())', fail='permission denied')
        db.as_user(name, 'SELECT * FROM gear.app_settings', fail='permission denied')
        db.as_user(name, "SELECT gear_private.next_document_sequence(now())", fail='permission denied')
        assert db.as_user(name, 'SELECT document_header FROM gear.app_settings') == '设备簿'
    db.run('SET ROLE anon; SELECT * FROM gear.assets', fail='permission denied')
    db.run('SET ROLE service_role; SELECT * FROM gear.assets', fail='permission denied')
    assert db.as_user('viewer', 'SELECT count(*) FROM gear.documents') == '0'
    assert db.as_user('operator', 'SELECT count(*) FROM gear.documents') == '2'
    assert db.as_user('admin', 'SELECT count(*) FROM gear.documents') == '3'
    db.run(f"UPDATE gear.members SET status='disabled',role=NULL WHERE id='{IDS['viewer']}'")
    assert db.as_user('viewer', 'SELECT count(*) FROM gear.assets') == '0'
    db.run(f"UPDATE gear.members SET status='active',role='viewer' WHERE id='{IDS['viewer']}'")
    db.run(f"UPDATE auth.users SET email_confirmed_at=NULL WHERE id='{IDS['viewer']}'")
    assert db.as_user('viewer', 'SELECT count(*) FROM gear.assets') == '0'
    db.run(f"UPDATE auth.users SET email_confirmed_at=now() WHERE id='{IDS['viewer']}'")


def numbering(db):
    assert db.run("SELECT gear_private.next_document_sequence('2030-01-01 15:59:59+00')") == '1'
    assert db.run("SELECT gear_private.next_document_sequence('2030-01-01 16:00:00+00')") == '1'
    with ThreadPoolExecutor(max_workers=4) as pool:
        values = list(pool.map(lambda _: int(db.run("SELECT gear_private.next_document_sequence('2030-01-01 16:00:00+00')")), range(8)))
    assert sorted(values) == list(range(2, 10))
    db.run("BEGIN; SELECT gear_private.next_document_sequence('2030-01-01 16:00:00+00'); SELECT 1/0; COMMIT", fail='division by zero')
    assert db.run("SELECT last_value FROM gear.document_counters WHERE business_on='2030-01-02'") == '9'


def documents_and_evidence(db):
    db.run(f"INSERT INTO gear.document_items (id,document_id,line_no,asset_id) "
           f"VALUES ('{IDS['item']}','{IDS['formal']}',1,'{IDS['asset2']}')")
    formal_update = (f"UPDATE gear.documents SET status='confirmed', document_no='TEST-20300102-1',"
                     "numbering_on='2030-01-02',number_value=1,handover_on='2030-01-01',"
                     "from_kind='external',to_kind='inventory',from_label='Example supplier',to_label='Inventory',"
                     "sender_name='Example sender',receiver_name='Example receiver',header_snapshot='{}',parties_snapshot='{}',"
                     f"confirmed_by='{IDS['operator']}',confirmed_at='2030-01-01 16:00:00+00',confirmed_revision=1,"
                     f"evidence_state='awaiting_upload' WHERE id='{IDS['formal']}'")
    db.run(formal_update, fail='formal document requires complete item events')
    assert db.run(f"SELECT status FROM gear.documents WHERE id='{IDS['formal']}'") == 'draft'
    db.run(f"BEGIN; INSERT INTO gear.events (scope,event_type,asset_id,document_id,document_item_id,actor_label,actor_source) "
           f"VALUES ('asset','document_confirmed','{IDS['asset2']}','{IDS['formal']}','{IDS['item']}','Example admin','bootstrap');"
           f"UPDATE gear.document_items SET asset_snapshot='{{}}',state_before='{{}}',state_after='{{}}',"
           f"confirmed_event_id=(SELECT id FROM gear.events WHERE document_item_id='{IDS['item']}') WHERE id='{IDS['item']}';"
           + formal_update + '; COMMIT;')
    db.run(f"UPDATE gear.documents SET receiver_name='Changed' WHERE id='{IDS['formal']}'", fail='formal document fields are frozen')
    db.run(f"UPDATE gear.document_items SET note='Changed' WHERE id='{IDS['item']}'", fail='formal document items are frozen')
    db.run(f"UPDATE gear.assets SET name='Later device name' WHERE id='{IDS['asset2']}'")
    assert db.run(f"SELECT asset_snapshot::text FROM gear.document_items WHERE id='{IDS['item']}'") == '{}'
    db.run(f"DELETE FROM gear.documents WHERE id='{IDS['formal']}'", fail='formal document cannot be deleted')
    assert db.as_user('viewer', 'SELECT count(*) FROM gear.documents') == '1'
    db.run(f"INSERT INTO gear.attachments (document_id,storage_key,original_name,uploaded_by) "
           f"VALUES ('{IDS['draft']}','test-draft','test.pdf','{IDS['operator']}')", fail='document evidence is incomplete')
    db.run(f"INSERT INTO gear.attachments (id,document_id,storage_key,original_name,uploaded_by) "
           f"VALUES ('{IDS['attachment']}','{IDS['formal']}','test-signed','test.pdf','{IDS['operator']}')")
    assert db.as_user('viewer', 'SELECT count(*) FROM gear.attachments') == '0'
    assert db.as_user('operator', 'SELECT count(*) FROM gear.attachments') == '1'
    db.run("UPDATE gear.attachments SET upload_state='ready'", fail='check constraint')
    archive = (f"UPDATE gear.documents SET evidence_state='archived',archived_by='{IDS['operator']}',"
               f"archived_at=now() WHERE id='{IDS['formal']}'")
    db.run(archive, fail='document evidence is incomplete')
    db.run("UPDATE gear.attachments SET upload_state='ready',media_type='application/pdf',size_bytes=1,"
           "sha256=repeat('a',64),uploaded_at=now(),ocr_state='failed'")
    assert db.as_user('viewer', 'SELECT count(*) FROM gear.attachments') == '1'
    db.run(archive, fail='document evidence is incomplete')
    db.run(f"BEGIN; UPDATE gear.attachments SET review_state='accepted',reviewed_by='{IDS['operator']}',reviewed_at=now();"
           + archive + '; COMMIT')
    db.run('UPDATE gear.attachments SET is_active=false', fail='document evidence is incomplete')
    db.run(f"INSERT INTO gear.document_items (document_id,line_no,new_asset_data) VALUES ('{IDS['draft']}',1,'{{}}')")
    db.run(f"DELETE FROM gear.documents WHERE id='{IDS['draft']}'")
    assert db.run(f"SELECT count(*) FROM gear.document_items WHERE document_id='{IDS['draft']}'") == '0'


def main():
    with disposable_database() as db:
        for check in [setup, assignments, permissions, numbering, documents_and_evidence]:
            check(db)
            print(f'PASS {check.__name__}')
        # An identity removed outside Gear does not erase its operation history.
        db.run(f"DELETE FROM auth.users WHERE id='{IDS['operator']}'")
        assert db.run(f"SELECT auth_user_id IS NULL FROM gear.members WHERE id='{IDS['operator']}'") == 't'
        assert db.run(f"SELECT count(*) FROM gear.documents WHERE created_by='{IDS['operator']}'") == '1'
        print('PASS external_identity_removal')
    print(json.dumps({'isolated_database': 'passed', 'groups': 6, 'production_access': False}))


if __name__ == '__main__':
    main()
