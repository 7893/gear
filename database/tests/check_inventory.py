"""Initial inventory and recipient RPCs in a disposable PostgreSQL cluster."""
from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4

from check_schema import IDS, ROOT, disposable_database, setup


def quoted(value):
    return "'" + value.replace("'", "''") + "'"


def rpc(db, user, name, args='', fail=None):
    result = db.as_user(user, f'SELECT gear_2026.{name}({args})', fail=fail)
    return json.loads(result) if not fail else None


def party(db, user='operator', details=None, request=None, fail=None):
    details = details or {'kind': 'person', 'name': 'Example person', 'person_type': 'seconded'}
    return rpc(db, user, 'create_party', f"{quoted(json.dumps(details))},'{request or uuid4()}'", fail)


def initialize(db, user='operator', details=None, placement=None, request=None, ack=False, fail=None):
    details = {'name': 'Example printer', 'category': 'printer', 'condition': 'normal', **(details or {})}
    placement = placement or {}
    return rpc(db, user, 'initialize_asset',
               f"{quoted(json.dumps(details))},{quoted(json.dumps(placement))},'{request or uuid4()}',{'true' if ack else 'false'}", fail)


def main():
    with disposable_database() as db:
        setup(db)
        for path in sorted((ROOT / 'database/migrations').glob('*.sql')):
            if not path.name.endswith('initial_schema.sql'):
                db.run(path.read_text())
        migration = ROOT / 'database/migrations/202610190007_schema_year.sql'
        db.run(migration.read_text(), fail='schema_year_source_missing')
        for user in ['pending', 'other', 'disabled', 'unverified']:
            rpc(db, user, 'list_assets', fail='inventory_access_denied')
            rpc(db, user, 'list_parties', fail='inventory_access_denied')
            initialize(db, user, fail='inventory_access_denied')
        for user in ['viewer', 'pending', 'disabled', 'unverified']:
            party(db, user, fail='inventory_access_denied')
            initialize(db, user, fail='inventory_access_denied')
        db.run('SET ROLE anon; SELECT gear_2026.list_assets()', fail='permission denied')
        db.run('SET ROLE service_role; SELECT gear_2026.list_assets()', fail='permission denied')
        db.as_user('operator', "SELECT nextval('gear_2026.asset_code_sequence')", fail='permission denied')
        db.as_user('admin', "INSERT INTO gear_2026.assets(name) VALUES ('bypass')", fail='permission denied')
        db.as_user('operator', 'SELECT gear_private_2026.asset_record(NULL)', fail='permission denied')
        print('PASS current verified membership, write roles and no direct table or sequence mutation')

        person_id = str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: party(db, request=person_id), range(2)))
        assert results[0] == results[1]
        person = results[0]
        assert person['person_type'] == 'seconded'
        party(db, request=person_id, details={'kind': 'person', 'name': 'Changed'}, fail='request_conflict')
        party(db, details={'kind': 'team', 'name': 'No leader'}, fail='invalid_party')
        party(db, details={'kind': 'team', 'name': 'Wrong leader', 'default_responsible_id': IDS['team']}, fail='responsible_person_required')
        team = party(db, details={'kind': 'team', 'name': 'Example team', 'default_responsible_id': person['id']})
        assert team['default_responsible_id'] == person['id']
        assert person['id'] in {p['id'] for p in rpc(db, 'viewer', 'list_parties')}
        print('PASS idempotent recipient creation, teams require active person leaders and receivers need no login')

        docs_before = db.run('SELECT count(*) FROM gear_2026.documents')
        request = str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            initialized = list(pool.map(lambda _: initialize(db, request=request, details={'legacy_code': '00007 / OLD'}), range(2)))
        asset = initialized[0]
        assert asset == initialized[1]
        assert asset['asset_code'] == 'SB-000001' and asset['legacy_code'] == '00007 / OLD'
        assert asset['display_status'] == 'inventory_available' and asset['last_flow_on'] is None
        assert db.run(f"SELECT count(*) FROM gear_2026.events WHERE request_id='{request}'") == '1'
        assert db.run(f"SELECT count(*) FROM gear_2026.assignments WHERE asset_id='{asset['id']}'") == '0'
        detail = rpc(db, 'viewer', 'get_asset', f"'{asset['id']}'")
        assert detail['history'][0]['occurred_on'] is None
        assert detail['history'][0]['after_data'] == asset
        assert detail['history'][0]['after_data']['historical_evidence'] == 'not_uploaded'
        initialize(db, request=request, details={'name': 'Changed'}, fail='request_conflict')
        initialize(db, user='admin', request=request, details={'legacy_code': '00007 / OLD'}, fail='request_conflict')
        initialize(db, details={'legacy_code': '00007 / OLD'}, fail='legacy_code_duplicate')
        other = initialize(db, details={'legacy_code': '00007 / OLD'}, ack=True)
        assert other['id'] != asset['id'] and other['legacy_duplicate_acknowledged']
        assert other['asset_code'] == 'SB-000002'
        print('PASS stable internal numbers, exact old text, duplicate acknowledgement and repeated creation returns one asset')

        placement = {'holder_party_id': person['id'], 'responsible_person_id': person['id'], 'usage_kind': 'long_term'}
        held = initialize(db, placement=placement, details={'condition': 'faulty'})
        assert held['display_status'] == 'in_use' and held['condition'] == 'faulty'
        assert held['started_on'] is None and held['due_on'] is None and held['holder_name'] == person['name']
        assert rpc(db, 'viewer', 'get_asset', f"'{held['id']}'")['history'][0]['after_data'] == held
        initialize(db, placement={**placement, 'responsible_person_id': IDS['person']}, fail='responsible_person_required')
        team_placement = {'holder_party_id': team['id'], 'responsible_person_id': person['id'], 'usage_kind': 'temporary', 'due_on': '2000-03-04'}
        team_asset = initialize(db, placement=team_placement)
        assert team_asset['holder_kind'] == 'team' and team_asset['started_on'] is None and team_asset['due_on'] == '2000-03-04'
        assert db.run(f"SELECT followup_member_id::text FROM gear_2026.assignments WHERE asset_id='{team_asset['id']}'") == IDS['operator']
        assert rpc(db, 'viewer', 'get_asset', f"'{team_asset['id']}'")['history'][0]['after_data'] == team_asset
        initialize(db, placement={**team_placement, 'responsible_person_id': None}, fail='responsible_person_required')
        initialize(db, placement={**team_placement, 'due_on': None}, fail='invalid_placement')
        initialize(db, placement={**team_placement, 'known_on': '2001-01-01'}, fail='invalid_placement')
        initialize(db, placement={**placement, 'known_on': '2999-01-01'}, fail='invalid_inventory_date')
        initialize(db, placement={**placement, 'known_on': 'today'}, fail='invalid_inventory_date')
        initialize(db, placement={**placement, 'known_on': '2025-02-30'}, fail='invalid_inventory_date')
        initialize(db, placement={'due_on': '2000-01-01'}, fail='invalid_placement')
        for category in ['water_dispenser', 'computer', 'laptop', 'power_strip', 'shredder', 'smart_display', 'other']:
            assert initialize(db, details={'category': category})['category'] == category
        initialize(db, details={'category': 'unknown'}, fail='invalid_asset')
        initialize(db, details={'management_status': 'scrapped'}, fail='invalid_asset')
        initialize(db, details={'name': {'invalid': 'object'}}, fail='invalid_asset')
        initialize(db, details={'name': 'x' * 121}, fail='invalid_asset')
        assert db.run('SELECT count(*) FROM gear_2026.documents') == docs_before
        print('PASS inventory/person/team initialization, faulty issued stock, unknown dates and temporary use without fabricated documents')

        state = rpc(db, 'viewer', 'list_assets')
        summary = state['summary']
        assert summary['total'] == sum(summary[key] for key in ['inventory_available','inventory_faulty','in_use','returned_upstream','lost','scrapped'])
        assert summary['managed_faulty'] == 1
        filtered = rpc(db, 'viewer', 'list_assets', "'',NULL,NULL,'team'")
        assert [a['id'] for a in filtered['items']] == [team_asset['id']]
        assert rpc(db, 'viewer', 'list_assets', "'00007 / OLD'")['matched'] == 2
        assert rpc(db, 'viewer', 'list_assets', "'%'" )['matched'] == 0
        assert rpc(db, 'viewer', 'list_assets', "'',NULL,'in_use'")['matched'] == 2
        assert rpc(db, 'viewer', 'list_assets', "'Example person'")['matched'] == 2
        rpc(db, 'viewer', 'list_assets', "'',NULL,'made_up'", fail='invalid_inventory_filter')
        rpc(db, 'viewer', 'get_asset', f"'{uuid4()}'", fail='asset_not_found')
        db.run(f"UPDATE gear_2026.parties SET name='Renamed example person' WHERE id='{person['id']}'")
        db.run(f"UPDATE gear_2026.parties SET default_responsible_id='{IDS['person2']}' WHERE id='{team['id']}'")
        current = rpc(db, 'viewer', 'get_asset', f"'{team_asset['id']}'")
        assert current['asset']['responsible_person_id'] == person['id']
        assert current['asset']['responsible_name'] == 'Renamed example person'
        assert current['history'][0]['after_data']['responsible_name'] == 'Example person'
        db.run(f"UPDATE gear_2026.assets SET invalidated_at=now(),invalidated_by='{IDS['admin']}',invalid_reason='Example duplicate' WHERE id='{other['id']}'")
        assert rpc(db,'viewer','list_assets')['summary']['total'] == summary['total'] - 1
        assert rpc(db,'viewer','get_asset',f"'{other['id']}'")['asset']['invalidated_at'] is not None
        db.run(f"UPDATE gear_2026.parties SET is_active=false WHERE id='{person['id']}'")
        initialize(db, placement=placement, fail='holder_unavailable')
        initialize(db, placement=team_placement, fail='responsible_person_required')
        assert db.run('SELECT id FROM unrelated.sentinel') == '7'
        print('PASS literal search, exclusive summaries, invalid records excluded, immutable history and inactive recipient protection')

        db.run("SELECT setval('gear_2026.asset_code_sequence',999999,true)")
        assert initialize(db)['asset_code'] == 'SB-1000000'
        db.run(f"UPDATE gear_2026.members SET status='disabled',role=NULL WHERE id='{IDS['operator']}'")
        initialize(db, request=request, details={'legacy_code': '00007 / OLD'}, fail='inventory_access_denied')
        rpc(db, 'operator', 'get_asset', f"'{asset['id']}'", fail='inventory_access_denied')
        print('PASS sequence expands beyond six digits and revoked access cannot replay earlier creation')
    print(json.dumps({'inventory_rpc_checks': 'passed', 'production_access': False}))


if __name__ == '__main__':
    main()
