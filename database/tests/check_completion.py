"""Remaining small-project features: disposable DB, fictional data, no providers."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json
from uuid import uuid4
from check_schema import ROOT,IDS,disposable_database,setup
from check_inventory import initialize,party,rpc,quoted
from check_asset_lifecycle import lifecycle,placement
from check_evidence import finish as finish_attachment
from check_notifications import claim,prepare,finish

def migrate(db):
    setup(db)
    for p in sorted((ROOT/'database/migrations').glob('*.sql')):
        if not p.name.endswith('initial_schema.sql'):db.run(p.read_text())

def get(db,a):return rpc(db,'viewer','get_asset',quoted(a['id']))
def correct(db,a,event,request=None,user='admin',fail=None):
    return rpc(db,user,'correct_asset_lifecycle',','.join([quoted(a['id']),str(a['version']),str(event),quoted('示例误登记纠错'),quoted(request or str(uuid4()))]),fail=fail)
def reserve(db,a,event,request=None,user='operator',fail=None,**changes):
    details={'original_name':'示例历史凭证.pdf','media_type':'application/pdf','size_bytes':100,'sha256':'a'*64,'source_kind':'external','external_reference':'示例原领用凭证',**changes}
    return rpc(db,user,'reserve_event_attachment',','.join([str(event),quoted(json.dumps(details)),str(a['version']),quoted(request or str(uuid4()))]),fail=fail)
def review(db,item,accepted=True,user='operator',request=None,fail=None):
    return rpc(db,user,'review_event_attachment',','.join([quoted(item['id']),str(item['version']),str(accepted).lower(),quoted('示例人工核对内容及签字'),quoted(request or str(uuid4()))]),fail=fail)
def imports(db,rows,nonce=None,user='operator',ack=False,fail=None):
    return rpc(db,user,'import_assets',','.join([quoted(json.dumps(rows)),quoted(nonce or str(uuid4())),str(ack).lower()]),fail=fail)
def configure(db,enabled=True,time='00:00',lead=3,user='admin',request=None,fail=None):
    settings=rpc(db,'admin','get_due_settings')
    return rpc(db,user,'update_due_settings',','.join([str(settings['version']),str(enabled).lower(),str(lead),quoted(time),quoted('示例提醒规则核对'),quoted(request or str(uuid4()))]),fail=fail)

def main():
 with disposable_database() as db:
    migrate(db);today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
    person=party(db);team=party(db,details={'kind':'team','name':'示例团队','default_responsible_id':person['id']})
    asset=get(db,initialize(db,placement={'holder_party_id':team['id'],'responsible_person_id':person['id'],'usage_kind':'temporary','due_on':today}))['asset']
    event=get(db,asset)['history'][0]['id'];original=get(db,asset)['history'][0]
    for user in ['viewer','pending','disabled','unverified','other']:
        reserve(db,asset,event,user=user,fail='inventory_access_denied')
    reserve(db,asset,event,original_name='../bad.pdf',fail='invalid_evidence')
    nonce=str(uuid4());pending=reserve(db,asset,event,request=nonce)
    assert reserve(db,asset,event,request=nonce)==pending
    assert rpc(db,'viewer','list_event_evidence',event)['items']==[]
    assert get(db,asset)['history']==[original]
    rpc(db,'viewer','get_attachment',quoted(pending['id']),fail='attachment_not_found')
    ready=finish_attachment(db,pending,{'id':str(uuid4()),'document_no':'LR-20200101-0001'},hints={'document_ids':[],'document_numbers':[]})
    assert ready['event_id']==int(event) and ready['document_id'] is None
    assert rpc(db,'viewer','get_attachment',quoted(ready['id']))==ready
    assert rpc(db,'viewer','list_originals')[0]['id']==ready['id']
    assert 'storage_key' not in rpc(db,'viewer','list_originals')[0]
    reviewed=review(db,ready);assert reviewed['review_state']=='accepted'
    review(db,reviewed,False,fail='archived_evidence_admin_required')
    rejected=review(db,reviewed,False,user='admin');assert rejected['review_state']=='rejected'
    assert rejected['storage_key']==ready['storage_key']
    assert get(db,asset)['asset']==asset
    assert next(e for e in get(db,asset)['history'] if e['id']==event)==original
    assert db.run('SELECT count(*) FROM gear_2026.documents WHERE status<>\'draft\'')=='0'
    print('PASS historical/event proof: private original pipeline, immutable initial snapshot, reviewer roles, original export manifest, no fabricated handover')

    asset=rpc(db,'operator','set_assignment_user',','.join([quoted(asset['id']),str(asset['version']),quoted(person['id']),quoted('示例实际使用人'),quoted(str(uuid4()))]))
    lost=lifecycle(db,asset,on=today);lost_event=get(db,lost)['history'][0]['id'];nonce=str(uuid4())
    for user in ['operator','viewer']:
        correct(db,lost,lost_event,user=user,fail='asset_lifecycle_admin_required' if user=='operator' else 'inventory_access_denied')
    restored=correct(db,lost,lost_event,request=nonce)
    assert restored['management_status']=='managed' and restored['holder_party_id']==team['id'] and restored['due_on']==today and restored['actual_user_id']==person['id']
    assert correct(db,lost,lost_event,request=nonce)==restored
    correct(db,restored,lost_event,fail='asset_lifecycle_dependencies')
    assert get(db,restored)['history'][0]['reverses_event_id']==lost_event
    scrapped=lifecycle(db,restored,'scrapped',today);scrap_event=get(db,scrapped)['history'][0]['id'];restored=correct(db,scrapped,scrap_event)
    assert restored['holder_party_id']==team['id']
    lost=lifecycle(db,restored,on=today);lost_event=get(db,lost)['history'][0]['id']
    found=lifecycle(db,lost,'found',today,placement())
    correct(db,found,lost_event,fail='asset_lifecycle_dependencies')
    found_event=get(db,found)['history'][0]['id'];again=correct(db,found,found_event)
    assert again['management_status']=='lost' and again['holder_party_id'] is None
    restored=correct(db,again,lost_event);assert restored['holder_party_id']==team['id']
    empty=get(db,initialize(db))['asset'];invalid=lifecycle(db,empty,'invalidate',today)
    valid=correct(db,invalid,get(db,invalid)['history'][0]['id']);assert valid['invalidated_at'] is None
    print('PASS admin reversal restores original assignment/status; dependent events rejected, reason/reversal/idempotency retained; lost/scrapped/found/invalidation covered')

    row={'details':{'name':'示例批量电脑','category':'computer','condition':'normal','legacy_code':'00008'},'placement':{}}
    second={**row,'details':{**row['details'],'legacy_code':'00009'}}
    count=db.run('SELECT count(*) FROM gear_2026.assets');nonce=str(uuid4())
    bad=[row,{**second,'details':{**second['details'],'category':'bad'}}]
    imports(db,bad,nonce=nonce,fail='inventory_import_row_error')
    assert db.run('SELECT count(*) FROM gear_2026.assets')==count
    assert db.run('SELECT count(*) FROM gear_2026.events WHERE request_id='+quoted(nonce))=='0'
    with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:imports(db,[row,second],nonce=nonce),range(2)))
    assert results[0]==results[1] and results[0]['imported']==2
    assert results[0]['items'][0]['legacy_code']=='00008'
    imports(db,[second],nonce=nonce,fail='request_conflict')
    imports(db,[row],fail='inventory_import_row_error')
    assert imports(db,[row],ack=True)['imported']==1
    for user in ['viewer','disabled','unverified','pending']:imports(db,[row],user=user,fail='inventory_access_denied')
    actual={**second,'details':{**second['details'],'legacy_code':''},'placement':{'holder_party_id':team['id'],'responsible_person_id':person['id'],'usage_kind':'long_term'},'actual_user_id':person['id']}
    assert imports(db,[actual])['items'][0]['actual_user_id']==person['id']
    imports(db,[row]*201,fail='invalid_inventory_import')
    print('PASS atomic batch with line error, no partial rows/events, uncertain-result concurrent retry returns same batch, old numbers/actual users/authorization preserved')

    assert rpc(db,'admin','get_due_settings')['enabled'] is False
    for user in ['viewer','operator']:configure(db,user=user,fail='inventory_access_denied' if user=='viewer' else 'admin_required')
    configure(db,lead=31,fail='invalid_due_settings')
    configure(db);assert claim(db) is None # global sender remains disabled
    db.run('SELECT gear_private_2026.configure_account_notifications(true)')
    db.run('SELECT gear_private_2026.enqueue_due_notifications()')
    assert db.run("SELECT count(*) FROM gear_2026.notification_outbox WHERE notification_type='daily_due'")=='1'
    assert db.run('SELECT gear_private_2026.enqueue_due_notifications()')=='0'
    job=claim(db);message=prepare(db,job)
    assert message['to']=='operator@example.invalid' and message['notification']=={'kind':'daily_due','businessDate':today,'dueSoon':0,'dueToday':1,'overdue':0}
    assert finish(db,job,'submitted',message='example-daily')
    assert claim(db) is None
    # Disable followup: a valid admin receives a new aggregate; old jobs never get sent twice.
    db.run("UPDATE gear_2026.members SET status='disabled',role=NULL WHERE id="+quoted(IDS['operator']))
    job=claim(db);assert job is not None
    configure(db,False);assert prepare(db,job) is None
    configure(db,True);assert claim(db) is None # same recipient/day remains deduplicated
    # A new day fixture validates stale job cancellation and recalc before submission.
    db.run("DELETE FROM gear_2026.notification_outbox WHERE status='cancelled'")
    job=claim(db);assert job is not None
    lifecycle(db,restored,'lost',today)
    assert prepare(db,job) is None
    assert rpc(db,'admin','notification_status')['counts']['submitted']==1
    assert db.run('SELECT id FROM unrelated.sentinel')=='7'
    print('PASS daily counts/recipient fallback, opt-in/global switch, one digest/person/day, fresh recheck and obsolete cancellation; no real email')
 print(json.dumps({'completion_checks':'passed','production_access':False}))
if __name__=='__main__':main()
