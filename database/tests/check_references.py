"""Readable references preserve UUID identities, historical sheets and privileges."""
import json,re
from uuid import uuid4
from check_schema import ROOT, IDS, disposable_database, setup
from check_schema_year import data
from check_inventory import initialize, party, rpc, quoted
from check_flows import save, confirm, line

MIGRATION=ROOT/'database/migrations/202610200023_readable_references.sql'

def resolve(db,user,args,fail=None):
    value=db.as_user(user,'SELECT to_jsonb(gear_2026.resolve_reference('+args+'))',fail=fail)
    return json.loads(value) if not fail else None

def main():
 with disposable_database() as db:
    setup(db)
    for p in sorted((ROOT/'database/migrations').glob('*.sql')):
        if not p.name.endswith('initial_schema.sql') and p<MIGRATION:db.run(p.read_text())
    person=party(db);asset=initialize(db,placement={'holder_party_id':person['id'],'responsible_person_id':person['id'],'usage_kind':'long_term'})
    today=db.run("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date")
    original=confirm(db,save(db,{'kind':'receipt','handover_on':today,'from_kind':'external','to_kind':'inventory','from_label':'示例来源','sender_name':'示例移交人','receiver_name':'示例接收人'},[line()]))
    draft=save(db,{'kind':'receipt','from_kind':'external','to_kind':'inventory','from_label':'示例来源','handover_on':today,'sender_name':'示例移交人','receiver_name':'示例接收人'},[line()])
    baseline=data(db,'gear_2026');seq=db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
    db.run(MIGRATION.read_text())
    after=data(db,'gear_2026')
    for table in ['assets','documents','parties','attachments']:
        after[table]=db.run("SELECT md5(coalesce(jsonb_agg(to_jsonb(t)-'reference_code' ORDER BY (to_jsonb(t)-'reference_code')::text),'[]'::jsonb)::text) FROM gear_2026."+table+' t')
    assert baseline==after and db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')==seq
    db.run(MIGRATION.read_text(),fail='reference_source_mismatch')
    current=rpc(db,'viewer','get_asset',quoted(asset['id']))['asset']
    assert re.fullmatch(r'EQ-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}',current['asset_code'])
    assert current['reference_code']==current['asset_code'] and current['previous_asset_code']==asset['asset_code']
    for ref in [current['asset_code'],current['asset_code'].lower(),asset['asset_code']]:
        assert resolve(db,'viewer',"'asset',"+quoted(ref))==asset['id']
        result=rpc(db,'viewer','list_assets',quoted(ref))
        assert result['items'][0]['id']==asset['id']
    for user in ['pending','disabled','unverified','other']:
        resolve(db,user,"'asset',"+quoted(current['asset_code']),fail='inventory_access_denied')
    for role in ['anon','service_role']:
        db.run('SET ROLE '+role+"; SELECT gear_2026.resolve_reference('asset','example')",fail='permission denied')
    resolve(db,'viewer',"'unknown',"+quoted(current['asset_code']),fail='reference_not_found')
    resolve(db,'viewer',"'asset',"+quoted("';DROP TABLE assets;--"),fail='reference_not_found')
    print('PASS additive references preserve original rows, sequences, numbering aliases and access restrictions; current labels/search use EQ references')

    doc=rpc(db,'viewer','get_document',quoted(original['id']))
    assert {k:v for k,v in doc.items() if k!='reference_code'}==original
    for ref in [doc['document_no'],doc['reference_code']]:
        assert resolve(db,'viewer',"'document',"+quoted(ref))==doc['id']
        assert rpc(db,'viewer','list_documents',quoted(ref))[0]['id']==doc['id']
    draft_record=rpc(db,'operator','get_document',quoted(draft['id']))
    resolve(db,'viewer',"'document',"+quoted(draft_record['reference_code']),fail='reference_not_found')
    assert resolve(db,'admin',"'document',"+quoted(draft_record['reference_code']))==draft['id']
    p=rpc(db,'viewer','get_party',quoted(person['id']))['party']
    assert resolve(db,'viewer',"'party',"+quoted(p['reference_code']))==person['id']
    # Finalize a former draft: new snapshots use the readable current code.
    newly_confirmed=confirm(db,draft_record)
    assert newly_confirmed['items'][0]['asset_snapshot']['asset_code'].startswith('EQ-')
    assert rpc(db,'viewer','get_document',quoted(original['id']))==doc
    print('PASS both formal numbers and draft references resolve; old confirmed snapshots remain byte-equivalent; new confirmations use EQ codes')

    first='11111111-1111-4111-8111-111111111111';second='22222222-2222-4222-8222-221111111111'
    db.run("INSERT INTO gear_2026.parties(id,kind,name,created_at,created_by) VALUES('"+first+"','person','示例碰撞边界','2030-01-01','"+IDS['operator']+"')")
    db.run("INSERT INTO gear_2026.parties(id,kind,name,created_at,created_by) VALUES('"+second+"','person','示例另一条','2030-01-01','"+IDS['operator']+"')",fail='duplicate key')
    # The formatter agrees on a known mixed base32 example and does not use session timezone.
    encoded=db.run("SELECT gear_private_2026.reference_code('EQ','12345678-1234-4234-8234-1234abcdefab','2030-01-01T00:00:00Z')")
    db.env['PGTZ']='America/New_York'
    assert db.run("SELECT gear_private_2026.reference_code('EQ','12345678-1234-4234-8234-1234abcdefab','2030-01-01T00:00:00Z')")==encoded
    assert db.run('SELECT id FROM unrelated.sentinel')=='7'
    print('PASS unique constraint rejects ambiguous references; fixed business-year formatter; unrelated application preserved')
 print(json.dumps({'readable_reference_checks':'passed','production_access':False}))
if __name__=='__main__':main()
