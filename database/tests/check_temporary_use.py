"""Temporary-use dates, concurrency and frozen handovers in disposable PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_inventory import initialize, party, rpc, quoted
from check_flows import save, confirm, line


def extend(db, asset, due, user='operator', reason='示例延期原因', request=None, fail=None):
    return rpc(db, user, 'extend_assignment', ','.join([
        quoted(asset['id']), str(asset['version']), quoted(due), quoted(reason),
        quoted(request or str(uuid4())),
    ]), fail=fail)


def main():
    with disposable_database() as db:
        setup(db)
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if not path.name.endswith('initial_schema.sql'):
                db.run(path.read_text())
        db.run((ROOT/'database/migrations/202610190009_temporary_use.sql').read_text(), fail='already exists')
        today = date.fromisoformat(db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date"))
        day = lambda n: (today + timedelta(days=n)).isoformat()
        person = party(db)
        team = party(db, details={'kind':'team','name':'示例团队','default_responsible_id':person['id']})
        def temporary(n):
            return initialize(db, placement={'holder_party_id':team['id'], 'responsible_person_id':person['id'],
                'usage_kind':'temporary', 'known_on':day(-40), 'due_on':day(n)})
        held = [rpc(db,'viewer','get_asset',quoted(temporary(n)['id']))['asset'] for n in [-2, 0, 1, 3, 4]]
        initialize(db)  # Inventory must not enter follow-up.
        initialize(db, placement={'holder_party_id':person['id'],'responsible_person_id':person['id'],
            'usage_kind':'long_term','known_on':None,'due_on':None})
        due = rpc(db, 'viewer', 'list_due_assets')
        assert due['business_on'] == day(0) and due['notice_days'] == 3
        assert due['summary'] == {'total':5,'overdue':1,'today':1,'upcoming':2,'later':1}
        assert [a['due_on'] for a in due['items']] == [day(n) for n in [-2,0,1,3,4]]
        for state, count in [('overdue',1),('today',1),('upcoming',2),('later',1)]:
            assert len(rpc(db,'viewer','list_due_assets',quoted(state))['items']) == count
        rpc(db,'viewer','list_due_assets',"'wrong'",fail='invalid_due_filter')
        # A caller's PostgreSQL timezone does not change the business date or buckets.
        raw=db.as_user('viewer',"SET LOCAL timezone='Pacific/Honolulu'; SELECT gear_2026.list_due_assets()")
        assert json.loads(raw) == due
        db.run('UPDATE gear_2026.app_settings SET reminder_lead_days=2 WHERE id=1')
        changed=rpc(db,'viewer','list_due_assets')
        assert changed['notice_days']==2 and changed['summary']['upcoming']==1 and changed['summary']['later']==2
        db.run('UPDATE gear_2026.app_settings SET reminder_lead_days=3 WHERE id=1')
        print('PASS current temporary uses only; Shanghai date and day-zero/day-three boundaries')

        before_docs=db.run('SELECT md5(coalesce(jsonb_agg(to_jsonb(d)),\'[]\'::jsonb)::text) FROM gear_2026.documents d')
        seq=db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        request=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:extend(db,held[0],day(10),request=request),range(2)))
        result=results[0];assert results[0]==results[1]
        assert result['version']==held[0]['version']+1 and result['due_on']==day(10)
        assert result['previous_due_on']==day(-2) and result['holder_party_id']==team['id']
        detail=rpc(db,'viewer','get_asset',quoted(held[0]['id']))
        event=detail['history'][0]
        assert event['event_type']=='assignment_extended' and event['reason']=='示例延期原因'
        assert event['after_data']['previous_due_on']==day(-2) and event['after_data']['due_on']==day(10)
        assert rpc(db,'viewer','get_asset',quoted(held[1]['id']))['asset']==held[1]
        assert db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')==seq
        assert db.run('SELECT md5(coalesce(jsonb_agg(to_jsonb(d)),\'[]\'::jsonb)::text) FROM gear_2026.documents d')==before_docs
        extend(db,held[0],day(11),request=request,fail='request_conflict')
        extend(db,held[0],day(12),fail='assignment_conflict')
        for invalid in [day(0), day(-1), '2025-02-30', 'infinity', '0000-01-01']:
            extend(db,held[1],invalid,fail='invalid_extension_date')
        extend(db,held[1],day(10),reason='  ',fail='invalid_extension')
        for user in ['viewer','pending','disabled','unverified','other']:
            extend(db,held[1],day(10),user=user,fail='inventory_access_denied')
        for user in ['pending','disabled','unverified','other']:
            rpc(db,user,'list_due_assets',fail='inventory_access_denied')
        db.run('SET ROLE anon; SELECT gear_2026.list_due_assets()',fail='permission denied')
        db.run('SET ROLE service_role; SELECT gear_2026.list_due_assets()',fail='permission denied')
        db.run('SET ROLE service_role; SELECT gear_2026.extend_assignment(NULL,NULL,NULL,NULL,NULL)',fail='permission denied')
        print('PASS concurrent retry is one event; partial extension, date checks, versions and write roles')

        # Confirm a real (fictional) issue, then extend one of its two devices.
        receipt={'kind':'receipt','handover_on':day(0),'from_kind':'external','to_kind':'inventory',
            'from_label':'示例交付方','sender_name':'示例移交人','receiver_name':'示例接收人'}
        received=confirm(db,save(db,receipt,[line(),line()]))
        assets=[rpc(db,'operator','get_asset',quoted(i['asset_id']))['asset'] for i in received['items']]
        issue={'kind':'issue','handover_on':day(0),'from_kind':'inventory','to_kind':'party',
            'to_party_id':team['id'],'to_person_id':person['id'],'sender_name':'示例发放人',
            'receiver_name':'示例领取人','usage_kind':'temporary','due_on':day(10)}
        issued=confirm(db,save(db,issue,[line(a) for a in assets]))
        held_asset=rpc(db,'operator','get_asset',quoted(assets[0]['id']))['asset']
        returning={'kind':'return','handover_on':day(0),'from_kind':'party','to_kind':'inventory',
            'from_party_id':team['id'],'from_person_id':person['id'],'sender_name':'示例交回人','receiver_name':'示例收回人','remarks':'示例部分退回'}
        old_return=save(db,returning,[line(held_asset)])
        extend(db,held_asset,day(20))
        confirm(db,old_return,fail='asset_flow_conflict')
        assert rpc(db,'viewer','get_document',quoted(issued['id']))==issued
        fresh=rpc(db,'viewer','get_asset',quoted(assets[0]['id']))['asset']
        confirm(db,save(db,returning,[line(fresh)]))
        returned=rpc(db,'viewer','get_asset',quoted(assets[0]['id']))['asset']
        extend(db,returned,day(30),fail='assignment_not_temporary')
        assert returned['id'] not in {a['id'] for a in rpc(db,'viewer','list_due_assets')['items']}
        # Two different requests against the same version have one winner.
        def compete(n):
            try:return extend(db,held[2],day(n))
            except AssertionError as error:
                assert 'assignment_conflict' in str(error);return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sum(value is not None for value in pool.map(compete,[20,21]))==1
        db.run(f"UPDATE gear_2026.members SET status='disabled',role=NULL WHERE id={quoted(IDS['operator'])}")
        extend(db,result,day(30),fail='inventory_access_denied')
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS frozen issue preserved; stale return conflicts, actual return ends follow-up, revoked identity denied')
    print(json.dumps({'temporary_use_checks':'passed','production_access':False}))


if __name__=='__main__':main()
