"""Fault/repair, date ordering and atomic handovers in disposable PostgreSQL only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import initialize, party, rpc, quoted
from check_flows import save, confirm, line


def change(db, asset, condition='faulty', on=None, reason='示例故障说明',
           user='operator', request=None, fail=None):
    return rpc(db, user, 'change_asset_condition', ','.join([
        quoted(asset['id']), str(asset['version']), quoted(condition),
        quoted(on) if on is not None else 'NULL', quoted(reason),
        quoted(request or str(uuid4())),
    ]), fail=fail)


def main():
    with disposable_database() as db:
        db.env['PGTZ'] = 'UTC'
        setup(db)
        migration = ROOT/'database/migrations/202610190011_asset_condition.sql'
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path < migration and not path.name.endswith('initial_schema.sql'):
                db.run(path.read_text())
        catalog = "SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')"
        before = json.loads(db.run(catalog)); before_data = data(db, 'gear_2026')
        db.run(migration.read_text())
        after = json.loads(db.run(catalog)); changed = []
        assert len(after) == len(before) + 2
        for oid, value in before.items():
            assert value[:-1] == after[oid][:-1]
            if value[-1] != after[oid][-1]: changed.append(value[:2])
        assert changed == [['gear_private_2026', 'confirm_document']]
        assert before_data == data(db, 'gear_2026')
        db.run(migration.read_text(), fail='condition_source_mismatch')
        assert json.loads(db.run(catalog)) == after
        for role in ['anon', 'service_role']:
            db.run('SET ROLE '+role+'; SELECT gear_2026.change_asset_condition(NULL,NULL,NULL,NULL,NULL,NULL)', fail='permission denied')
        print('PASS migration preserves data, identities and ACLs; two new functions, one guarded confirmation body')

        today = date.fromisoformat(db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date"))
        day = lambda n: (today+timedelta(days=n)).isoformat()
        get = lambda a: rpc(db, 'viewer', 'get_asset', quoted(a['id']))['asset']
        person = party(db)
        team = party(db, details={'kind':'team','name':'示例设备组','default_responsible_id':person['id']})
        inventory = get(initialize(db, placement={'known_on':day(-10)}))
        personal = get(initialize(db, placement={'holder_party_id':person['id'],
            'responsible_person_id':person['id'],'usage_kind':'long_term','known_on':day(-10)}))
        held = get(initialize(db, placement={'holder_party_id':team['id'],
            'responsible_person_id':person['id'],'usage_kind':'temporary','known_on':None,'due_on':day(10)}))
        assignments = db.run('SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM gear_2026.assignments x')
        documents = db.run('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM gear_2026.documents d')
        sequences = db.run("SELECT last_value,is_called FROM gear_2026.asset_code_sequence")
        request = str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _:change(db, held, on=day(-2), request=request), range(2)))
        faulty = results[0]
        assert faulty == results[1] and faulty['version'] == held['version'] + 1
        assert {k:v for k,v in faulty.items() if k not in ['condition','version','updated_at']} == {
            k:v for k,v in held.items() if k not in ['condition','version','updated_at']}
        assert faulty['condition'] == 'faulty'
        event = rpc(db, 'viewer', 'get_asset', quoted(held['id']))['history'][0]
        assert event['event_type'] == 'asset_fault_reported' and event['occurred_on'] == day(-2)
        assert event['after_data'] == faulty and event['reason'] == '示例故障说明'
        assert json.loads(db.run('SELECT before_data FROM gear_2026.events WHERE request_id='+quoted(request))) == held
        repaired = change(db, faulty, 'normal', day(-1), '示例更换部件后恢复', user='admin')
        assert repaired['condition'] == 'normal' and repaired['version'] == held['version'] + 2
        assert repaired['asset_code'] == held['asset_code'] and repaired['last_flow_on'] is None
        assert change(db, held, on=day(-2), request=request) == faulty  # Replay remains the original result.
        change(db, held, on=day(-2), reason='不同内容', request=request, fail='request_conflict')
        change(db, held, on=day(-2), user='admin', request=request, fail='request_conflict')
        for asset in [inventory, personal]:
            failed = change(db, asset, on=day(-2))
            assert failed['holder_party_id'] == asset['holder_party_id']
            assert failed['display_status'] == ('inventory_faulty' if asset == inventory else 'in_use')
            assert change(db, failed, 'normal', day(-1))['display_status'] == asset['display_status']
        assert db.run('SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM gear_2026.assignments x') == assignments
        assert db.run('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM gear_2026.documents d') == documents
        assert db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence') == sequences
        for user in ['viewer','pending','disabled','unverified','other']:
            change(db, repaired, on=day(0), user=user, fail='inventory_access_denied')
        change(db, held, on=day(0), fail='asset_condition_conflict')
        change(db, repaired, 'normal', day(0), fail='asset_condition_transition')
        for value in [day(-3),day(1),'2025-02-30','infinity','0000-01-01','2030-1-1',None]:
            change(db, repaired, on=value, fail='invalid_condition_date')
        for reason in ['  ', '字'*2001]:
            change(db, repaired, on=day(0), reason=reason, fail='invalid_condition_change')
        change(db, repaired, condition='wrong', on=day(0), fail='invalid_condition_change')
        for state in ['returned_upstream','lost','scrapped']:
            excluded = get(initialize(db))
            db.run('UPDATE gear_2026.assets SET management_status='+quoted(state)+' WHERE id='+quoted(excluded['id']))
            change(db, get(excluded), on=day(0), fail='asset_condition_transition')
        invalid = get(initialize(db))
        db.run('UPDATE gear_2026.assets SET invalidated_at=now(),invalid_reason=\'示例误建\',invalidated_by='+quoted(IDS['admin'])+' WHERE id='+quoted(invalid['id']))
        change(db, get(invalid), on=day(0), fail='asset_condition_transition')
        change(db, get(inventory), on=day(-11), fail='invalid_condition_date')
        print('PASS inventory/person/team fault and repair; holders, deadlines, numbers and immutable snapshots preserved')
        print('PASS original-result retry, conflicts, roles, transitions, input and chronology validation')

        # Stale issue is rejected; repair permits issue only with a current version and date.
        available = get(initialize(db, placement={'known_on':day(-10)}))
        issue = {'kind':'issue','handover_on':day(-3),'from_kind':'inventory','to_kind':'party',
            'to_party_id':team['id'],'to_person_id':person['id'],'sender_name':'示例发放人',
            'receiver_name':'示例接收人','usage_kind':'temporary','due_on':day(10)}
        draft = save(db, issue, [line(available)])
        bad = change(db, available, on=day(-2))
        confirm(db, draft, fail='asset_flow_conflict')
        confirm(db, save(db, {**issue,'handover_on':day(-1)}, [line(bad)]), fail='asset_flow_conflict')
        good = change(db, bad, 'normal', day(-1), '示例维修完成')
        backdated = save(db, issue, [line(good)])
        unchanged = data(db, 'gear_2026')
        confirm(db, backdated, fail='invalid_document_date')
        assert data(db, 'gear_2026') == unchanged
        issued = confirm(db, save(db, {**issue,'handover_on':day(-1)}, [line(good)]))
        assigned = get(available)
        returning = {'kind':'return','handover_on':day(0),'from_kind':'party','to_kind':'inventory',
            'from_party_id':team['id'],'from_person_id':person['id'],'sender_name':'示例交回人',
            'receiver_name':'示例经办人','remarks':'示例故障退回'}
        stale = save(db, returning, [line(assigned)])
        broken = change(db, assigned, on=day(0))
        confirm(db, stale, fail='asset_flow_conflict')
        confirm(db, save(db, returning, [line(broken, condition='faulty')]))
        returned = get(assigned)
        assert returned['holder_party_id'] is None and returned['display_status'] == 'inventory_faulty'
        restored = change(db, returned, 'normal', day(0), '示例维修完成')
        assert restored['display_status'] == 'inventory_available'
        assert rpc(db, 'viewer', 'get_document', quoted(issued['id'])) == issued
        assert assigned['id'] not in {a['id'] for a in rpc(db, 'viewer', 'list_due_assets')['items']}
        print('PASS stale drafts and backdated handovers roll back; fault return, repair and frozen issue remain consistent')

        # Same-version races have one winner; current membership precedes replay.
        current = get(held)
        def compete(n):
            try: return change(db, current, on=day(0), reason='示例并发'+str(n))
            except AssertionError as error:
                assert 'asset_condition_conflict' in str(error); return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sum(v is not None for v in pool.map(compete,[1,2])) == 1
        db.run('UPDATE gear_2026.members SET status=\'disabled\',role=NULL WHERE id='+quoted(IDS['operator']))
        change(db, held, on=day(-2), request=request, fail='inventory_access_denied')
        assert db.run('SELECT id FROM unrelated.sentinel') == '7'
        print('PASS concurrent conflicts and revoked-role replay denial; unrelated application unchanged')
    print(json.dumps({'asset_condition_checks':'passed','production_access':False}))


if __name__ == '__main__': main()
