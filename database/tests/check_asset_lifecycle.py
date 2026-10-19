"""Lost, scrap, recover and erroneous initialization in disposable SQL only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import initialize, party, rpc, quoted
from check_flows import save, confirm, line
from check_asset_condition import change
from check_document_review import review

def lifecycle(db,asset,action='lost',on=None,details=None,reason='示例处置说明',request=None,user='admin',fail=None):
    return rpc(db,user,'change_asset_lifecycle',','.join([quoted(asset['id']),str(asset['version']),quoted(action),
        quoted(on) if on else 'NULL',quoted(json.dumps(details or {})),quoted(reason),quoted(request or str(uuid4()))]),fail=fail)

def placement(**kw):
    return {'condition':'normal','location':'示例找回位置','holder_party_id':None,'responsible_person_id':None,'usage_kind':None,'due_on':None,**kw}

def main():
    with disposable_database() as db:
        db.env['PGTZ']='UTC'
        setup(db);migration=ROOT/'database/migrations/202610190015_asset_lifecycle.sql'
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path<migration and not path.name.endswith('initial_schema.sql'):db.run(path.read_text())
        catalog="SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')";old_functions=json.loads(db.run(catalog))
        baseline=data(db,'gear_2026');db.run(migration.read_text());assert baseline==data(db,'gear_2026')
        new_functions=json.loads(db.run(catalog));assert len(new_functions)==len(old_functions)+3
        changed=[]
        for oid,entry in old_functions.items():
            assert entry[:-1]==new_functions[oid][:-1]
            if entry[-1]!=new_functions[oid][-1]:changed.append(entry[:2])
        assert changed==[['gear_private_2026','get_asset']]
        db.run(migration.read_text(),fail='asset_lifecycle_source_mismatch')
        for role in ['anon','service_role']:
            db.run('SET ROLE '+role+'; SELECT gear_2026.change_asset_lifecycle(NULL,NULL,NULL,NULL,NULL,NULL,NULL)',fail='permission denied')
        today=date.fromisoformat(db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date"));day=lambda n:(today+timedelta(days=n)).isoformat()
        get=lambda a:rpc(db,'viewer','get_asset',quoted(a['id']))['asset']
        stock=get(initialize(db,placement={'known_on':day(-10)}))
        for user in ['operator','viewer','pending','disabled','other','unverified']:
            lifecycle(db,stock,on=day(0),user=user,fail='asset_lifecycle_admin_required' if user=='operator' else 'inventory_access_denied')
        print('PASS additive migration preserves tables and current administrator-only authorization')

        p=party(db);team=party(db,details={'kind':'team','name':'示例处置团队','default_responsible_id':p['id']})
        held=get(initialize(db,placement={'holder_party_id':team['id'],'responsible_person_id':p['id'],
            'usage_kind':'temporary','due_on':day(2)}))
        docs=db.run("SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM gear_2026.documents d WHERE status<>'draft'");sequence=db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        nonce=str(uuid4());lost=lifecycle(db,held,on=day(-2),request=nonce)
        assert lost['management_status']=='lost' and lost['holder_party_id'] is None
        assert rpc(db,'viewer','list_due_assets')['items']==[]
        event=rpc(db,'viewer','get_asset',quoted(held['id']))['history'][0]
        assert event['before_data']['responsible_person_id']==p['id'] and event['before_data']['due_on']==day(2)
        assert lifecycle(db,held,on=day(-2),request=nonce)==lost
        lifecycle(db,held,on=day(-1),request=nonce,fail='request_conflict')
        found=lifecycle(db,lost,'found',day(-1),placement())
        assert found['display_status']=='inventory_available' and found['asset_code']==held['asset_code'] and found['due_on'] is None
        assert lifecycle(db,held,on=day(-2),request=nonce)==lost
        change(db,found,on=day(-2),fail='invalid_condition_date')
        issue={'kind':'issue','handover_on':day(-2),'from_kind':'inventory','to_kind':'party','to_party_id':p['id'],
            'to_person_id':p['id'],'sender_name':'示例经办人','receiver_name':'示例接收人','usage_kind':'long_term'}
        confirm(db,save(db,issue,[line(found)]),fail='invalid_document_date')
        assert get(found)==found, {k:(found.get(k),get(found).get(k)) for k in set(found)|set(get(found)) if found.get(k)!=get(found).get(k)}
        scrapped=lifecycle(db,found,'scrapped',day(0));assert scrapped['display_status']=='scrapped'
        lifecycle(db,scrapped,'found',day(0),placement(),fail='asset_lifecycle_transition')
        assert docs==db.run('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM gear_2026.documents d WHERE status<>\'draft\'')
        assert sequence==db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        print('PASS loss stops reminders, history retains last responsibility; recovery keeps number and resets placement; later backdating and scrap recovery denied')

        rejected=get(initialize(db));rejected=lifecycle(db,rejected,on=day(-2));unchanged=data(db,'gear_2026')
        for details, failure in [({**placement(),'condition':'unknown'},'invalid_asset_lifecycle'),
            ({**placement(),'due_on':day(2)},'invalid_asset_lifecycle'),
            ({**placement(),'holder_party_id':p['id']},'invalid_asset_lifecycle'),
            ({**placement(),'management_status':'managed'},'invalid_asset_lifecycle'),
            (placement(holder_party_id=p['id'],responsible_person_id=IDS['person2'],usage_kind='long_term'),'responsible_person_required'),
            (placement(holder_party_id=team['id'],responsible_person_id=p['id'],usage_kind='temporary',due_on=day(-3)),'invalid_lifecycle_date')]:
            lifecycle(db,rejected,'found',day(0),details,fail=failure)
        assert unchanged==data(db,'gear_2026')

        second=get(initialize(db));lost=lifecycle(db,second,on=day(-2))
        details={**placement(),'holder_party_id':team['id'],'responsible_person_id':p['id'],'usage_kind':'temporary','due_on':day(5),'condition':'faulty'}
        recovered=lifecycle(db,lost,'found',day(-1),details)
        assert recovered['display_status']=='in_use' and recovered['condition']=='faulty' and recovered['due_on']==day(5) and recovered['started_on']==day(-1)
        rows=json.loads(db.run('SELECT jsonb_agg(to_jsonb(a)) FROM gear_2026.assignments a WHERE asset_id='+quoted(second['id'])))
        assert len(rows)==1 and rows[0]['followup_member_id']==IDS['admin']
        original=get(initialize(db));nonce=str(uuid4());invalid=lifecycle(db,original,'invalidate',day(0),request=nonce)
        assert invalid['invalidated_at'] and invalid['asset_code']==original['asset_code']
        assert invalid['id'] not in {x['id'] for x in rpc(db,'viewer','list_assets')['items']}
        assert lifecycle(db,original,'invalidate',day(0),request=nonce)==invalid
        initialized=get(initialize(db,placement={'holder_party_id':p['id'],'responsible_person_id':p['id'],'usage_kind':'temporary','due_on':day(1)}))
        invalid=lifecycle(db,initialized,'invalidate',day(0));assert invalid['holder_party_id'] is None
        assert db.run('SELECT count(*) FROM gear_2026.assignments WHERE asset_id='+quoted(invalid['id'])+' AND closed_at IS NULL')=='0'
        lifecycle(db,recovered,'invalidate',day(0),fail='asset_invalidation_dependency')
        ready=get(initialize(db));formal=confirm(db,save(db,{**issue,'handover_on':day(0)},[line(ready)]))
        issued=get(ready);lifecycle(db,issued,'invalidate',day(0),fail='asset_invalidation_dependency')
        lifecycle(db,issued,on=day(0));review(db,formal,fail='document_has_dependencies')
        assert rpc(db,'viewer','get_document',quoted(formal['id']))==formal
        print('PASS explicit temporary/faulty recovery creates new assignment; initial invalidation retains identity, closes initial use and rejects dependent records')

        candidate=get(initialize(db,placement={'known_on':day(-2)}));baseline=data(db,'gear_2026')
        for on in [day(1),day(-3),'2026-02-30','today',None]:lifecycle(db,candidate,on=on,fail='invalid_lifecycle_date')
        lifecycle(db,candidate,on=day(0),reason=' ',fail='invalid_asset_lifecycle')
        lifecycle(db,candidate,on=day(0),details={'condition':'normal'},fail='invalid_asset_lifecycle')
        lifecycle(db,candidate,'found',day(0),placement(),fail='asset_lifecycle_transition')
        lifecycle(db,candidate,'invalidate',day(-1),fail='invalid_lifecycle_date')
        assert baseline==data(db,'gear_2026')
        def compete(action):
            try:return lifecycle(db,candidate,action,day(0))
            except AssertionError as error:assert 'asset_lifecycle_conflict' in str(error);return None
        with ThreadPoolExecutor(max_workers=2) as pool:assert sum(x is not None for x in pool.map(compete,['lost','scrapped']))==1
        candidate=get(initialize(db));nonce=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:lifecycle(db,candidate,on=day(0),request=nonce),[1,2]))
        assert results[0]==results[1] and db.run('SELECT count(*) FROM gear_2026.events WHERE request_id='+quoted(nonce))=='1'
        db.run("UPDATE gear_2026.members SET role='viewer' WHERE id="+quoted(IDS['admin']))
        lifecycle(db,candidate,on=day(0),request=nonce,fail='inventory_access_denied')
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS date/transition validation, transaction rollback, concurrency, stable replay and immediate role enforcement')
    print(json.dumps({'asset_lifecycle_checks':'passed','production_access':False}))

if __name__=='__main__':main()
