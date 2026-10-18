"""Namespace rename preserves IDs/data/ACLs and supports a bounded rolling cutover."""
import json
from check_schema import ROOT,IDS,disposable_database,setup
TABLES=['members','parties','assets','documents','document_items','events','assignments','attachments','app_settings','document_counters','notification_outbox']
def data(db,schema):
 return {t:db.run("SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text) FROM "+schema+'.'+t+' t') for t in TABLES}
def main():
 with disposable_database() as db:
  setup(db)
  for p in sorted((ROOT/'database/migrations').glob('*.sql')):
   if p.name>'202610190006_flows.sql':continue
   if not p.name.endswith('initial_schema.sql'):db.run(p.read_text())
  db.run("CREATE SCHEMA cron; CREATE TABLE cron.job(jobid bigint PRIMARY KEY,jobname text,command text,schedule text,active boolean); INSERT INTO cron.job VALUES(1,'gear-account-notifications','SELECT gear_private.invoke_account_notifications();','* * * * *',true),(2,'example-other','SELECT 1','0 * * * *',true); CREATE FUNCTION cron.alter_job(job_id bigint,command text) RETURNS void LANGUAGE sql AS $$ UPDATE cron.job SET command=alter_job.command WHERE jobid=job_id; $$; CREATE FUNCTION gear_private.invoke_account_notifications() RETURNS bigint LANGUAGE sql SET search_path='' AS $$SELECT NULL::bigint$$; REVOKE ALL ON FUNCTION gear_private.invoke_account_notifications() FROM PUBLIC,anon,authenticated,service_role;")
  before=data(db,'gear');seq=db.run('SELECT last_value,is_called FROM gear.asset_code_sequence')
  metadata=json.loads(db.run("SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(p.proowner,p.proacl,p.proconfig,p.prosecdef)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear','gear_private')"))
  table_oids=db.run("SELECT array_agg(c.oid ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gear'")
  migration=(ROOT/'database/migrations/202610190007_schema_year.sql').read_text()
  db.run(migration.replace('BEGIN;',"BEGIN; SET LOCAL gear.rename_compatibility='on';",1))
  assert data(db,'gear_2026')==before
  assert db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')==seq
  assert db.run("SELECT array_agg(c.oid ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gear_2026'")==table_oids
  after=json.loads(db.run("SELECT jsonb_object_agg(p.oid::text,jsonb_build_array(p.proowner,p.proacl,p.proconfig,p.prosecdef)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026')"))
  assert metadata==after
  assert db.run("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gear_2026','gear_private_2026') AND (p.prosrc ~ '\\mgear\\.' OR p.prosrc ~ '\\mgear_private\\.')")=='0'
  assert db.run("SELECT command FROM cron.job WHERE jobid=1")=='SELECT gear_private_2026.invoke_account_notifications();'
  assert db.run('SELECT command FROM cron.job WHERE jobid=2')=='SELECT 1'
  for user in ['admin','operator','viewer']:
   assert db.as_user(user,'SELECT gear.get_my_membership()')==db.as_user(user,'SELECT gear_2026.get_my_membership()')
  db.run('SET ROLE anon; SELECT gear.list_assets()',fail='permission denied')
  db.run('SET ROLE service_role; SELECT gear.list_assets()',fail='permission denied')
  assert db.run(f"SET ROLE service_role; SELECT gear.can_recover_password('{IDS['admin']}')")=='t'
  db.run('SET ROLE authenticated; SELECT gear_private.invoke_account_notifications()',fail='permission denied')
  db.run("CREATE FUNCTION gear.example_unexpected() RETURNS int LANGUAGE sql AS 'SELECT 1'")
  cleanup=(ROOT/'database/retire_schema_aliases.sql').read_text()
  db.run(cleanup,fail='unexpected_legacy_function')
  assert db.run("SELECT to_regnamespace('gear') IS NOT NULL")=='t'
  db.run('DROP FUNCTION gear.example_unexpected()');db.run(cleanup)
  assert db.run("SELECT to_regnamespace('gear') IS NULL AND to_regnamespace('gear_private') IS NULL")=='t'
  assert data(db,'gear_2026')==before
  assert db.as_user('admin','SELECT gear_2026.list_assets()')
  assert db.run('SELECT id FROM unrelated.sentinel')=='7'
  db.run(migration,fail='schema_year_source_missing')
 print(json.dumps({'schema_year_checks':'passed','preserved_data_oids_acls_and_sequence':True,'compatibility_and_cleanup':'passed','production_access':False}))
if __name__=='__main__':main()
