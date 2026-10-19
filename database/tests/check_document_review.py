"""Administrator document reversals/corrections; disposable PostgreSQL only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import rpc, quoted, initialize, party
from check_flows import line, save, confirm
from check_asset_condition import change
from check_temporary_use import extend
from check_evidence import reserve, finish, archive


def review(db, doc, action='void_document', user='admin', reason='示例误录原因',
           statement='示例更正说明：实际接收人姓名录入有误', replacement=None, request=None, fail=None):
    args=[quoted(doc['id']),str(doc['version']),quoted(reason)]
    if action=='correct_document':args += [quoted(statement),quoted(replacement['id']) if replacement else 'NULL']
    args += [quoted(request or str(uuid4()))]
    return rpc(db,user,action,','.join(args),fail=fail)


def main():
    with disposable_database() as db:
        db.env['PGTZ']='UTC';setup(db)
        migration=ROOT/'database/migrations/202610190012_document_review.sql'
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path<migration and not path.name.endswith('initial_schema.sql'):db.run(path.read_text())
        before=data(db,'gear_2026')
        catalog="SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')"
        old=json.loads(db.run(catalog))
        old_constraint=db.run("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='gear_2026.events'::regclass AND conname='events_event_type_check'")
        db.run('ALTER TABLE gear_2026.events DROP CONSTRAINT events_event_type_check; ALTER TABLE gear_2026.events ADD CONSTRAINT events_event_type_check CHECK (true)')
        db.run(migration.read_text(),fail='document_review_source_mismatch')
        assert json.loads(db.run(catalog))==old and data(db,'gear_2026')==before
        db.run('ALTER TABLE gear_2026.events DROP CONSTRAINT events_event_type_check; ALTER TABLE gear_2026.events ADD CONSTRAINT events_event_type_check '+old_constraint)
        db.run(migration.read_text());new=json.loads(db.run(catalog))
        assert before==data(db,'gear_2026') and len(new)==len(old)+5
        changed=[]
        for oid,value in old.items():
            assert value[:-1]==new[oid][:-1]
            if value[-1]!=new[oid][-1]:changed.append(value[:2])
        assert changed==[['gear_private_2026','document_record']]
        db.run(migration.read_text(),fail='document_review_source_mismatch')
        assert json.loads(db.run(catalog))==new
        print('PASS guarded migration preserves data, original function identities/ACLs and adds five functions')
        today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
        get=lambda a:rpc(db,'viewer','get_asset',quoted(a['id']))['asset']
        document=lambda d:rpc(db,'viewer','get_document',quoted(d['id']))
        current=lambda a:json.loads(db.run('SELECT to_jsonb(x) FROM gear_2026.assignments x WHERE asset_id='+quoted(a['id'])+' AND closed_at IS NULL') or 'null')
        receipt={'kind':'receipt','handover_on':today,'from_kind':'external','to_kind':'inventory',
            'from_label':'示例上游','sender_name':'示例交付人','receiver_name':'示例经办人'}
        person=party(db);second=party(db,details={'kind':'person','name':'示例接替人','person_type':'temporary'})
        team=party(db,details={'kind':'team','name':'示例团队','default_responsible_id':person['id']})
        issue={'kind':'issue','handover_on':today,'from_kind':'inventory','to_kind':'party',
            'to_party_id':team['id'],'to_person_id':person['id'],'sender_name':'示例经办人',
            'receiver_name':'示例负责人','usage_kind':'temporary','due_on':today}
        returning={'kind':'return','handover_on':today,'from_kind':'party','to_kind':'inventory',
            'from_party_id':team['id'],'from_person_id':person['id'],'sender_name':'示例交回人',
            'receiver_name':'示例经办人','remarks':'示例实际退回'}
        def received(n=1):return confirm(db,save(db,receipt,[line() for _ in range(n)]))
        def assets(doc):return [get({'id':i['asset_id']}) for i in doc['items']]
        def issued():
            incoming=received(2);stock=assets(incoming)
            return incoming,confirm(db,save(db,issue,[line(a) for a in stock])),stock

        incoming,outgoing,stock=issued();holds=[current(a) for a in stock]
        request=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:review(db,outgoing,request=request),range(2)))
        assert results[0]==results[1] and results[0]['status']=='voided'
        frozen=document(outgoing)
        assert frozen['items']==outgoing['items'] and frozen['parties_snapshot']==outgoing['parties_snapshot']
        assert frozen['document_no']==outgoing['document_no'] and frozen['version']>outgoing['version']
        assert len(frozen['changes'])==1 and frozen['changes'][0]['event_type']=='document_voided'
        for a in stock:
            assert get(a)['display_status']=='inventory_available' and current(a) is None
            history=rpc(db,'viewer','get_asset',quoted(a['id']))['history']
            assert history[0]['event_type']=='document_voided'
            assert history[0]['after_data']['document_id']==outgoing['id']
            assert db.run('SELECT count(*) FROM gear_2026.events WHERE reverses_event_id='+str(outgoing['items'][stock.index(a)]['confirmed_event_id']))=='1'
        review(db,outgoing,request=request,reason='不同内容',fail='request_conflict')
        review(db,frozen,fail='document_not_confirmed')
        review(db,incoming)
        assert all(get(a)['invalidated_at'] for a in stock)
        assert rpc(db,'viewer','list_assets')['matched']==2  # Two setup sentinels only.
        print('PASS batch issue reversal, idempotent retries and sequential receipt reversal preserve originals and identifiers')

        # Undo a real return, then the issue: reopen the exact assignment and preserve old dates/follow-up.
        incoming,outgoing,stock=issued();prior=[current(a) for a in stock]
        back=confirm(db,save(db,returning,[line(get(a),condition='faulty') for a in stock]))
        review(db,outgoing,fail='document_has_dependencies')
        review(db,back)
        for a,old_assignment in zip(stock,prior):
            restored=current(a)
            assert {k:v for k,v in restored.items() if k!='updated_at'}=={k:v for k,v in old_assignment.items() if k!='updated_at'}
            assert get(a)['condition']=='normal'
        assert len(rpc(db,'viewer','list_due_assets')['items'])==2
        review(db,outgoing)
        assert rpc(db,'viewer','list_due_assets')['items']==[]
        legacy=get(initialize(db,placement={'holder_party_id':team['id'],'responsible_person_id':person['id'],
            'usage_kind':'temporary','known_on':None,'due_on':today}))
        legacy_assignment=current(legacy)
        back=confirm(db,save(db,returning,[line(legacy)]));review(db,back)
        assert current(legacy)['id']==legacy_assignment['id'] and current(legacy)['started_on'] is None
        assert current(legacy)['followup_member_id']==legacy_assignment['followup_member_id']

        # Ordinary transfer and continuous team responsibility can both be undone without new assignments.
        incoming,outgoing,stock=issued();old_assignment=current(stock[0])
        transfer={'kind':'transfer','transfer_mode':'responsibility','handover_on':today,
            'from_kind':'party','to_kind':'party','from_party_id':team['id'],'to_party_id':team['id'],
            'from_person_id':person['id'],'to_person_id':second['id'],'sender_name':'示例旧负责人','receiver_name':'示例新负责人'}
        responsibility=confirm(db,save(db,transfer,[line(get(stock[0]))]))
        review(db,responsibility)
        assert current(stock[0])['id']==old_assignment['id'] and current(stock[0])['responsible_person_id']==person['id']
        normal=confirm(db,save(db,{**transfer,'transfer_mode':'holder','to_party_id':second['id'],
            'usage_kind':'long_term','due_on':None},[line(get(stock[0]))]))
        review(db,normal)
        assert current(stock[0])['id']==old_assignment['id'] and current(stock[0])['due_on']==today
        print('PASS return and both transfer modes restore assignment identity, original deadlines and current due listing')

        # Fault, extension and an untracked overlapping field conflict block the entire batch.
        incoming,outgoing,stock=issued();broken=change(db,get(stock[1]),on=today)
        before=data(db,'gear_2026');review(db,outgoing,fail='document_has_dependencies');assert data(db,'gear_2026')==before
        change(db,broken,'normal',today,'示例维修完成')
        review(db,outgoing,fail='document_has_dependencies')
        incoming,outgoing,stock=issued()
        due=(date.fromisoformat(today)+timedelta(days=5)).isoformat()
        extend(db,get(stock[1]),due);review(db,outgoing,fail='document_has_dependencies')
        incoming,outgoing,stock=issued()
        db.run('UPDATE gear_2026.assets SET location=\'示例后来位置更正\' WHERE id='+quoted(stock[1]['id']))
        before=data(db,'gear_2026');review(db,outgoing,fail='document_state_conflict');assert data(db,'gear_2026')==before
        # Non-overlapping descriptive changes survive a valid reversal.
        lone=confirm(db,save(db,issue,[line(get(initialize(db)))]));a=assets(lone)[0]
        db.run('UPDATE gear_2026.assets SET name=\'示例后来名称\' WHERE id='+quoted(a['id']))
        review(db,lone);assert get(a)['name']=='示例后来名称'
        print('PASS later fault/repair, extensions and overlapping changes reject whole rollback; descriptive names survive')

        # Existing returned equipment and inventory-to-upstream returns restore management without duplication.
        a=get(initialize(db));to_upstream={**returning,'from_kind':'inventory','from_party_id':None,
            'from_person_id':None,'to_kind':'external','to_label':'示例上游'}
        upstream=confirm(db,save(db,to_upstream,[line(a)]));assert get(a)['management_status']=='returned_upstream'
        rereceipt=confirm(db,save(db,receipt,[line(get(a))]));review(db,rereceipt)
        assert get(a)['management_status']=='returned_upstream' and not get(a)['invalidated_at']
        review(db,upstream);assert get(a)['display_status']=='inventory_available'

        # Corrections append a statement and an optional newer replacement; ledger/originals stay frozen.
        original=received();replacement=received()
        ledger=db.run('SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM gear_2026.assets a')
        counter=db.run('SELECT jsonb_agg(to_jsonb(c) ORDER BY business_on) FROM gear_2026.document_counters c')
        statement='示例更正：实际移交人的姓名应为另一名称；真实去向不变'
        request=str(uuid4());result=review(db,original,'correct_document',statement=statement,replacement=replacement,request=request)
        corrected=document(original)
        assert corrected['items']==original['items'] and corrected['header_snapshot']==original['header_snapshot']
        assert corrected['parties_snapshot']==original['parties_snapshot'] and corrected['status']=='confirmed'
        assert corrected['changes'][0]['correction_text']==statement
        assert corrected['changes'][0]['replacement_document_id']==replacement['id']
        assert review(db,original,'correct_document',statement=statement,replacement=replacement,request=request)==result
        review(db,replacement,fail='document_has_dependencies')
        review(db,corrected,'correct_document',replacement=corrected,fail='invalid_replacement_document')
        review(db,corrected,'correct_document',statement='  ',fail='invalid_document_correction')
        review(db,corrected,'correct_document',replacement=outgoing,fail='invalid_replacement_document')
        assert db.run('SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM gear_2026.assets a')==ledger
        assert db.run('SELECT jsonb_agg(to_jsonb(c) ORDER BY business_on) FROM gear_2026.document_counters c')==counter
        review(db,corrected);review(db,replacement)
        print('PASS correction statements, newer replacement references, frozen original fields and no ledger/number mutations')

        # Archived originals remain readable and immutable when a document is voided.
        doc=received();attachment=reserve(db,doc);finish(db,attachment,doc)
        doc=document(doc);archive(db,doc,[attachment]);doc=document(doc)
        original_files=db.run('SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM gear_2026.attachments a')
        review(db,doc)
        assert document(doc)['evidence_state']=='archived'
        assert db.run('SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM gear_2026.attachments a')==original_files
        assert rpc(db,'viewer','get_attachment',quoted(attachment['id']))['id']==attachment['id']
        # Independent writes compete under the same settings lock and current versions.
        candidate=received();a=assets(candidate)[0]
        draft=save(db,issue,[line(a)])
        def race(action):
            try:
                return review(db,candidate) if action=='void' else confirm(db,draft)
            except AssertionError as error:
                assert any(code in str(error) for code in ['document_has_dependencies','asset_flow_conflict']);return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sum(result is not None for result in pool.map(race,['void','issue']))==1
        candidate=received();request=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            statements=list(pool.map(lambda _:review(db,candidate,'correct_document',request=request),range(2)))
        assert statements[0]==statements[1] and len(document(candidate)['changes'])==1
        candidate=received()
        for user in ['operator','viewer','pending','disabled','unverified','other']:
            for action in ['void_document','correct_document']:
                review(db,candidate,action,user=user,fail='document_admin_required' if user=='operator' else 'inventory_access_denied')
        for role in ['anon','service_role']:
            db.run('SET ROLE '+role+'; SELECT gear_2026.void_document(NULL,NULL,NULL,NULL)',fail='permission denied')
        db.as_user('admin','SELECT gear_private_2026.document_review_actor()',fail='permission denied')
        review(db,candidate,reason='  ',fail='invalid_document_void')
        stale={**candidate,'version':candidate['version']-1};review(db,stale,fail='document_conflict')
        db.run('UPDATE gear_2026.members SET role=\'viewer\' WHERE id='+quoted(IDS['admin']))
        review(db,original,'correct_document',statement=statement,replacement=replacement,request=request,fail='inventory_access_denied')
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS archived originals retained, current admin-only access and stale versions; unrelated application preserved')
    print(json.dumps({'document_review_checks':'passed','production_access':False}))


if __name__=='__main__':main()
