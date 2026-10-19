"""Descriptive equipment corrections in disposable PostgreSQL only."""
from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import initialize, party, rpc, quoted
from check_flows import save, confirm, line
from check_document_review import review

FIELDS=['name','category','legacy_code','serial_number','brand','model','location','note']
def edit(db, asset, changes=None, reason='示例资料核对', request=None, ack=False, user='operator', fail=None, raw=None):
    details={key:asset.get(key) for key in FIELDS} if raw is None else raw
    if changes: details={**details,**changes}
    args=','.join([quoted(asset['id']),str(asset['version']),quoted(json.dumps(details)),quoted(reason),quoted(request or str(uuid4())),'true' if ack else 'false'])
    return rpc(db,user,'update_asset_details',args,fail=fail)


def main():
    with disposable_database() as db:
        db.env['PGTZ']='UTC';setup(db);migration=ROOT/'database/migrations/202610190013_asset_details.sql'
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path<migration and not path.name.endswith('initial_schema.sql'):db.run(path.read_text())
        catalog="SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')"
        before=json.loads(db.run(catalog));before_data=data(db,'gear_2026')
        db.run(migration.read_text());after=json.loads(db.run(catalog))
        assert len(after)==len(before)+2 and all(after[k]==v for k,v in before.items())
        assert before_data==data(db,'gear_2026')
        db.run(migration.read_text(),fail='already exists');assert json.loads(db.run(catalog))==after
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path>migration:db.run(path.read_text())
        for role in ['anon','service_role']:
            db.run('SET ROLE '+role+'; SELECT gear_2026.update_asset_details(NULL,NULL,NULL,NULL,NULL)',fail='permission denied')
        get=lambda asset:rpc(db,'viewer','get_asset',quoted(asset['id']))['asset']
        stock=get(initialize(db,details={'legacy_code':'00001'}))
        for user in ['viewer','pending','disabled','other','unverified']:
            edit(db,stock,{'name':'示例未授权更改'},user=user,fail='inventory_access_denied')
        print('PASS migration adds only two functions, preserves data and existing ACLs, safely rejects replay and denies unauthorized roles')

        person=party(db);team=party(db,details={'kind':'team','name':'示例资产组','default_responsible_id':person['id']})
        due=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date+14")
        held=get(initialize(db,details={'condition':'faulty'},placement={'holder_party_id':team['id'],'responsible_person_id':person['id'],'usage_kind':'temporary','due_on':due}))
        assignments=db.run('SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM gear_2026.assignments a')
        docs=db.run('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM gear_2026.documents d')
        sequence=db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        changes={'name':'示例核对后的打印机','category':'smart_display','model':'示例型号乙','serial_number':'0000007','location':'示例位置乙','note':'示例补充配件'}
        nonce=str(uuid4());first=edit(db,held,changes,request=nonce)
        assert first['version']==held['version']+1 and first['asset_code']==held['asset_code']
        assert first['condition']=='faulty' and first['started_on'] is None and first['due_on']==due
        assert {k:v for k,v in first.items() if k not in FIELDS+['version','updated_at']}=={k:v for k,v in held.items() if k not in FIELDS+['version','updated_at']}, {k:(held.get(k),first.get(k)) for k in set(first)|set(held) if k not in FIELDS+['version','updated_at'] and held.get(k)!=first.get(k)}
        assert assignments==db.run('SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM gear_2026.assignments a')
        assert docs==db.run('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM gear_2026.documents d')
        assert sequence==db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        event=json.loads(db.run('SELECT to_jsonb(e) FROM gear_2026.events e WHERE request_id='+quoted(nonce)))
        assert event['event_type']=='asset_updated' and not event['affects_asset_state'] and event['before_data']==held and {k:v for k,v in event['after_data'].items() if k!='previous_details'}==first
        assert event['after_data']['previous_details']=={k:held.get(k) for k in FIELDS}
        assert edit(db,held,changes,request=nonce)==first
        later=edit(db,first,{'name':'示例第二次更正'},user='admin')
        assert edit(db,held,changes,request=nonce)==first and get(held)==later
        edit(db,held,changes,request=nonce,reason='另一原因',fail='request_conflict')
        edit(db,held,changes,request=nonce,user='admin',fail='request_conflict')
        edit(db,later,fail='asset_details_unchanged')
        edit(db,held,{'name':'示例过期更改'},fail='asset_details_conflict')
        print('PASS audited snapshots, unknown dates, permanent numbers, faulty team assignments and immutable idempotent result preserved')

        baseline=data(db,'gear_2026')
        for key,value in [('condition','normal'),('asset_code','SB-FAKE'),('holder_party_id',person['id']),('due_on',due),('management_status','lost'),('version',1)]:
            edit(db,later,{key:value},fail='invalid_asset_details')
        for changes in [{'name':' '},{'name':'x'*121},{'category':'unknown'},{'note':'x'*2001},{'model':{}},{'serial_number':7}]:
            edit(db,later,changes,fail='invalid_asset_details')
        edit(db,later,{'name':'示例修改'},reason=' ',fail='invalid_asset_details')
        edit(db,later,{'name':'示例修改'},reason='x'*2001,fail='invalid_asset_details')
        edit(db,later,raw={'name':'示例缺少字段'},fail='invalid_asset_details')
        assert baseline==data(db,'gear_2026')
        duplicate=get(initialize(db,details={'legacy_code':'00007 / A'}))
        edit(db,stock,{'legacy_code':' 00007 / A '},fail='legacy_code_duplicate')
        updated=edit(db,stock,{'legacy_code':' 00007 / A '},ack=True)
        assert updated['legacy_code']==' 00007 / A '
        updated=edit(db,updated,{'brand':'示例品牌更正'})
        assert updated['legacy_code']==' 00007 / A ' and get(duplicate)['legacy_code']=='00007 / A'
        invalid=get(initialize(db))
        db.run('UPDATE gear_2026.assets SET invalidated_at=now(),invalidated_by='+quoted(IDS['admin'])+",invalid_reason='示例误建' WHERE id="+quoted(invalid['id']))
        edit(db,get(invalid),{'name':'示例无效记录更改'},fail='asset_details_unavailable')
        for state in ['returned_upstream','lost','scrapped']:
            exited=get(initialize(db));db.run('UPDATE gear_2026.assets SET management_status='+quoted(state)+' WHERE id='+quoted(exited['id']))
            assert edit(db,get(exited),{'model':'示例历史资料核对'})['management_status']==state
        print('PASS strict field allowlist, lengths, invalid records, no-op and stale versions; duplicate legacy codes require acknowledgement without merging')

        today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
        issue={'kind':'issue','handover_on':today,'from_kind':'inventory','to_kind':'party','to_party_id':person['id'],'to_person_id':person['id'],'sender_name':'示例移交人','receiver_name':'示例接收人','usage_kind':'long_term'}
        eligible=get(initialize(db));draft=save(db,issue,[line(eligible)])
        corrected=edit(db,eligible,{'name':'示例草稿后更正'})
        confirm(db,draft,fail='asset_flow_conflict')
        formal=confirm(db,save(db,issue,[line(corrected)]));assigned=get(eligible)
        new=edit(db,assigned,{'model':'示例新型号'})
        assert rpc(db,'viewer','get_document',quoted(formal['id']))==formal
        review(db,formal)
        restored=get(eligible);assert restored['holder_party_id'] is None and restored['model']=='示例新型号'
        formal=confirm(db,save(db,issue,[line(restored)]));assigned=get(eligible)
        edit(db,assigned,{'location':'示例不同位置'})
        review(db,formal,fail='document_state_conflict')
        print('PASS stale handover drafts rejected; formal snapshots frozen; descriptive edits survive valid voids while conflicting locations block reversal')

        candidate=get(initialize(db))
        def compete(n):
            try:return edit(db,candidate,{'name':'示例并发'+str(n)})
            except AssertionError as error:
                assert 'asset_details_conflict' in str(error);return None
        with ThreadPoolExecutor(max_workers=2) as pool:assert sum(x is not None for x in pool.map(compete,[1,2]))==1
        candidate=get(candidate);request=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:edit(db,candidate,{'note':'示例同次重试'},request=request),[1,2]))
        assert results[0]==results[1] and db.run('SELECT count(*) FROM gear_2026.events WHERE request_id='+quoted(request))=='1'
        db.run("UPDATE gear_2026.members SET status='disabled',role=NULL WHERE id="+quoted(IDS['operator']))
        edit(db,candidate,{'note':'示例同次重试'},request=request,fail='inventory_access_denied')
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS concurrent edits, same-request deduplication and current-role replay checks; unrelated application preserved')
    print(json.dumps({'asset_details_checks':'passed','production_access':False}))

if __name__=='__main__':main()
