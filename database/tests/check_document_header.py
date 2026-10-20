"""Audited heading changes and immutable documents in disposable PostgreSQL only."""
from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import rpc, quoted
from check_flows import save, confirm, line

def edit(db, settings, title='示例单位设备管理', reason='示例抬头核对', request=None, user='admin', fail=None):
    return rpc(db,user,'update_document_header',','.join([str(settings['version']),quoted(title),quoted(reason),quoted(request or str(uuid4()))]),fail=fail)

def main():
    with disposable_database() as db:
        db.env['PGTZ']='UTC';setup(db)
        migration=ROOT/'database/migrations/202610190016_document_header.sql'
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path<migration and not path.name.endswith('initial_schema.sql'):db.run(path.read_text())
        catalog="SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')"
        baseline=data(db,'gear_2026');functions=json.loads(db.run(catalog));db.run(migration.read_text())
        assert baseline==data(db,'gear_2026');after=json.loads(db.run(catalog))
        assert len(after)==len(functions)+4 and all(after[k]==v for k,v in functions.items())
        db.run(migration.read_text(),fail='already exists');assert after==json.loads(db.run(catalog))
        settings=rpc(db,'admin','get_app_settings');assert settings['document_header']=='设备簿' and settings['history']==[]
        for role in ['anon','service_role']:
            db.run('SET ROLE '+role+'; SELECT gear_2026.get_app_settings()',fail='permission denied')
            db.run('SET ROLE '+role+'; SELECT gear_2026.update_document_header(NULL,NULL,NULL,NULL)',fail='permission denied')
        for user in ['operator','viewer','pending','disabled','other','unverified']:
            rpc(db,user,'get_app_settings',fail='admin_required' if user in ['operator','viewer'] else 'inventory_access_denied')
            edit(db,settings,user=user,fail='admin_required' if user=='operator' else 'inventory_access_denied')
        print('PASS additive four-function migration preserves all data, functions and ACLs; current verified administrator required')

        today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
        receipt={'kind':'receipt','handover_on':today,'from_kind':'external','to_kind':'inventory','from_label':'示例交付方',
            'sender_name':'示例交付人','receiver_name':'示例接收人'}
        original=confirm(db,save(db,receipt,[line()]));draft=save(db,receipt,[line()])
        protected=data(db,'gear_2026');other=db.run("SELECT to_jsonb(s)-ARRAY['document_header','version','updated_at'] FROM gear_2026.app_settings s")
        sequence=db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        nonce=str(uuid4());updated=edit(db,settings,request=nonce)
        assert updated=={'document_header':'示例单位设备管理','version':settings['version']+1}
        for table,rows in protected.items():
            if table not in ['app_settings','events']:assert rows==data(db,'gear_2026')[table]
        assert other==db.run("SELECT to_jsonb(s)-ARRAY['document_header','version','updated_at'] FROM gear_2026.app_settings s")
        assert sequence==db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        assert edit(db,settings,request=nonce)==updated
        event=rpc(db,'admin','get_app_settings')['history'][0]
        assert event['before_header']=='设备簿' and event['after_header']==updated['document_header'] and event['reason']=='示例抬头核对'
        later=edit(db,updated,'示例另一单位抬头')
        assert edit(db,settings,request=nonce)==updated
        edit(db,settings,request=nonce,title='其他请求内容',fail='request_conflict')
        assert rpc(db,'viewer','get_document',quoted(original['id']))==original
        newly_confirmed=confirm(db,draft)
        assert newly_confirmed['header_snapshot']['title']==later['document_header']
        assert original['header_snapshot']['title']=='设备簿'
        print('PASS heading-only update preserves mail/reminders, assets, assignments, original snapshots and numbers; earlier drafts use confirmation-time heading')

        baseline=data(db,'gear_2026')
        for title,reason in [(' ','原因'),('x'*121,'原因'),('示例\n多行','原因'),('示例标题',' '),('示例标题','x'*2001)]:
            edit(db,later,title,reason,fail='invalid_document_header')
        edit(db,later,later['document_header'],fail='settings_unchanged')
        edit(db,settings,'示例过期版本',fail='settings_conflict')
        assert baseline==data(db,'gear_2026')
        def compete(n):
            try:return edit(db,later,'示例并发抬头'+str(n))
            except AssertionError as error:assert 'settings_conflict' in str(error);return None
        with ThreadPoolExecutor(max_workers=2) as pool:assert sum(x is not None for x in pool.map(compete,[1,2]))==1
        latest=rpc(db,'admin','get_app_settings');nonce=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:edit(db,latest,'示例单次更新',request=nonce),[1,2]))
        assert results[0]==results[1] and db.run('SELECT count(*) FROM gear_2026.events WHERE request_id='+quoted(nonce))=='1'
        db.run("UPDATE gear_2026.members SET role='operator' WHERE id="+quoted(IDS['admin']))
        edit(db,latest,'示例单次更新',request=nonce,fail='admin_required')
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS required fields, no-op, version conflict, concurrent writers and retries; immediate role enforcement before replay')
    print(json.dumps({'document_header_checks':'passed','production_access':False}))

if __name__=='__main__':main()
