"""Prepare fictional inventory through existing RPCs; never connect to a database."""

import argparse
from collections import Counter
from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
CATEGORIES = [
    ('computer', '台式电脑', 12), ('laptop', '笔记本', 10),
    ('printer', '打印机', 8), ('water_dispenser', '饮水机', 6),
    ('power_strip', '电插板', 5), ('shredder', '碎纸机', 4),
    ('smart_display', '智慧屏', 3), ('other', '其他设备', 2),
]


def business_today():
    return datetime.now(ZoneInfo('Asia/Shanghai')).date()


def build_demo(base_date, batch_id):
    batch = UUID(str(batch_id))
    note = f'演示批次:{batch}；全部为虚构资料，仅用于试用。'
    people = []
    types = ['staff'] * 3 + ['seconded'] * 2 + ['attached'] * 2 + ['temporary'] * 2 + ['other']
    for index, kind in enumerate(types):
        key = f'person-{index + 1:02}'
        people.append({'key': key, 'request_id': str(uuid5(batch, key)), 'details': {
            'kind': 'person', 'name': f'演示人员{index + 1:02}', 'person_type': kind,
            'organization_name': '演示单位', 'note': note}})
    teams = []
    for index, name in enumerate(['综合组', '服务组', '项目组']):
        key = f'team-{index + 1:02}'
        teams.append({'key': key, 'responsible_key': people[index]['key'],
            'request_id': str(uuid5(batch, key)), 'details': {
                'kind': 'team', 'name': f'演示团队{index + 1:02}（{name}）', 'note': note}})
    assets = []
    for category, label, count in CATEGORIES:
        for number in range(1, count + 1):
            index = len(assets)
            key = f'asset-{index + 1:02}'
            placement = {'known_on': None if index % 7 == 0 else (base_date - timedelta(days=60 + index)).isoformat()}
            holder = None
            responsible = None
            if index % 5 in (2, 3):
                holder = people[(index // 5 + (index % 5 - 2) * 3) % 10]['key']
                responsible = holder
            elif index % 5 == 4:
                holder = teams[(index // 5) % 3]['key']
                responsible = teams[(index // 5) % 3]['responsible_key']
            if holder:
                temporary = index % 5 == 2 or index in (4, 9)
                placement['usage_kind'] = 'temporary' if temporary else 'long_term'
                placement['due_on'] = ((base_date + timedelta(days=-3 if index in (2, 4, 7, 9) else 14 + index)).isoformat()
                                       if temporary else None)
            old_code = None if index % 4 == 0 else [None, f'{index + 1:05}', f'OLD/{category}/{index + 1}', f'旧-{index + 1}'][index % 4]
            if old_code is not None:
                old_code += f'/DEMO-{batch}'
            if index in (9, 13):
                old_code = f'DEMO-旧号共用/{batch}'
            assets.append({'key': key, 'request_id': str(uuid5(batch, key)),
                'holder_key': holder, 'responsible_key': responsible,
                'allow_legacy_duplicate': index == 13, 'placement': placement,
                'details': {'name': f'演示{label}{number:02}', 'category': category,
                    'condition': 'faulty' if index in (0, 2, 4, 10, 20, 30) else 'normal',
                    'legacy_code': old_code, 'serial_number': None if index % 6 == 0 else f'DEMO-SN-{index + 1:04}',
                    'brand': '演示品牌', 'model': f'演示型号-{category}-{number % 3 + 1}',
                    'location': '演示库房' if not holder else '演示办公区', 'note': note}})
    return {'batch_id': str(batch), 'base_date': base_date.isoformat(), 'people': people, 'teams': teams, 'assets': assets}


def summary(payload):
    assets = payload['assets']
    return {'total': len(assets), 'categories': dict(Counter(a['details']['category'] for a in assets)),
        'inventory': sum(a['holder_key'] is None for a in assets),
        'personal': sum((a['holder_key'] or '').startswith('person-') for a in assets),
        'team': sum((a['holder_key'] or '').startswith('team-') for a in assets),
        'temporary': sum(a['placement'].get('usage_kind') == 'temporary' for a in assets),
        'faulty': sum(a['details']['condition'] == 'faulty' for a in assets),
        'people': len(payload['people']), 'teams': len(payload['teams'])}


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def build_sql(payload, actor_id):
    actor = str(UUID(str(actor_id)))
    encoded = literal(json.dumps(payload, ensure_ascii=False))
    return f"""BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = {literal(actor)};
DO $demo$
DECLARE payload jsonb := {encoded}::jsonb;
    item jsonb; result jsonb; details jsonb; placement jsonb;
    recipients jsonb := '{{}}'::jsonb; assets jsonb := '[]'::jsonb;
BEGIN
    IF jsonb_array_length(payload->'assets') <> 50 THEN
        RAISE EXCEPTION 'demo_requires_fifty_assets';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(payload->'people') LOOP
        result := gear_2026.create_party(item->'details', (item->>'request_id')::uuid);
        recipients := recipients || jsonb_build_object(item->>'key', result);
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(payload->'teams') LOOP
        details := item->'details' || jsonb_build_object('default_responsible_id', recipients->(item->>'responsible_key')->>'id');
        result := gear_2026.create_party(details, (item->>'request_id')::uuid);
        recipients := recipients || jsonb_build_object(item->>'key', result);
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(payload->'assets') LOOP
        placement := item->'placement';
        IF item->>'holder_key' IS NOT NULL THEN
            placement := placement || jsonb_build_object('holder_party_id', recipients->(item->>'holder_key')->>'id',
                'responsible_person_id', recipients->(item->>'responsible_key')->>'id');
        END IF;
        result := gear_2026.initialize_asset(item->'details', placement, (item->>'request_id')::uuid,
            (item->>'allow_legacy_duplicate')::boolean);
        assets := assets || jsonb_build_array(result);
    END LOOP;
    PERFORM set_config('gear_2026.demo_result', jsonb_build_object('batch_id', payload->>'batch_id',
        'base_date', payload->>'base_date', 'recipients', recipients, 'assets', assets)::text, true);
END;
$demo$;
SELECT current_setting('gear_2026.demo_result')::jsonb AS result;
COMMIT;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-date', type=date.fromisoformat)
    parser.add_argument('--batch', type=UUID)
    parser.add_argument('--sql-output', type=Path)
    args = parser.parse_args()
    if args.sql_output and (not args.base_date or not args.batch or not os.environ.get('GEAR_DEMO_ACTOR_ID')):
        parser.error('SQL preparation requires --base-date, --batch and private GEAR_DEMO_ACTOR_ID')
    payload = build_demo(args.base_date or business_today(), args.batch or UUID(int=1))
    if args.sql_output:
        output = args.sql_output.resolve()
        if not output.is_relative_to(ROOT / '.private'):
            parser.error('Write generated SQL only beneath the ignored .private directory')
        sql = build_sql(payload, os.environ['GEAR_DEMO_ACTOR_ID'])
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(sql)
    print(json.dumps({'preview': summary(payload), 'database_connected': False,
        'sql_prepared': bool(args.sql_output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
