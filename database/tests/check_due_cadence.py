"""Reminder milestones and final-send rechecks; isolated PostgreSQL, no mail."""
import json
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import initialize, party, rpc, quoted
from check_completion import configure
from check_notifications import claim, prepare, finish
from check_asset_lifecycle import lifecycle

MIGRATION = ROOT / 'database/migrations/202610200022_due_notification_cadence.sql'


def main():
    with disposable_database() as db:
        setup(db)
        for path in sorted((ROOT / 'database/migrations').glob('*.sql')):
            if not path.name.endswith('initial_schema.sql') and path < MIGRATION:
                db.run(path.read_text())
        today = db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
        person = party(db)
        asset = initialize(db, placement={
            'holder_party_id': person['id'], 'responsible_person_id': person['id'],
            'usage_kind': 'temporary', 'due_on': today,
        })
        before = data(db, 'gear_2026')
        metadata_sql = "SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')"
        metadata = json.loads(db.run(metadata_sql))
        target = db.run("SELECT 'gear_private_2026.due_notification_counts(uuid)'::regprocedure::oid")
        db.run(MIGRATION.read_text())
        assert data(db, 'gear_2026') == before
        after = json.loads(db.run(metadata_sql))
        assert after.keys() == metadata.keys()
        assert all(after[k] == v for k, v in metadata.items() if k != target)
        assert after[target][:-1] == metadata[target][:-1]
        db.run(MIGRATION.read_text(), fail='due_cadence_source_mismatch')
        assert json.loads(db.run(metadata_sql)) == after
        assert rpc(db, 'admin', 'get_due_settings')['enabled'] is False
        print('PASS guarded one-function migration: existing rows, switches, unrelated functions and ACLs preserved')

        def set_due(offset):
            # Owner-only fixture adjustment; actual reminders still use the production selector.
            db.run("UPDATE gear_2026.assignments SET due_on=(now() AT TIME ZONE 'Asia/Shanghai')::date+" + str(offset) + ' WHERE asset_id=' + quoted(asset['id']) + ' AND closed_at IS NULL')

        def counts():
            return json.loads(db.run('SELECT gear_private_2026.due_notification_counts(' + quoted(IDS['operator']) + ')'))

        configure(db, lead=3)
        actual_days = []
        for offset in range(35, -32, -1):
            set_due(offset)
            value = counts()
            total = value['dueSoon'] + value['dueToday'] + value['overdue']
            if total:
                actual_days.append(offset)
                assert total == 1
                assert value['dueSoon'] == int(offset == 3)
                assert value['dueToday'] == int(offset == 0)
                assert value['overdue'] == int(offset < 0)
        assert actual_days == [3, 0, -3, -6, -9, -12, -15, -18, -21, -24, -27, -30]
        for lead in [0, 1, 5, 30]:
            configure(db, lead=lead)
            set_due(lead)
            value = counts()
            assert value['dueSoon'] + value['dueToday'] == 1
            assert value['overdue'] == 0
        configure(db, lead=3)
        set_due(2)
        assert sum(counts()[key] for key in ['dueSoon', 'dueToday', 'overdue']) == 0
        assert asset['id'] in {a['id'] for a in rpc(db, 'viewer', 'list_due_assets')['items']}
        db.env['PGTZ'] = 'America/New_York'
        set_due(-3)
        assert counts()['overdue'] == 1 and counts()['businessDate'] == today
        db.env['PGTZ'] = 'UTC'
        print('PASS advance/date/overdue milestones across 67 dates, lead 0/1/5/30, calendar-day offsets and timezone; on-screen due list remains complete')

        db.run('SELECT gear_private_2026.configure_account_notifications(true)')
        set_due(3)
        job = claim(db)
        assert job is not None
        assert db.run('SELECT gear_private_2026.enqueue_due_notifications()') == '0'
        set_due(2)  # Extended before send: today's milestone no longer applies.
        assert prepare(db, job) is None
        assert claim(db) is None
        db.run('DELETE FROM gear_2026.notification_outbox')  # Isolated fixture only.
        set_due(-3)
        job = claim(db)
        assert job is not None
        message = prepare(db, job)
        assert message['notification']['overdue'] == 1
        assert finish(db, job, 'submitted', message='example-milestone')
        assert claim(db) is None
        # A second asset at another milestone is still one aggregate for this person/day.
        other = initialize(db, placement={
            'holder_party_id': person['id'], 'responsible_person_id': person['id'],
            'usage_kind': 'temporary', 'due_on': today,
        })
        assert counts()['dueToday'] == 1 and counts()['overdue'] == 1
        assert claim(db) is None
        current = rpc(db, 'viewer', 'get_asset', quoted(asset['id']))['asset']
        lifecycle(db, current, 'lost', today)
        assert counts()['overdue'] == 0 and counts()['dueToday'] == 1
        assert other['id'] in {a['id'] for a in rpc(db, 'viewer', 'list_due_assets')['items']}
        assert db.run('SELECT id FROM unrelated.sentinel') == '7'
        print('PASS final-send recheck, no duplicate recipient/day, combined milestones and processed-equipment exclusion; no providers called')
    print(json.dumps({'due_cadence_checks': 'passed', 'production_access': False}))


if __name__ == '__main__':
    main()
