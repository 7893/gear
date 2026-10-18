"""Verify an entire demo batch, repeat safety and atomic failure in isolation."""

from copy import deepcopy
import importlib.util
import json
from uuid import uuid4

from check_schema import IDS, ROOT, disposable_database, setup

spec = importlib.util.spec_from_file_location('demo_inventory', ROOT / 'database/demo/inventory.py')
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


def main():
    with disposable_database() as db:
        setup(db)
        for path in sorted((ROOT / 'database/migrations').glob('*.sql')):
            if not path.name.endswith('initial_schema.sql'):
                db.run(path.read_text())
        before = {table: int(db.run(f'SELECT count(*) FROM gear_2026.{table}'))
                  for table in ['assets', 'parties', 'assignments', 'events', 'documents', 'members', 'notification_outbox']}
        payload = demo.build_demo(demo.business_today(), uuid4())
        sql = demo.build_sql(payload, IDS['admin'])
        result = json.loads(db.run(sql))
        assert len(result['assets']) == 50 and len(result['recipients']) == 13
        expected = {'assets': 50, 'parties': 13, 'assignments': 30, 'events': 63,
                    'documents': 0, 'members': 0, 'notification_outbox': 0}
        for table, delta in expected.items():
            assert int(db.run(f'SELECT count(*) FROM gear_2026.{table}')) == before[table] + delta
        ids = ','.join(demo.literal(row['id']) for row in result['assets'])
        state = json.loads(db.as_user('admin', 'SELECT gear_2026.list_assets()'))
        assets = [row for row in state['items'] if row['id'] in {a['id'] for a in result['assets']}]
        assert len(assets) == 50 and len({a['asset_code'] for a in assets}) == 50
        assert sum(a['display_status'] == 'inventory_available' for a in assets) == 16
        assert sum(a['display_status'] == 'inventory_faulty' for a in assets) == 4
        assert sum(a['display_status'] == 'in_use' for a in assets) == 30
        assert sum(a['usage_kind'] == 'temporary' for a in assets) == 12
        assert sum(a['due_on'] is not None and a['due_on'] < payload['base_date'] for a in assets) == 4
        assert all(a['name'].startswith('演示') and payload['batch_id'] in a['note'] for a in assets)
        assert all(p['name'].startswith('演示') for p in result['recipients'].values())
        assert len({a['category'] for a in assets}) == 8
        assert int(db.run(f"SELECT count(*) FROM gear_2026.events WHERE asset_id IN ({ids}) AND event_type='asset_initialized'")) == 50
        print('PASS 50 fictional devices, all categories, placements, faults and overdue examples')
        sequence = db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence')
        assert json.loads(db.run(sql)) == result
        assert db.run('SELECT last_value,is_called FROM gear_2026.asset_code_sequence') == sequence
        for table, delta in expected.items():
            assert int(db.run(f'SELECT count(*) FROM gear_2026.{table}')) == before[table] + delta
        print('PASS exact replay preserves IDs, audits, counts and number sequence')
        invalid = demo.build_demo(demo.business_today(), uuid4())
        invalid['assets'][-1]['details']['name'] = ''
        db.run(demo.build_sql(invalid, IDS['admin']), fail='invalid_asset')
        for table, delta in expected.items():
            assert int(db.run(f'SELECT count(*) FROM gear_2026.{table}')) == before[table] + delta
        assert db.run('SELECT id FROM unrelated.sentinel') == '7'
        print('PASS late failure rolls back the complete batch and preserves preexisting data')
        denied = demo.build_demo(demo.business_today(), uuid4())
        db.run(demo.build_sql(denied, IDS['viewer']), fail='inventory_access_denied')
        conflict = deepcopy(payload)
        conflict['assets'][0]['details']['name'] = '演示变更'
        db.run(demo.build_sql(conflict, IDS['admin']), fail='request_conflict')
        print('PASS normal role restrictions and immutable request content remain enforced')
    print(json.dumps({'demo_inventory_checks': 'passed', 'production_access': False}))


if __name__ == '__main__':
    main()
