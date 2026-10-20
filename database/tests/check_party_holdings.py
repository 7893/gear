"""Exact holdings and team actual users in disposable PostgreSQL only."""
from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import initialize, party, rpc, quoted
from check_flows import save, confirm, line
from check_document_review import review
from check_asset_lifecycle import lifecycle, placement

def annotate(db,asset,person=None,reason='示例实际使用人核对',request=None,user='operator',fail=None):
    return rpc(db,user,'set_assignment_user',','.join([quoted(asset['id']),str(asset['version']),
        quoted(person['id']) if person else 'NULL',quoted(reason),quoted(request or str(uuid4()))]),fail=fail)

def holdings(db,p,relationship='holding',user='viewer',fail=None):
    return rpc(db,user,'list_party_assets',quoted(p['id'])+','+quoted(relationship),fail=fail)

def main():
    with disposable_database() as db:
        db.env['PGTZ']='UTC';setup(db);migration=ROOT/'database/migrations/202610190017_party_holdings.sql'
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path<migration and not path.name.endswith('initial_schema.sql'):db.run(path.read_text())
        catalog="SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')"
        before=data(db,'gear_2026');functions=json.loads(db.run(catalog))
        db.run(migration.read_text());after=data(db,'gear_2026')
        stripped=db.run("SELECT md5(coalesce(jsonb_agg(to_jsonb(t)-'actual_user_id' ORDER BY (to_jsonb(t)-'actual_user_id')::text),'[]'::jsonb)::text) FROM gear_2026.assignments t")
        assert before=={**after,'assignments':stripped}
        updated=json.loads(db.run(catalog));assert len(updated)==len(functions)+5
        changes=[]
        for oid,value in functions.items():
            assert value[:-1]==updated[oid][:-1]
            if value[-1]!=updated[oid][-1]:changes.append(value[:2])
        assert changes==[['gear_private_2026','asset_record']]
        db.run(migration.read_text(),fail='party_holdings_source_mismatch')
        assert after==data(db,'gear_2026') and updated==json.loads(db.run(catalog))
        for role in ['anon','service_role']:
            db.run('SET ROLE '+role+'; SELECT gear_2026.list_party_assets(NULL)',fail='permission denied')
            db.run('SET ROLE '+role+'; SELECT gear_2026.set_assignment_user(NULL,NULL,NULL,NULL,NULL)',fail='permission denied')
        get=lambda asset:rpc(db,'viewer','get_asset',quoted(asset['id']))['asset']
        p=party(db,details={'kind':'person','name':'示例同名人员','person_type':'temporary'})
        twin=party(db,details={'kind':'person','name':'示例同名人员','person_type':'staff'})
        user=party(db);team=party(db,details={'kind':'team','name':'示例团队甲','default_responsible_id':p['id']})
        team2=party(db,details={'kind':'team','name':'示例团队乙','default_responsible_id':twin['id']})
        for actor in ['pending','disabled','other','unverified']:
            holdings(db,p,user=actor,fail='inventory_access_denied')
        stock=get(initialize(db))
        for actor in ['viewer','pending','disabled','other','unverified']:
            annotate(db,stock,user, user=actor,fail='inventory_access_denied')
        print('PASS guarded migration preserves old rows/functions/ACLs; one nullable assignment field and verified project roles')

        personal=get(initialize(db,placement={'holder_party_id':p['id'],'responsible_person_id':p['id'],'usage_kind':'long_term'}))
        other=get(initialize(db,placement={'holder_party_id':twin['id'],'responsible_person_id':twin['id'],'usage_kind':'long_term'}))
        held=get(initialize(db,placement={'holder_party_id':team['id'],'responsible_person_id':p['id'],'usage_kind':'temporary','due_on':'2030-01-01'}))
        assert personal['actual_user_id']==p['id'] and personal['actual_user_name']==p['name']
        assert [a['id'] for a in holdings(db,p)['items']]==[personal['id']]
        assert [a['id'] for a in holdings(db,twin)['items']]==[other['id']]
        assert [a['id'] for a in holdings(db,p,'responsible')['items']]==[held['id']]
        assert holdings(db,p,'actual')['items']==[] and holdings(db,user)['items']==[]
        assert holdings(db,team)['items'][0]['id']==held['id']
        holdings(db,team,'actual',fail='invalid_party_asset_filter');holdings(db,p,'bad',fail='invalid_party_asset_filter')
        print('PASS same-name recipients never merge; holding, team responsibility and actual use are distinct; inactive parties remain readable')

        assignment=lambda asset:json.loads(db.run('SELECT to_jsonb(a) FROM gear_2026.assignments a WHERE asset_id='+quoted(asset['id'])+' AND closed_at IS NULL'))
        old_assignment=assignment(held);docs=db.run('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM gear_2026.documents d')
        sequence=db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence');nonce=str(uuid4())
        assigned=annotate(db,held,user,request=nonce)
        assert assigned['actual_user_id']==user['id'] and assigned['version']==held['version']+1
        assert {k:v for k,v in assignment(held).items() if k not in ['actual_user_id','updated_at']}=={k:v for k,v in old_assignment.items() if k not in ['actual_user_id','updated_at']}
        assert {k:v for k,v in assigned.items() if k not in ['actual_user_id','actual_user_name','version','updated_at']}=={k:v for k,v in held.items() if k not in ['actual_user_id','actual_user_name','version','updated_at']}
        assert docs==db.run('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM gear_2026.documents d')
        assert sequence==db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        assert holdings(db,user,'actual')['items'][0]['id']==held['id']
        assert annotate(db,held,user,request=nonce)==assigned
        annotate(db,held,p,request=nonce,fail='request_conflict')
        annotate(db,held,p,fail='assignment_user_conflict')
        annotate(db,assigned,user,fail='assignment_user_unchanged')
        annotate(db,assigned,team,fail='actual_user_unavailable')
        annotate(db,personal,user,fail='assignment_user_unavailable')
        annotate(db,stock,user,fail='assignment_user_unavailable')
        annotate(db,assigned,p,reason=' ',fail='invalid_assignment_user')
        event=rpc(db,'viewer','get_asset',quoted(held['id']))['history'][0]
        assert event['event_type']=='assignment_user_changed' and event['before_data']['actual_user_id'] is None and event['after_data']['actual_user_name']==user['name']
        db.run('UPDATE gear_2026.parties SET is_active=false WHERE id='+quoted(user['id']))
        assert holdings(db,user,'actual')['items'][0]['id']==held['id']
        cleared=annotate(db,assigned);assert cleared['actual_user_id'] is None
        annotate(db,cleared,user,fail='actual_user_unavailable')
        joined=annotate(db,cleared,p);assert len(holdings(db,p,'all')['items'])==2
        assert annotate(db,held,user,request=nonce)==assigned
        print('PASS annotation preserves assignment identity, holder/responsibility/deadline, documents and numbers; stopped users, clearing, no-op and original-result retry handled')

        today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
        ready=get(initialize(db));issue={'kind':'issue','handover_on':today,'from_kind':'inventory','to_kind':'party',
            'to_party_id':team['id'],'to_person_id':p['id'],'sender_name':'示例移交人','receiver_name':'示例接收人','usage_kind':'temporary','due_on':'2030-01-01'}
        formal=confirm(db,save(db,issue,[line(ready)]));assigned=annotate(db,get(ready),twin)
        assert rpc(db,'viewer','get_document',quoted(formal['id']))==formal
        review(db,formal,fail='document_has_dependencies')
        change={'kind':'transfer','transfer_mode':'responsibility','handover_on':today,'from_kind':'party','to_kind':'party',
            'from_party_id':team['id'],'to_party_id':team['id'],'from_person_id':p['id'],'to_person_id':twin['id'],
            'sender_name':'示例原负责人','receiver_name':'示例新负责人'}
        original_assignment=assignment(ready)
        responsibility=confirm(db,save(db,change,[line(assigned)]));changed=get(ready)
        assert changed['actual_user_id']==twin['id'] and assignment(ready)['id']==original_assignment['id']
        review(db,responsibility);assert get(ready)['actual_user_id']==twin['id']
        transferred=confirm(db,save(db,{**change,'transfer_mode':'holder','to_party_id':team2['id'],'usage_kind':'long_term'},[line(get(ready))]))
        assert get(ready)['actual_user_id'] is None
        review(db,transferred);assert get(ready)['actual_user_id']==twin['id']
        lost=lifecycle(db,get(ready),on=today);assert lost['actual_user_id'] is None
        recovered=lifecycle(db,lost,'found',today,placement(holder_party_id=team['id'],responsible_person_id=p['id'],usage_kind='long_term'))
        assert recovered['actual_user_id'] is None
        print('PASS formal snapshots frozen; annotation blocks unsafe old voids; same-team handover preserves user, holder transfer/recovery resets it, valid void restores old assignment')

        candidate=joined
        def compete(person):
            try:return annotate(db,candidate,person)
            except AssertionError as error:assert 'assignment_user_conflict' in str(error);return None
        with ThreadPoolExecutor(max_workers=2) as pool:assert sum(x is not None for x in pool.map(compete,[twin,None]))==1
        candidate=get(candidate);nonce=str(uuid4());new_person=p if candidate['actual_user_id']!=p['id'] else twin
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:annotate(db,candidate,new_person,request=nonce),[1,2]))
        assert results[0]==results[1] and db.run('SELECT count(*) FROM gear_2026.events WHERE request_id='+quoted(nonce))=='1'
        db.run("UPDATE gear_2026.members SET status='disabled',role=NULL WHERE id="+quoted(IDS['operator']))
        annotate(db,candidate,new_person,request=nonce,fail='inventory_access_denied')
        db.run('UPDATE gear_2026.assignments SET actual_user_id='+quoted(team['id'])+' WHERE asset_id='+quoted(held['id'])+' AND closed_at IS NULL',fail='invalid_assignment_user')
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS concurrent writers and same-request retries serialize; current authorization and assignment user relation enforced')
    print(json.dumps({'party_holdings_checks':'passed','production_access':False}))

if __name__=='__main__':main()
