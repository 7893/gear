"""Evidence authorization/atomicity tests, exclusively in disposable PostgreSQL."""
import json
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from check_schema import ROOT,IDS,disposable_database,setup
from check_inventory import rpc,quoted
from check_flows import save,confirm,line
CHECKS={'signatures':True,'number':True,'content':True,'pages':True}
def current(db,doc):return rpc(db,'operator','get_document',quoted(doc['id']))
def reserve(db,doc,user='operator',request=None,**changes):
 details={'original_name':'示例签字件.pdf','media_type':'application/pdf','size_bytes':100,'sha256':str(changes.pop('hash','a'))*64,**changes}
 return rpc(db,user,'reserve_attachment',','.join([quoted(doc['id']),quoted(json.dumps(details)),str(doc['version']),quoted(request or str(uuid4()))]))
def finish(db,item,doc,actor='operator',hints=None,fail=None):
 info={'media_type':'application/pdf','size_bytes':100,'sha256':item['upload_manifest']['sha256'],'page_count':2,'recognition':hints if hints is not None else {'document_ids':[doc['id']],'document_numbers':[doc['document_no']]}}
 sql=f"SET LOCAL ROLE service_role; SELECT gear.commit_attachment({quoted(item['id'])},{quoted(IDS[actor])},{quoted(json.dumps(info))})"
 raw=db.run('BEGIN; '+sql+'; COMMIT;',fail=fail)
 return json.loads(raw) if not fail else None

def archive(db,doc,items,user='operator',reason=None,checks=None,request=None,fail=None):
 args=','.join([quoted(doc['id']),str(doc['version']),"ARRAY["+','.join(quoted(i['id'])+'::uuid' for i in items)+"]::uuid[]",quoted(json.dumps(CHECKS if checks is None else checks)),quoted(reason) if reason else 'NULL',quoted(request or str(uuid4()))])
 return rpc(db,user,'archive_evidence',args,fail=fail)
def update(db,item,changes,user='operator',fail=None,request=None):
 return rpc(db,user,'update_attachment',','.join([quoted(item['id']),str(item['version']),quoted(json.dumps(changes)),quoted(request or str(uuid4()))]),fail=fail)
def main():
 with disposable_database() as db:
  setup(db)
  for p in sorted((ROOT/'database/migrations').glob('*.sql')):
   if not p.name.endswith('initial_schema.sql'):db.run(p.read_text())
  today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
  base={'kind':'receipt','handover_on':today,'from_kind':'external','to_kind':'inventory','from_label':'示例交付方','to_label':'经办人库存','sender_name':'示例移交人','receiver_name':'示例接收人'}
  doc=confirm(db,save(db,base,[line()]));other=confirm(db,save(db,base,[line()]))
  assets=db.run('SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM gear.assets a');assignments=db.run('SELECT count(*) FROM gear.assignments')
  request=str(uuid4())
  with ThreadPoolExecutor(max_workers=2) as pool:items=list(pool.map(lambda _:reserve(db,doc,request=request),range(2)))
  assert items[0]==items[1];pending=items[0]
  assert pending['upload_state']=='pending' and pending['sha256'] is None
  assert current(db,doc)['evidence_state']=='awaiting_upload'
  assert rpc(db,'viewer','list_evidence',quoted(doc['id']))['items']==[]
  rpc(db,'viewer','get_attachment',quoted(pending['id']),fail='attachment_not_found')
  db.run(f"SET ROLE authenticated; SELECT gear.commit_attachment({quoted(pending['id'])},{quoted(IDS['operator'])},'{{}}')",fail='permission denied')
  finish(db,pending,doc,actor='viewer',fail='inventory_access_denied')
  ready=finish(db,pending,doc);assert ready['upload_state']=='ready' and ready['page_count']==2
  assert finish(db,pending,doc)==ready
  assert current(db,doc)['evidence_state']=='awaiting_review'
  assert rpc(db,'viewer','get_attachment',quoted(ready['id']))==ready
  print('PASS pending uploads hidden, only service can attest bytes, completion replay is idempotent')
  archive(db,current(db,doc),[ready],checks={**CHECKS,'signatures':False},fail='evidence_review_required')
  archived=archive(db,current(db,doc),[ready]);assert archived['evidence_state']=='archived'
  frozen=current(db,doc);assert frozen['header_snapshot']==doc['header_snapshot'] and frozen['parties_snapshot']==doc['parties_snapshot']
  latest=rpc(db,'operator','get_attachment',quoted(ready['id']))
  update(db,latest,{'is_active':False,'reason':'示例更正'},fail='archived_evidence_admin_required')
  rpc(db,'operator','reserve_attachment',','.join([quoted(doc['id']),quoted(json.dumps({'original_name':'新文件.pdf','media_type':'application/pdf','size_bytes':100,'sha256':'b'*64})),str(frozen['version']),quoted(str(uuid4()))]),fail='archived_evidence_admin_required')
  moved=update(db,latest,{'document_id':other['id'],'reason':'示例纠正关联'},user='admin')
  assert moved['document_id']==other['id'] and moved['storage_key']==ready['storage_key'] and moved['review_state']=='pending'
  assert current(db,doc)['evidence_state']=='awaiting_upload' and current(db,other)['evidence_state']=='awaiting_review'
  assert rpc(db,'viewer','list_evidence',quoted(doc['id']))['history'][0]['event_type']=='attachment_corrected'
  archive(db,current(db,other),[moved],fail='evidence_manual_reason_required')
  archive(db,current(db,other),[moved],reason='示例人工核对外部单据内容与关联')
  print('PASS explicit manual checks, archived corrections admin-only, old association audited and original retained')
  db.run(f"UPDATE gear.attachments SET storage_key='forged' WHERE id={quoted(moved['id'])}",fail='attachment_original_is_permanent')
  db.run(f"DELETE FROM gear.attachments WHERE id={quoted(moved['id'])}",fail='attachment_original_is_permanent')
  # Add a different original to the archived record as admin; successful upload reopens review.
  extra=reserve(db,current(db,other),user='admin',hash='b',correction_reason='示例补充第二页')
  extra=finish(db,extra,other,actor='admin',hints={'document_ids':[],'document_numbers':[]})
  assert extra['ocr_state']=='failed' and current(db,other)['evidence_state']=='awaiting_review'
  both=rpc(db,'operator','list_evidence',quoted(other['id']))['items']
  assert all(x['review_state']=='pending' for x in both)
  archive(db,current(db,other),[extra],reason='人工核对',fail='evidence_review_required')
  archive(db,current(db,other),both,reason='示例核对全部页及签名')
  print('PASS immutable file identity, failed recognition retained, adding evidence requires re-review of all active originals')
  cancelled=reserve(db,current(db,doc),hash='c');rid=str(uuid4());args=','.join([quoted(cancelled['id']),str(cancelled['version']),quoted(rid)])
  result=rpc(db,'operator','cancel_attachment',args);assert result['upload_state']=='failed' and not result['is_active']
  assert rpc(db,'operator','cancel_attachment',args)==result
  finish(db,cancelled,doc,fail='evidence_document_unavailable')
  # Drafts, stale versions, extra fields and pending uploads cannot be archived.
  draft=save(db,base,[])
  rpc(db,'operator','reserve_attachment',','.join([quoted(draft['id']),"'{}'",str(draft['version']),quoted(str(uuid4()))]),fail='evidence_document_unavailable')
  active=reserve(db,current(db,doc),hash='d')
  rpc(db,'operator','reserve_attachment',','.join([quoted(doc['id']),quoted(json.dumps(active['upload_manifest'])),str(current(db,doc)['version']),quoted(str(uuid4()))]),fail='duplicate_attachment')
  for n in range(9):reserve(db,current(db,doc),hash=str(n))
  rpc(db,'operator','reserve_attachment',','.join([quoted(doc['id']),quoted(json.dumps({**active['upload_manifest'],'sha256':'e'*64})),str(current(db,doc)['version']),quoted(str(uuid4()))]),fail='evidence_limit_exceeded')
  for role in ['viewer','pending','disabled','unverified','other']:
   rpc(db,role,'reserve_attachment',','.join([quoted(doc['id']),"'{}'",'1',quoted(str(uuid4()))]),fail='inventory_access_denied')
  for role in ['pending','disabled','unverified','other']:rpc(db,role,'get_attachment',quoted(ready['id']),fail='inventory_access_denied')
  db.run("SET ROLE anon; SELECT gear.list_evidence(NULL)",fail='permission denied')
  db.run("SET ROLE service_role; SELECT gear.list_evidence(NULL)",fail='permission denied')
  db.run("SET ROLE authenticated; SELECT gear_private.evidence_changed(NULL)",fail='permission denied')
  db.run(f"UPDATE gear.members SET status='disabled',role=NULL WHERE id={quoted(IDS['operator'])}")
  finish(db,pending,doc,fail='inventory_access_denied')
  assert db.run('SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM gear.assets a')==assets
  assert db.run('SELECT count(*) FROM gear.assignments')==assignments
  assert db.run('SELECT id FROM unrelated.sentinel')=='7'
  # Mock Storage lives only in this disposable database. An unrelated permissive policy
  # must not open Gear's bucket, and a restrictive Gear policy must not block other buckets.
  db.run("CREATE SCHEMA storage; CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT USAGE ON SCHEMA storage TO authenticated,anon,service_role; GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated,anon,service_role; CREATE POLICY unrelated_permissive ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true); INSERT INTO storage.objects(bucket_id,name) VALUES ('example-private-evidence','original'),('example-other-app','kept');")
  db.run((ROOT/'database/configure_evidence_storage.sql').read_text().replace(":'gear_storage_bucket'","'example-private-evidence'"))
  assert db.run("SET ROLE authenticated; SELECT count(*) FROM storage.objects WHERE bucket_id='example-private-evidence'")=='0'
  assert db.run("SET ROLE authenticated; SELECT count(*) FROM storage.objects WHERE bucket_id='example-other-app'")=='1'
  db.run("SET ROLE authenticated; INSERT INTO storage.objects(bucket_id,name) VALUES('example-private-evidence','forged')",fail='row-level security')
  db.run("SET ROLE authenticated; UPDATE storage.objects SET name='changed' WHERE bucket_id='example-private-evidence'")
  assert db.run("SELECT name FROM storage.objects WHERE bucket_id='example-private-evidence'")=='original'
  assert db.run("SET ROLE service_role; SELECT count(*) FROM storage.objects WHERE bucket_id='example-private-evidence'")=='1'
  print('PASS reservations counted against limits, cancelled uploads not successful, revoked identity and unrelated data protected')
  print('PASS restrictive Storage isolation defeats permissive policies while preserving access to other buckets')
 print(json.dumps({'evidence_database_checks':'passed','production_access':False}))
if __name__=='__main__':main()
