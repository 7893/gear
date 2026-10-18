"""Exercise draft isolation and atomic receipt/issue/return in disposable PG."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import date, timedelta
import json
from uuid import uuid4

from check_schema import IDS, ROOT, disposable_database, setup
from check_inventory import initialize, party, quoted, rpc


def save(db, details, items, user='operator', draft=None, request=None, fail=None):
    return rpc(db,user,'save_document',','.join([quoted(json.dumps(details)),quoted(json.dumps(items)),
        quoted(request or str(uuid4())),quoted(draft['id']) if draft else 'NULL',str(draft['version']) if draft else 'NULL']),fail)


def confirm(db, draft, user='operator', request=None, fail=None):
    return rpc(db,user,'confirm_document',f"'{draft['id']}',{draft['version']},'{request or uuid4()}'",fail)


def line(asset=None, condition='normal', **changes):
    return {'asset_id':asset['id'] if asset else None,'expected_asset_version':asset['version'] if asset else None,
        'new_asset_data':None if asset else {'name':'示例新设备','category':'power_strip','legacy_code':None},
        'condition_on_handover':condition,'location':'示例位置','note':'示例故障' if condition=='faulty' else '',
        'allow_legacy_duplicate':False,**changes}


def main():
    with disposable_database() as db:
        setup(db)
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if not path.name.endswith('initial_schema.sql'):
                db.run(path.read_text())
        today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
        base={'kind':'receipt','handover_on':today,'from_kind':'external','to_kind':'inventory',
            'from_label':'示例交付方','to_label':'经办人库存','sender_name':'示例移交人','receiver_name':'示例接收人'}
        before_assets=db.run('SELECT count(*) FROM gear.assets')
        initial_request=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            drafts=list(pool.map(lambda _:save(db,base,[line(),line(),line(condition='faulty')],request=initial_request),range(2)))
        assert drafts[0]==drafts[1]
        draft=drafts[0]
        assert draft['status']=='draft' and draft['document_no'] is None
        assert db.run('SELECT count(*) FROM gear.assets')==before_assets
        assert db.run('SELECT count(*) FROM gear.document_counters')=='0'
        assert draft['id'] not in {d['id'] for d in rpc(db,'viewer','list_documents')}
        rpc(db,'viewer','get_document',quoted(draft['id']),fail='document_not_found')
        save(db,base,[line()],user='viewer',fail='inventory_access_denied')
        confirmed=confirm(db,draft)
        assert confirmed['document_no'].startswith('LR-'+today.replace('-','')+'-')
        assert confirmed['confirmed_revision']==draft['version'] and confirmed['version']==draft['version']+1
        assert confirmed['evidence_state']=='awaiting_upload' and len(confirmed['items'])==3
        assert confirmed['header_snapshot']['title']=='设备簿'
        assert confirmed['header_snapshot']['operator_name']=='Example operator'
        assert rpc(db,'viewer','get_document',quoted(draft['id']))==confirmed
        assert db.run("SELECT count(*) FROM gear.events WHERE event_type='asset_initialized'")=='0'
        assert db.run('SELECT count(*) FROM gear.assets')==str(int(before_assets)+3)
        db.run(f"UPDATE gear.documents SET sender_name='forged' WHERE id='{draft['id']}'",fail='formal document fields are frozen')
        db.run(f"DELETE FROM gear.document_items WHERE document_id='{draft['id']}'",fail='formal document items are frozen')
        print('PASS drafts do not reserve stock/numbers; receipt atomically creates assets and frozen numbered evidence')

        person=party(db); team=party(db,details={'kind':'team','name':'示例团队','default_responsible_id':person['id']})
        received=[rpc(db,'operator','get_asset',quoted(i['asset_id']))['asset'] for i in confirmed['items']]
        issue={'kind':'issue','handover_on':today,'from_kind':'inventory','to_kind':'party','to_party_id':team['id'],
            'to_person_id':person['id'],'sender_name':'示例发放人','receiver_name':'示例领取人','usage_kind':'temporary',
            'due_on':(date.fromisoformat(today)+timedelta(days=30)).isoformat()}
        issuedraft=save(db,issue,[line(received[0]),line(received[1])]); request=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:confirm(db,issuedraft,request=request),range(2)))
        issued=results[0];assert results[0]==results[1]
        assert issued['document_no'].startswith('FF-')
        assert int(issued['document_no'].split('-')[-1])==int(confirmed['document_no'].split('-')[-1])+1
        assert db.run(f"SELECT count(*) FROM gear.assignments WHERE holder_party_id='{team['id']}' AND closed_at IS NULL")=='2'
        assert all(i['state_after']['holder_party_id']==team['id'] for i in issued['items'])
        db.run(f"UPDATE gear.parties SET name='示例更名团队' WHERE id='{team['id']}'")
        assert rpc(db,'viewer','get_document',quoted(issued['id']))==issued
        print('PASS concurrent confirmation retry creates one issue, shared daily numbers and immutable party snapshots')

        held=rpc(db,'operator','get_asset',quoted(received[0]['id']))['asset']
        returning={'kind':'return','handover_on':today,'from_kind':'party','to_kind':'inventory',
            'from_party_id':team['id'],'from_person_id':person['id'],'sender_name':'示例交回人','receiver_name':'示例收回人','remarks':'示例部分退回'}
        returned=confirm(db,save(db,returning,[line(held,condition='faulty')]))
        assert returned['document_no'].startswith('TH-')
        changed=rpc(db,'viewer','get_asset',quoted(held['id']))
        assert changed['asset']['display_status']=='inventory_faulty' and changed['asset']['holder_party_id'] is None
        assert changed['history'][0]['after_data']['document_id']==returned['id']
        still_held=rpc(db,'viewer','get_asset',quoted(received[1]['id']))['asset']
        assert still_held['holder_party_id']==team['id'] and still_held['due_on']==issue['due_on']
        assert rpc(db,'viewer','get_document',quoted(issued['id']))==issued
        upstream={**returning,'from_kind':'inventory','from_party_id':None,'from_person_id':None,'to_kind':'external','to_label':'示例上游单位'}
        exited=confirm(db,save(db,upstream,[line(changed['asset'],condition='faulty')]))
        exited_asset=rpc(db,'viewer','get_asset',quoted(held['id']))['asset']
        assert exited_asset['management_status']=='returned_upstream'
        reentered=confirm(db,save(db,base,[line(exited_asset)]))
        reentered_asset=rpc(db,'viewer','get_asset',quoted(held['id']))['asset']
        assert reentered_asset['asset_code']==held['asset_code'] and reentered_asset['display_status']=='inventory_available'
        assert reentered['items'][0]['asset_id']==held['id']
        print('PASS partial faulty return closes only selected use; upstream exit and same-device re-receipt preserve identity')

        bad=save(db,issue,[line(reentered_asset),line(received[2])]); count=db.run('SELECT count(*) FROM gear.assignments')
        confirm(db,bad,fail='asset_flow_conflict')
        assert db.run('SELECT count(*) FROM gear.assignments')==count
        assert rpc(db,'viewer','get_asset',quoted(held['id']))['asset']==reentered_asset
        assert rpc(db,'operator','get_document',quoted(bad['id']))['status']=='draft'
        stale=save(db,issue,[line(reentered_asset)])
        winner=save(db,issue,[line(reentered_asset)])
        with ThreadPoolExecutor(max_workers=2) as pool:
            def race(doc):
                try:return confirm(db,doc)
                except AssertionError as error:
                    assert 'asset_flow_conflict' in str(error);return None
            outcomes=list(pool.map(race,[stale,winner]))
        assert sum(o is not None for o in outcomes)==1
        print('PASS whole document rollback on mixed eligibility and exactly one winner for competing issues')

        future={**base,'handover_on':(date.fromisoformat(today)+timedelta(days=1)).isoformat()}
        confirm(db,save(db,future,[line()]),fail='incomplete_document')
        for invalid in ['today','2025-02-30']:
            save(db,{**base,'handover_on':invalid},[line()],fail='invalid_document_date')
        save(db,issue,[line(received[0]),line(received[0])],fail='duplicate_document_asset')
        wrong={**returning,'from_person_id':IDS['person2']}
        confirm(db,save(db,wrong,[line(still_held)]),fail='asset_flow_conflict')
        old={**returning,'handover_on':(date.fromisoformat(today)-timedelta(days=1)).isoformat()}
        confirm(db,save(db,old,[line(still_held)]),fail='invalid_document_date')
        stock=initialize(db,user='operator')
        personal={**issue,'to_party_id':person['id'],'to_person_id':person['id'],'usage_kind':'long_term','due_on':None}
        personal_doc=confirm(db,save(db,personal,[line(stock)]))
        assert personal_doc['items'][0]['state_after']['responsible_person_id']==person['id']
        print('PASS strict dates, duplicate devices, responsible-person grouping and personal long-term use')

        duplicated=line(new_asset_data={'name':'示例混合旧号设备','category':'printer','legacy_code':'00007/OLD'})
        duplicate_draft=save(db,base,[duplicated,deepcopy(duplicated)])
        confirm(db,duplicate_draft,fail='legacy_code_duplicate')
        fixed=deepcopy(duplicated);fixed['allow_legacy_duplicate']=True
        duplicate_draft=save(db,base,[duplicated,fixed],draft=duplicate_draft)
        duplicates=confirm(db,duplicate_draft)
        assert duplicates['items'][0]['asset_id']!=duplicates['items'][1]['asset_id']
        assert duplicates['items'][1]['asset_snapshot']['legacy_code']=='00007/OLD'
        deletion=save(db,base,[]);delete_request=str(uuid4())
        args=f"'{deletion['id']}',{deletion['version']},'{delete_request}'"
        assert rpc(db,'operator','delete_document',args)['deleted']
        assert rpc(db,'operator','delete_document',args)['deleted']
        assert db.run(f"SELECT count(*) FROM gear.events WHERE after_data->>'id'='{deletion['id']}' AND event_type='draft_deleted'")=='1'
        edit=save(db,base,[line()]);old_version=deepcopy(edit)
        edit=save(db,base,[line(),line()],draft=edit)
        save(db,base,[line()],draft=old_version,fail='document_conflict')
        confirm(db,old_version,fail='document_conflict')
        print('PASS old-code acknowledgement, draft audit retained after deletion and optimistic draft versions')
        db.run(f"INSERT INTO gear.members(id,auth_user_id,display_name,status,role) VALUES ('{IDS['other']}','{IDS['other']}','Example second operator','active','operator')")
        rpc(db,'other','get_document',quoted(edit['id']),fail='document_not_found')
        assert edit['id'] not in {d['id'] for d in rpc(db,'other','list_documents')}
        save(db,base,[line()],user='other',draft=edit,fail='draft_access_denied')
        confirm(db,edit,user='other',fail='draft_access_denied')
        save(db,{**base,'created_by':IDS['admin']},[line()],fail='invalid_document')
        save(db,base,[line(new_asset_data={'name':'Forged identity','category':'printer','asset_code':'FORGED'})],fail='invalid_document_item')
        save(db,base,[line(allow_legacy_duplicate='true')],fail='invalid_document_item')
        historic=confirm(db,save(db,{**base,'handover_on':'2000-01-01'},[line()]))
        assert historic['numbering_on']==today and historic['handover_on']=='2000-01-01'
        assert today.replace('-','') in historic['document_no']
        db.run(f"UPDATE gear.document_counters SET last_value=9999 WHERE business_on='{today}'")
        extended=confirm(db,save(db,base,[line()]))
        assert extended['document_no'].endswith('-10000')
        print('PASS foreign drafts stay private, caller identity cannot be supplied, business-day numbering expands')
        db.run("UPDATE gear.members SET status='disabled',role=NULL WHERE id='"+IDS['operator']+"'")
        confirm(db,issuedraft,request=request,fail='inventory_access_denied')
        for user in ['pending','disabled','unverified']:
            rpc(db,user,'list_documents',fail='inventory_access_denied')
        db.run('SET ROLE anon; SELECT gear.list_documents()',fail='permission denied')
        db.run('SET ROLE service_role; SELECT gear.list_documents()',fail='permission denied')
        db.run('SET ROLE authenticated; SELECT gear_private.document_record(NULL)',fail='permission denied')
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS lost permission blocks replays, helpers remain private and unrelated applications survive')
    print(json.dumps({'flow_rpc_checks':'passed','production_access':False}))


if __name__=='__main__':main()
