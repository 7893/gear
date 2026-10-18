"""Verify account RPCs and races in the same isolated PostgreSQL harness."""

from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4

from check_schema import IDS, ROOT, disposable_database, setup


def call(db, user, function, args='', fail=None):
    value = db.as_user(user, f'SELECT {getattr(db,"schema","gear")}.{function}({args})', fail=fail)
    return json.loads(value) if not fail else None


def change(db, actor, target_id, version, status, role=None, reason='Example review', request_id=None, fail=None):
    request_id = request_id or str(uuid4())
    # Only fictional test constants enter this SQL; no runtime credentials or user input.
    role_sql = f"'{role}'" if role else 'NULL'
    args = f"'{target_id}',{version},'{status}',{role_sql},'{reason}','{request_id}'"
    return call(db, actor, 'set_member_access', args, fail=fail)


def application_and_permissions(db):
    for user in ['viewer', 'operator', 'pending', 'other', 'disabled', 'unverified']:
        call(db, user, 'list_members', fail='admin_required')
        db.as_user(user, f"SELECT gear_private.bootstrap_admin('{IDS[user]}','Example')", fail='permission denied')
    state = call(db, 'other', 'get_my_membership')
    assert state['membership'] is None and state['email_verified']
    call(db, 'unverified', 'apply_for_access', "'Example'", fail='email_not_verified')
    call(db, 'other', 'apply_for_access', "'   '", fail='invalid_name')
    with ThreadPoolExecutor(max_workers=2) as pool:
        applications = list(pool.map(lambda _: call(db, 'other', 'apply_for_access', "'Example applicant'"), range(2)))
    assert applications[0] == applications[1]
    member_id = applications[0]['id']
    assert applications[0]['status'] == 'pending' and applications[0]['role'] is None
    assert db.run(f"SELECT count(*) FROM gear.events WHERE target_member_id='{member_id}'") == '1'
    assert db.run("SELECT count(*) FROM gear.notification_outbox WHERE notification_type='application_pending'") == '1'
    assert call(db, 'other', 'get_my_membership')['membership']['id'] == member_id
    rows = call(db, 'admin', 'list_members', "'pending'")
    assert {x['id'] for x in rows} == {IDS['pending'], member_id}
    assert all('email' in x and 'version' in x for x in rows)
    request_id = str(uuid4())
    approved = change(db, 'admin', member_id, 1, 'active', 'viewer', request_id=request_id)
    assert approved['status'] == 'active' and approved['role'] == 'viewer'
    assert approved['version'] == 2
    assert change(db, 'admin', member_id, 1, 'active', 'viewer', request_id=request_id) == approved
    change(db, 'admin', member_id, 1, 'active', 'operator', request_id=request_id, fail='request_conflict')
    change(db, 'admin', member_id, 1, 'active', 'operator', fail='version_conflict')
    assert db.run("SELECT count(*) FROM gear.notification_outbox WHERE notification_type='application_result'") == '1'
    assert db.as_user('other', 'SELECT count(*) FROM gear.assets') == '2'
    disabled = change(db, 'admin', member_id, 2, 'disabled')
    assert db.as_user('other', 'SELECT count(*) FROM gear.assets') == '0'
    assert call(db, 'other', 'apply_for_access', "'Another name'") == disabled
    assert call(db, 'other', 'get_my_membership')['membership']['status'] == 'disabled'
    db.run(f"UPDATE auth.users SET email_confirmed_at=NULL WHERE id='{IDS['other']}'")
    change(db, 'admin', member_id, 3, 'active', 'viewer', fail='email_not_verified')
    db.run(f"UPDATE auth.users SET email_confirmed_at=now() WHERE id='{IDS['other']}'")
    change(db, 'admin', member_id, 3, 'active', 'operator')
    rejected = change(db, 'admin', IDS['pending'], 1, 'rejected')
    assert call(db, 'pending', 'apply_for_access', "'Changed name'") == rejected
    change(db, 'admin', IDS['pending'], 2, 'active', 'admin', fail='invalid_transition')
    reopened = change(db, 'admin', IDS['pending'], 2, 'pending')
    assert reopened['status'] == 'pending' and reopened['version'] == 3
    change(db, 'viewer', IDS['pending'], 3, 'active', 'admin', fail='admin_required')
    db.run('SET ROLE anon; SELECT gear.get_my_membership()', fail='permission denied')
    db.as_user('admin', 'SELECT * FROM auth.users', fail='permission denied')
    db.run(f"SET ROLE authenticated; SELECT gear.get_my_membership()", fail='login_required')


def last_admin_race(db):
    change(db, 'admin', IDS['admin'], 1, 'disabled', fail='last_admin')
    change(db, 'admin', IDS['operator'], 1, 'active', 'admin')
    def demote(actor):
        version = 1 if actor == 'admin' else 2
        try:
            change(db, actor, IDS[actor], version, 'active', 'viewer')
            return 'success'
        except AssertionError as error:
            assert 'last_admin' in str(error), error
            return 'blocked'
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(demote, ['admin', 'operator'])) == ['blocked', 'success']
    assert db.run("SELECT count(*) FROM gear.members WHERE status='active' AND role='admin'") == '1'
    remaining = 'admin' if db.run(f"SELECT role FROM gear.members WHERE id='{IDS['admin']}'") == 'admin' else 'operator'
    revoked = 'operator' if remaining == 'admin' else 'admin'
    call(db, revoked, 'list_members', fail='admin_required')
    call(db, remaining, 'list_members')


def bootstrap(with_application=False):
    with disposable_database() as db:
        db.run("""
            CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
            CREATE SCHEMA auth;
            CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz);
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
                SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
            $$;
            GRANT USAGE ON SCHEMA auth TO authenticated;
            GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
        """)
        for migration in sorted((ROOT / 'database/migrations').glob('*.sql')):
            db.run(migration.read_text())
        db.schema='gear_2026'
        for name in ['admin', 'operator']:
            db.run(f"INSERT INTO auth.users VALUES ('{IDS[name]}','{name}@example.invalid',now())")
        pending = call(db, 'admin', 'apply_for_access', "'Example pending admin'") if with_application else None
        db.env.pop('GEAR_ADMIN_EMAIL', None)
        db.env.pop('GEAR_ADMIN_DISPLAY_NAME', None)
        db.run((ROOT / 'database/bootstrap_admin.sql').read_text(), fail='GEAR_ADMIN_EMAIL is required')
        db.env['GEAR_ADMIN_EMAIL'] = 'admin@example.invalid'
        db.env['GEAR_ADMIN_DISPLAY_NAME'] = 'Example admin'
        initialized = json.loads(db.run((ROOT / 'database/bootstrap_admin.sql').read_text()))
        repeated = json.loads(db.run(f"SELECT gear_private_2026.bootstrap_admin('{IDS['admin']}','Different name')"))
        assert initialized == repeated and initialized['role'] == 'admin'
        if pending:
            assert initialized['id'] == pending['id'] and initialized['version'] == 2
        assert db.run("SELECT count(*) FROM gear_2026.events WHERE actor_source='bootstrap'") == '1'
        db.run(f"SELECT gear_private_2026.bootstrap_admin('{IDS['operator']}','Another admin')", fail='bootstrap_not_allowed')
        assert call(db, 'admin', 'get_my_membership')['membership']['role'] == 'admin'


def main():
    with disposable_database() as db:
        setup(db)
        migration = ROOT / 'database/migrations/202610170002_accounts.sql'
        db.run(migration.read_text())
        db.run(migration.read_text(), fail='already exists')
        recovery = ROOT / 'database/migrations/202610180003_recovery.sql'
        db.run(recovery.read_text())
        db.run(recovery.read_text(), fail='already exists')
        for name in ['admin', 'operator', 'viewer', 'pending', 'other', 'disabled', 'unverified']:
            expected = 't' if name in ['admin', 'operator', 'viewer'] else 'f'
            assert db.run(f"SET ROLE service_role; SELECT gear.can_recover_password('{IDS[name]}')") == expected
            db.as_user(name, f"SELECT gear.can_recover_password('{IDS[name]}')", fail='permission denied')
        db.run(f"SET ROLE anon; SELECT gear.can_recover_password('{IDS['admin']}')", fail='permission denied')
        db.run('SET ROLE service_role; SELECT * FROM gear.members', fail='permission denied')
        assert db.run('SELECT count(*) FROM gear.events') == '0'
        assert db.run('SELECT count(*) FROM gear.notification_outbox') == '0'
        print('PASS server-only recovery eligibility excludes pending, disabled and unverified identities')
        application_and_permissions(db)
        print('PASS application, review, idempotence and immediate permissions')
        last_admin_race(db)
        print('PASS concurrent administrator changes preserve last administrator')
        assert db.run("SELECT count(*) FROM gear.app_settings WHERE NOT outbound_mail_enabled") == '1'
        assert db.run('SELECT id FROM unrelated.sentinel') == '7'
    bootstrap()
    bootstrap(with_application=True)
    print('PASS owner-only, idempotent bootstrap')
    print(json.dumps({'account_rpc_checks': 'passed', 'production_access': False}))


if __name__ == '__main__':
    main()
