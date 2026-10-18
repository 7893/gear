"""Exercise notification leases and eligibility in disposable PostgreSQL only."""
from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4

from check_schema import IDS, ROOT, disposable_database, setup
from check_accounts import change


def service(db, name, args=''):
    value = db.run(f'SET ROLE service_role; SELECT gear_2026.{name}({args})')
    return json.loads(value) if value else None


def claim(db):
    return service(db, 'claim_account_notification')


def prepare(db, job):
    return service(db, 'prepare_account_notification', f"'{job['id']}','{job['lease_token']}'")


def finish(db, job, outcome, code=None, message=None, delay=60):
    quoted = lambda value: "'" + value + "'" if value is not None else 'NULL'
    return db.run(f"SET ROLE service_role; SELECT gear_2026.finish_account_notification("
                  f"'{job['id']}','{job['lease_token']}','{outcome}',{quoted(message)},{quoted(code)},{delay})") == 't'


def pending(db):
    identity, member, job_id = map(str, [uuid4(), uuid4(), uuid4()])
    db.run(f"""
        INSERT INTO auth.users VALUES ('{identity}','applicant@example.invalid',now());
        INSERT INTO gear_2026.members (id,auth_user_id,display_name) VALUES ('{member}','{identity}','Example applicant');
        WITH event AS (
            INSERT INTO gear_2026.events (scope,event_type,target_member_id,actor_member_id,actor_label,actor_source,after_data)
            VALUES ('member','member_applied','{member}','{member}','Example applicant','user',
                '{{"id":"{member}","status":"pending","version":1}}') RETURNING id)
        INSERT INTO gear_2026.notification_outbox (id,dedup_key,notification_type,recipient_member_id,source_event_id,payload)
        SELECT '{job_id}','example:{job_id}','application_pending','{IDS['admin']}',id,
            '{{"to":"ignored@example.invalid","member_id":"{IDS['disabled']}"}}' FROM event;
    """)
    return member, job_id


def clear(db):
    db.run('DELETE FROM gear_2026.notification_outbox')


def main():
    with disposable_database() as db:
        setup(db)
        for path in sorted((ROOT / 'database/migrations').glob('*.sql')):
            if path.name.endswith('initial_schema.sql'):
                continue
            db.run(path.read_text())
        db.schema='gear_2026'
        migration = ROOT / 'database/migrations/202610190007_schema_year.sql'
        db.run(migration.read_text(), fail='schema_year_source_missing')
        for user in ['admin','viewer','pending','disabled','unverified']:
            db.as_user(user, 'SELECT gear_2026.claim_account_notification()', fail='permission denied')
        db.run('SET ROLE anon; SELECT gear_2026.notification_status()', fail='permission denied')
        for user in ['viewer','pending','disabled','unverified']:
            db.as_user(user, 'SELECT gear_2026.notification_status()', fail='admin_required')
        db.run('SET ROLE service_role; SELECT * FROM gear_2026.notification_outbox', fail='permission denied')
        db.run('SET ROLE service_role; SELECT gear_private_2026.notification_status()', fail='permission denied')
        db.run('SET ROLE service_role; SELECT gear_private_2026.configure_account_notifications(true)', fail='permission denied')
        db.as_user('admin','SELECT gear_private_2026.configure_account_notifications(true)', fail='permission denied')
        assert json.loads(db.as_user('admin','SELECT gear_2026.notification_status()'))['enabled'] is False
        member, job_id = pending(db)
        assert claim(db) is None
        assert db.run(f"SELECT status FROM gear_2026.notification_outbox WHERE id='{job_id}'") == 'pending'
        db.run('SELECT gear_private_2026.configure_account_notifications(true)')
        db.run('SELECT gear_private_2026.configure_account_notifications(true)')
        assert db.run("SELECT count(*) FROM gear_2026.events WHERE event_type='settings_updated'") == '1'
        assert claim(db) is None
        assert db.run(f"SELECT error_code FROM gear_2026.notification_outbox WHERE id='{job_id}'") == 'before_enablement'
        print('PASS service-only mutation, admin-only diagnostics, disabled sender and historical cutoff')

        clear(db)
        member, job_id = pending(db)
        with ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(lambda _: claim(db), range(2)))
        assert sum(x is not None for x in claims) == 1
        job = next(x for x in claims if x)
        assert job['id'] == job_id
        assert service(db,'prepare_account_notification',f"'{job_id}','{uuid4()}'") is None
        db.run(f"UPDATE auth.users SET email='current-admin@example.invalid' WHERE id='{IDS['admin']}'")
        message = prepare(db,job)
        assert message == {'to':'current-admin@example.invalid','notification':{'kind':'application_pending','applicantName':'Example applicant'}}
        assert prepare(db,job) is None
        assert finish(db,job,'submitted',message='example-id')
        assert finish(db,job,'submitted',message='example-id')
        assert not finish(db,{**job,'lease_token':str(uuid4())},'submitted',message='example-id')
        assert claim(db) is None
        print('PASS concurrent invocation leases, current recipient lookup, one-time preparation and fenced completion')

        clear(db)
        member, job_id = pending(db)
        job = claim(db)
        change(db,'admin',member,1,'active','viewer')
        assert prepare(db,job) is None
        assert db.run(f"SELECT status FROM gear_2026.notification_outbox WHERE id='{job_id}'") == 'cancelled'
        result = claim(db)
        assert prepare(db,result)['notification'] == {'kind':'application_approved','role':'viewer'}
        assert finish(db,result,'submitted',message='approved-id')
        clear(db)
        member, job_id = pending(db)
        clear(db)
        change(db,'admin',member,1,'rejected')
        result = claim(db)
        assert prepare(db,result)['notification'] == {'kind':'application_rejected'}
        assert finish(db,result,'submitted',message='rejected-id')
        clear(db)
        member, job_id = pending(db)
        clear(db)
        change(db,'admin',member,1,'active','viewer')
        result = claim(db)
        change(db,'admin',member,2,'disabled')
        assert prepare(db,result) is None
        print('PASS approval and rejection messages; pending reminders and obsolete approvals cancelled on current state')

        clear(db)
        pending(db)
        job = claim(db)
        assert finish(db,job,'failed',code='oauth_temporary',delay=3600)
        assert claim(db) is None
        assert db.run(f"SELECT available_at-last_attempt_at > interval '59 minutes' FROM gear_2026.notification_outbox WHERE id='{job['id']}'") == 't'
        db.run("UPDATE gear_2026.notification_outbox SET available_at=now()-interval '1 second'")
        next_job = claim(db)
        assert next_job['lease_token'] != job['lease_token']
        assert not finish(db,job,'failed',code='oauth_temporary')
        assert prepare(db,next_job)
        assert finish(db,next_job,'unknown',code='submission_unknown')
        assert claim(db) is None
        assert db.run('SELECT attempt_count FROM gear_2026.notification_outbox') == '2'
        clear(db)
        pending(db)
        job = claim(db)
        db.run("UPDATE gear_2026.notification_outbox SET lease_until=now()-interval '1 second'")
        assert not finish(db,job,'failed',code='oauth_temporary')
        assert claim(db) is None
        assert db.run('SELECT status FROM gear_2026.notification_outbox') == 'unknown'
        clear(db)
        pending(db)
        job = claim(db)
        assert finish(db,job,'failed',code='mail_authorization')
        db.run("UPDATE gear_2026.notification_outbox SET available_at=now()-interval '1 second'")
        assert claim(db) is None
        print('PASS delayed retry, stale worker fencing, ambiguous delivery and expired leases never auto-retried')

        clear(db)
        pending(db)
        job = claim(db)
        db.run('SELECT gear_private_2026.configure_account_notifications(false)')
        assert prepare(db,job) is None
        assert claim(db) is None
        pending(db)
        db.run('SELECT gear_private_2026.configure_account_notifications(true)')
        assert claim(db) is None  # Both jobs predate the new boundary.
        clear(db)
        pending(db)
        job = claim(db)
        db.run(f"UPDATE auth.users SET email_confirmed_at=NULL WHERE id='{IDS['admin']}'")
        assert prepare(db,job) is None
        db.as_user('admin','SELECT gear_2026.notification_status()', fail='admin_required')
        db.run(f"UPDATE auth.users SET email_confirmed_at=now() WHERE id='{IDS['admin']}'")
        print('PASS owner-only audited toggle, disable/re-enable boundary and recipient verification recheck')

        clear(db)
        pending(db)
        for attempt in range(5):
            job = claim(db)
            assert job is not None
            assert finish(db,job,'failed',code='oauth_temporary')
            db.run("UPDATE gear_2026.notification_outbox SET available_at=now()-interval '1 second'")
        assert claim(db) is None
        clear(db)
        pending(db)
        job = claim(db)
        assert finish(db,job,'failed',code='oauth_temporary')
        db.run("UPDATE gear_2026.notification_outbox SET attempt_count=50,available_at=now()-interval '1 second'")
        pending(db)
        assert claim(db) is None
        state = json.loads(db.as_user('admin','SELECT gear_2026.notification_status()'))
        assert state['enabled'] and state['counts']['failed'] == 1 and state['counts']['pending'] == 1
        assert all(set(row)=={'id','notification_type','status','attempt_count','error_code','updated_at'} for row in state['recent'])
        assert db.run('SELECT id FROM unrelated.sentinel') == '7'
        print('PASS retry cap, conservative daily protection and diagnostics without recipient addresses')
        scheduler_checks(db)
    print(json.dumps({'notification_database_checks':'passed','production_access':False}))


def scheduler_checks(db):
    script = (ROOT / 'database/schedule_account_notifications.sql').read_text()
    db.env['GEAR_NOTIFICATION_FUNCTION_URL'] = 'https://exampleproject.supabase.co/functions/v1/gear-notification-mail'
    db.env['GEAR_NOTIFICATION_TOKEN'] = 'example-only-scheduler-token-' * 2
    db.run(script, fail='Required scheduler extensions')
    assert db.run("SELECT to_regprocedure('gear_private_2026.invoke_account_notifications()') IS NULL") == 't'
    # Test the exact dispatch function with isolated Vault/HTTP doubles. These
    # are SQL captures, never real network calls or a substitute for live Cron.
    db.run("""
        CREATE SCHEMA vault; CREATE SCHEMA net;
        CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
        INSERT INTO vault.decrypted_secrets VALUES
            ('gear_notification_url','https://exampleproject.supabase.co/functions/v1/gear-notification-mail'),
            ('gear_notification_token','example-only-scheduler-token-example-only-scheduler-token-');
        CREATE TABLE unrelated.notification_requests (url text, headers jsonb, body jsonb, timeout_ms integer);
        CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint
            LANGUAGE plpgsql AS $$ BEGIN
            INSERT INTO unrelated.notification_requests VALUES (url,headers,body,timeout_milliseconds); RETURN 1; END $$;
    """)
    function = script[script.index('CREATE FUNCTION gear_private_2026.invoke_account_notifications'):script.index('SELECT cron.schedule')]
    db.run(function)
    db.run('SET ROLE service_role; SELECT gear_private_2026.invoke_account_notifications()', fail='permission denied')
    clear(db)
    assert db.run('SELECT gear_private_2026.invoke_account_notifications()') == ''
    pending(db)
    db.run('SELECT gear_private_2026.configure_account_notifications(false)')
    assert db.run('SELECT gear_private_2026.invoke_account_notifications()') == ''
    db.run('SELECT gear_private_2026.configure_account_notifications(true)')
    assert db.run('SELECT gear_private_2026.invoke_account_notifications()') == '1'
    assert db.run("SELECT count(*) FROM unrelated.notification_requests WHERE body='{}' AND timeout_ms=45000") == '1'
    assert db.run("SELECT headers->>'Authorization' LIKE 'Bearer example-only-%' FROM unrelated.notification_requests") == 't'
    print('PASS scheduler installation fails without extensions; isolated dispatcher checks toggle and queue before HTTP')


if __name__ == '__main__':
    main()
