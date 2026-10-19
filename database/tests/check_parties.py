"""Recipient edits, deactivation and cross-flow preservation in disposable SQL."""
from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import initialize, party, rpc, quoted
from check_flows import save, confirm, line

FIELDS=['kind','name','person_type','organization_name','default_responsible_id','contact','note']
def edit(db, p, changes=None, active=True, reason='示例资料核对', request=None, user='operator', fail=None):
    details={key:p.get(key) for key in FIELDS};details.update(changes or {})
    return rpc(db,user,'update_party',','.join([quoted(p['id']),str(p['version']),quoted(json.dumps(details)),
        'true' if active else 'false',quoted(reason),quoted(request or str(uuid4()))]),fail=fail)

def main():
    with disposable_database() as db:
        db.env['PGTZ']='UTC'
        setup(db)
        migration=ROOT/'database/migrations/202610190014_parties.sql'
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path<migration and not path.name.endswith('initial_schema.sql'):db.run(path.read_text())
        old_request=str(uuid4());old=party(db,request=old_request)
        catalog="SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')";old_functions=json.loads(db.run(catalog))
        before=data(db,'gear_2026');db.run(migration.read_text());assert before==data(db,'gear_2026')
        new_functions=json.loads(db.run(catalog));assert len(new_functions)==len(old_functions)+7
        changed=[]
        for oid,entry in old_functions.items():
            assert entry[:-1]==new_functions[oid][:-1]
            if entry[-1]!=new_functions[oid][-1]:changed.append(entry[:2])
        assert changed==[['gear_private_2026','create_party']]
        assert party(db,request=old_request)==old
        db.run(migration.read_text(),fail='party_maintenance_source_mismatch')
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path>migration:db.run(path.read_text())
        for role in ['anon','service_role']:
            db.run('SET ROLE '+role+'; SELECT gear_2026.list_party_records()',fail='permission denied')
            db.run('SET ROLE '+role+'; SELECT gear_2026.update_party(NULL,NULL,NULL,NULL,NULL,NULL)',fail='permission denied')
        for user in ['viewer','pending','disabled','other','unverified']:
            edit(db,old,{'name':'示例无权修改'},user=user,fail='inventory_access_denied')
        for user in ['pending','disabled','other','unverified']:
            rpc(db,user,'list_party_records',fail='inventory_access_denied')
            rpc(db,user,'get_party',quoted(old['id']),fail='inventory_access_denied')
        print('PASS migration preserves data and old create retries; verified project roles and no direct service access')

        p=party(db,details={'kind':'person','name':'示例负责人','person_type':'attached','contact':'示例联系方式'})
        second=party(db);team=party(db,details={'kind':'team','name':'示例团队','default_responsible_id':p['id']})
        today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
        asset=rpc(db,'viewer','get_asset',quoted(initialize(db)['id']))['asset']
        issue={'kind':'issue','handover_on':today,'from_kind':'inventory','to_kind':'party','to_party_id':team['id'],
            'to_person_id':p['id'],'sender_name':'示例移交人','receiver_name':'示例接收人','usage_kind':'temporary','due_on':today}
        doc=confirm(db,save(db,issue,[line(asset)]));asset=rpc(db,'viewer','get_asset',quoted(asset['id']))['asset']
        assignments=db.run('SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM gear_2026.assignments a')
        code=db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        request=str(uuid4());renamed=edit(db,team,{'name':'示例更名团队','default_responsible_id':second['id']},request=request)
        assert renamed['version']==team['version']+1
        snapshot=rpc(db,'viewer','get_party',quoted(team['id']))['history'][0]
        assert snapshot['before_data']['default_responsible_name']==p['name'] and snapshot['after_data']['default_responsible_name']==second['name']
        assert edit(db,team,{'name':'示例更名团队','default_responsible_id':second['id']},request=request)==renamed
        edit(db,team,{'name':'示例更名团队'},request=request,fail='request_conflict')
        assert rpc(db,'viewer','get_document',quoted(doc['id']))==doc
        assert assignments==db.run('SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM gear_2026.assignments a')
        assert code==db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        current=rpc(db,'viewer','get_asset',quoted(asset['id']))['asset']
        assert current['holder_name']=='示例更名团队' and current['responsible_person_id']==p['id'] and current['due_on']==today
        edit(db,second,active=False,fail='party_default_in_use')
        stopped=edit(db,p,active=False);assert not stopped['is_active']
        assert stopped['id'] not in {x['id'] for x in rpc(db,'viewer','list_parties')}
        records=rpc(db,'viewer','list_party_records');row=next(x for x in records if x['id']==p['id'])
        assert row['current_asset_count']==1 and not row['is_active']
        assert len(rpc(db,'viewer','list_due_assets')['items'])==1
        initialize(db,placement={'holder_party_id':p['id'],'responsible_person_id':p['id'],'usage_kind':'long_term'},fail='holder_unavailable')
        # Returns from an inactive recipient remain possible, and use the actual assignment.
        returned=confirm(db,save(db,{'kind':'return','handover_on':today,'from_kind':'party','to_kind':'inventory',
            'from_party_id':team['id'],'from_person_id':p['id'],'sender_name':'示例退回人','receiver_name':'示例经办人','remarks':'示例实际退回'},[line(current)]))
        assert returned['status']=='confirmed' and not rpc(db,'viewer','list_due_assets')['items']
        stopped=edit(db,stopped,{'contact':'示例新联系信息'},active=False)
        restored=edit(db,stopped,user='admin');assert restored['is_active']
        detail=rpc(db,'viewer','get_party',quoted(p['id']));assert detail['history'][0]['before_data']['is_active'] is False
        assert detail['history'][0]['after_data']['is_active'] is True
        print('PASS team defaults never reassign assets; stopped holders retain responsibility and reminders until actual return; frozen documents preserved')

        baseline=data(db,'gear_2026')
        edit(db,restored,fail='party_unchanged');edit(db,p,{'name':'示例旧版'},fail='party_conflict')
        for changes in [{'kind':'team','person_type':None,'default_responsible_id':second['id']},
            {'version':9},{'name':' '},{'contact':'x'*201},{'note':[]},{'default_responsible_id':'bad'}]:
            edit(db,restored,changes,fail='party_kind_permanent' if changes.get('kind') else 'invalid_party')
        edit(db,restored,{'name':'示例新名称'},reason=' ',fail='invalid_party')
        assert baseline==data(db,'gear_2026')
        def compete(n):
            try:return edit(db,restored,{'name':'示例并发'+str(n)})
            except AssertionError as error:assert 'party_conflict' in str(error);return None
        with ThreadPoolExecutor(max_workers=2) as pool:assert sum(x is not None for x in pool.map(compete,[1,2]))==1
        latest=rpc(db,'viewer','get_party',quoted(p['id']))['party'];nonce=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:edit(db,latest,{'note':'示例同次修改'},request=nonce),[1,2]))
        assert results[0]==results[1]
        db.run("UPDATE gear_2026.members SET status='disabled',role=NULL WHERE id="+quoted(IDS['operator']))
        edit(db,latest,{'note':'示例同次修改'},request=nonce,fail='inventory_access_denied')
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS strict fields, no-op and stale conflicts; concurrent retries audit once; current permissions checked before replay')
    print(json.dumps({'party_checks':'passed','production_access':False}))

if __name__=='__main__':main()
