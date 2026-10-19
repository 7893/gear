"""Transfer and continuous team responsibility in disposable PostgreSQL only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_inventory import initialize, party, rpc, quoted
from check_flows import save, confirm, line
from check_schema_year import data
from check_evidence import reserve, finish, archive


def main():
    with disposable_database() as db:
        setup(db)
        migration = ROOT/'database/migrations/202610190010_transfers.sql'
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path < migration and not path.name.endswith('initial_schema.sql'):
                db.run(path.read_text())
        catalog = "SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(n.nspname,p.proname,p.proowner,p.proacl,p.proconfig,p.prosecdef,md5(p.prosrc))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')"
        before = json.loads(db.run(catalog)); before_data = data(db,'gear_2026')
        db.run(migration.read_text())
        after = json.loads(db.run(catalog))
        assert set(before)==set(after)
        changed=[]
        for oid, value in before.items():
            assert value[:-1]==after[oid][:-1], 'Existing identity or permissions changed'
            if value[-1]!=after[oid][-1]:changed.append(value[:2])
        assert sorted(changed)==[['gear_private_2026','confirm_document'],['gear_private_2026','save_document']]
        assert before_data==data(db,'gear_2026')
        db.run(migration.read_text(),fail='transfer_source_mismatch')
        assert json.loads(db.run(catalog))==after
        for path in sorted((ROOT/'database/migrations').glob('*.sql')):
            if path > migration:
                db.run(path.read_text())
        today=date.fromisoformat(db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date"))
        day=lambda n:(today+timedelta(days=n)).isoformat()
        get=lambda a:rpc(db,'operator','get_asset',quoted(a['id']))['asset']
        assignment=lambda a:json.loads(db.run('SELECT to_jsonb(x) FROM gear_2026.assignments x WHERE asset_id='+quoted(a['id'])+' AND closed_at IS NULL'))
        first=party(db,details={'kind':'person','name':'示例旧负责人','person_type':'attached'})
        second=party(db,details={'kind':'person','name':'示例新负责人','person_type':'temporary'})
        team=party(db,details={'kind':'team','name':'示例团队一','default_responsible_id':first['id']})
        other_team=party(db,details={'kind':'team','name':'示例团队二','default_responsible_id':second['id']})
        def held(holder, responsible, due=5, condition='normal', known=-20):
            a=initialize(db,details={'condition':condition},placement={'holder_party_id':holder['id'],
                'responsible_person_id':responsible['id'],'usage_kind':'long_term' if due is None else 'temporary',
                'known_on':None if known is None else day(known),'due_on':None if due is None else day(due)})
            return get(a)
        def transfer(source, old_person, target, new_person, mode='holder', **changes):
            return {'kind':'transfer','transfer_mode':mode,'handover_on':day(0),'from_kind':'party','to_kind':'party',
                'from_party_id':source['id'],'from_person_id':old_person['id'],'to_party_id':target['id'],
                'to_person_id':new_person['id'],'sender_name':'示例实际移交人','receiver_name':'示例实际接收人',
                **({'usage_kind':'temporary','due_on':day(30)} if mode=='holder' else {}),**changes}

        # Normal transfer has no intermediate inventory; its two retries create one document.
        personal=[held(first,first),held(first,first)]
        old_assignments=[assignment(a) for a in personal]
        draft=save(db,transfer(first,first,other_team,second),[line(a) for a in personal])
        assert all(get(a)['holder_party_id']==first['id'] for a in personal)
        assert draft['document_no'] is None and draft['transfer_mode']=='holder'
        request=str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:confirm(db,draft,request=request),range(2)))
        transferred=results[0];assert results[0]==results[1] and transferred['document_no'].startswith('ZJ-'+day(0).replace('-','')+'-')
        assert transferred['evidence_state']=='awaiting_upload'
        for old,a in zip(old_assignments,personal):
            current=assignment(a)
            assert current['id']!=old['id'] and current['holder_party_id']==other_team['id']
            assert current['started_on']==day(0) and current['due_on']==day(30)
            assert db.run('SELECT ended_on FROM gear_2026.assignments WHERE id='+quoted(old['id']))==day(0)
        assert transferred['id'] in {d['id'] for d in rpc(db,'viewer','list_documents',"'','transfer','confirmed'")}
        latest=get(personal[0]);partial=confirm(db,save(db,transfer(other_team,second,first,first),[line(latest)]))
        assert get(personal[0])['holder_party_id']==first['id']
        assert get(personal[1])['holder_party_id']==other_team['id']
        assert rpc(db,'viewer','get_document',quoted(transferred['id']))==transferred
        print('PASS migration changes only two bodies; normal transfer retries once, partial personal/team handover, frozen old document')

        # Same-team responsibility keeps identities, mixed original deadlines and even unknown start dates.
        mixed=[held(team,first,due=-3,condition='faulty',known=None),held(team,first,due=20),held(team,first,due=None)]
        untouched=held(team,first,due=10)
        originals=[assignment(a) for a in mixed]
        detail=transfer(team,first,team,second,'responsibility')
        changed=confirm(db,save(db,detail,[line(a,condition=a['condition']) for a in mixed]))
        assert changed['transfer_mode']=='responsibility' and changed['usage_kind'] is None and changed['due_on'] is None
        for old,a,item in zip(originals,mixed,changed['items']):
            current=assignment(a)
            assert {k:v for k,v in old.items() if k not in ['responsible_person_id','updated_at']}=={k:v for k,v in current.items() if k not in ['responsible_person_id','updated_at']}
            assert current['responsible_person_id']==second['id']
            assert get(a)['condition']==a['condition'] and get(a)['due_on']==a['due_on']
            assert item['state_before']['responsible_person_id']==first['id']
            assert item['asset_snapshot']['responsible_person_id']==second['id']
            assert item['asset_snapshot']['due_on']==a['due_on'] and item['asset_snapshot']['started_on']==a['started_on']
        assert get(untouched)==untouched
        assert db.run('SELECT default_responsible_id FROM gear_2026.parties WHERE id='+quoted(team['id']))==first['id']
        assert get(mixed[0])['due_on']<day(0)
        print('PASS same-team responsibility preserves assignment identity, original dates, faults, overdue status and unselected devices')

        def reject(details, assets, failure):
            bad=save(db,details,assets)
            hashes=data(db,'gear_2026')
            confirm(db,bad,fail=failure)
            assert data(db,'gear_2026')==hashes, 'Failed confirmation changed state or reserved a daily number'
        reject(transfer(team,second,first,first),[line(get(mixed[0]))],'asset_flow_conflict')
        reject(transfer(team,second,team,first,'responsibility'),[line(get(mixed[0]))],'asset_flow_conflict')
        reject(transfer(team,second,team,first,'responsibility',usage_kind='long_term'),[line(get(mixed[0]),condition='faulty')],'invalid_placement')
        reject(transfer(team,second,other_team,first,'responsibility'),[line(get(mixed[1]))],'invalid_transfer_parties')
        reject(transfer(team,second,team,second,'responsibility'),[line(get(mixed[1]))],'invalid_transfer_parties')
        reject(transfer(first,first,first,second,'responsibility'),[line(get(personal[0]))],'invalid_transfer_parties')
        reject(transfer(team,first,other_team,second),[line(get(untouched)),line(get(mixed[1]))],'asset_flow_conflict')
        db.run('UPDATE gear_2026.parties SET is_active=false WHERE id='+quoted(second['id']))
        reject(transfer(first,first,other_team,second),[line(get(personal[0]))],'invalid_document_parties')
        db.run('UPDATE gear_2026.parties SET is_active=true WHERE id='+quoted(second['id']))
        stale=save(db,transfer(team,first,other_team,second),[line(untouched)])
        # A later extension makes the saved transfer stale.
        rpc(db,'operator','extend_assignment',','.join([quoted(untouched['id']),str(untouched['version']),quoted(day(40)),quoted('示例延期'),quoted(str(uuid4()))]))
        confirm(db,stale,fail='asset_flow_conflict')
        print('PASS no repair or deadline reset through responsibility; mixed sources, stale versions and failed whole documents are rejected')

        # Two different transfer drafts competing for the same physical device have one winner.
        a=get(personal[1]);options=[save(db,transfer(other_team,second,team,first),[line(a)]),save(db,transfer(other_team,second,first,first),[line(a)])]
        def compete(doc):
            try:return confirm(db,doc)
            except AssertionError as error:
                assert 'asset_flow_conflict' in str(error);return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sum(value is not None for value in pool.map(compete,options))==1
        for user in ['viewer','pending','disabled','unverified','other']:
            save(db,detail,[],user=user,fail='inventory_access_denied')
        save(db,{**detail,'transfer_mode':'forged'},[],fail='invalid_document')
        save(db,{**detail,'kind':'issue'},[],fail='invalid_document')
        db.run("SET ROLE anon; SELECT gear_2026.save_document('{}','[]',NULL,NULL,NULL)",fail='permission denied')
        db.run("SET ROLE service_role; SELECT gear_2026.confirm_document(NULL,NULL,NULL)",fail='permission denied')
        # The new responsible person can return a selected device; the old one cannot.
        a=get(mixed[0]);returning={'kind':'return','handover_on':day(0),'from_kind':'party','to_kind':'inventory',
            'from_party_id':team['id'],'from_person_id':first['id'],'sender_name':'示例交回人','receiver_name':'示例接收人','remarks':'示例故障退回'}
        reject(returning,[line(a,condition='faulty')],'asset_flow_conflict')
        confirm(db,save(db,{**returning,'from_person_id':second['id']},[line(a,condition='faulty')]))
        assert get(a)['display_status']=='inventory_faulty'
        assert rpc(db,'viewer','get_document',quoted(changed['id']))==changed
        assert get(mixed[1])['responsible_person_id']==second['id']
        # Exercise the existing evidence RPCs with fictional server attestations only.
        # No real files, remote storage, signatures or production documents are created.
        current=rpc(db,'operator','get_document',quoted(changed['id']))
        before_assets=data(db,'gear_2026')['assets']
        pending=reserve(db,current)
        ready=finish(db,pending,current)
        reviewed=rpc(db,'operator','get_document',quoted(changed['id']))
        assert archive(db,reviewed,[ready])['evidence_state']=='archived'
        frozen=rpc(db,'viewer','get_document',quoted(changed['id']))
        assert frozen['parties_snapshot']==changed['parties_snapshot'] and frozen['items']==changed['items']
        assert data(db,'gear_2026')['assets']==before_assets
        db.run(f"UPDATE gear_2026.members SET status='disabled',role=NULL WHERE id={quoted(IDS['operator'])}")
        confirm(db,draft,request=request,fail='inventory_access_denied')
        assert db.run('SELECT count(*) FROM gear_2026.attachments')=='1'
        assert db.run('SELECT id FROM unrelated.sentinel')=='7'
        print('PASS concurrent ownership, current roles and new responsible returns; old snapshots and unrelated records remain intact')
    print(json.dumps({'transfer_checks':'passed','production_access':False}))


if __name__=='__main__':main()
