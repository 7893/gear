"""Registration contacts in a disposable database; never uses cloud credentials."""

from concurrent.futures import ThreadPoolExecutor
import json

from check_accounts import call, change
from check_schema import IDS, ROOT, disposable_database, setup
from check_schema_year import data

MIGRATION = ROOT / 'database/migrations/202610200024_application_contacts.sql'
# Fictional input examples, never imported from real user contact details.
PHONE = '13800000000'


def quoted(value):
    return 'NULL' if value is None else "'" + value.replace("'", "''") + "'"


def main():
    with disposable_database() as db:
        setup(db)
        for migration in sorted((ROOT / 'database/migrations').glob('*.sql')):
            if migration < MIGRATION and not migration.name.endswith('initial_schema.sql'):
                db.run(migration.read_text())
        db.schema = 'gear_2026'
        baseline = data(db, db.schema)
        identities = db.run('SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM auth.users u')
        db.run(MIGRATION.read_text())
        after = data(db, db.schema)
        after['members'] = db.run("SELECT md5(coalesce(jsonb_agg(to_jsonb(t)-'contact_phone' "
                                  "ORDER BY (to_jsonb(t)-'contact_phone')::text),'[]'::jsonb)::text) "
                                  'FROM gear_2026.members t')
        assert baseline == after
        assert identities == db.run('SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM auth.users u')
        assert call(db, 'admin', 'get_my_membership')['membership']['contact_phone'] is None
        db.run(MIGRATION.read_text(), fail='application_contacts_source_mismatch')

        for name in ['赵明', '欧阳晓', '阿卜杜拉·艾力', 'Anne Marie', "O'Neil",
                     'Jean-Luc', '张三丰', 'Élodie Martin']:
            assert db.run('SELECT gear_private_2026.valid_application_name(' + quoted(name) + ')') == 't', name
        for name in [None, '', ' ', '张三', '测试', '测试用户', 'TEST USER', '123', '王1',
                     '<script>', '王😀', '张\t明', 'A', '张·', '·张明', '张  明', '王' * 81]:
            call(db, 'other', 'apply_for_access', quoted(name) + ',' + quoted(PHONE),
                 fail='invalid_application_name')
        for phone in [None, '', '1380000000', '138000000000', '12800000000', '23800000000',
                      '+8613800000000', ' 13800000000', '13800000000 ', '１３８００００００００',
                      '138 0000000', '01088888888', '1380000000x', '13800000000\n']:
            call(db, 'other', 'apply_for_access', "'赵明'," + quoted(phone), fail='invalid_contact_phone')
        call(db, 'other', 'apply_for_access', "'赵明'", fail='invalid_contact_phone')
        assert db.run('SELECT count(*) FROM gear_2026.members') == '6'
        assert db.run('SELECT count(*) FROM gear_2026.events') == '0'
        assert db.run('SELECT count(*) FROM gear_2026.notification_outbox') == '0'
        call(db, 'unverified', 'apply_for_access', "'赵明'," + quoted(PHONE), fail='email_not_verified')

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: call(db, 'other', 'apply_for_access',
                                                   "' 赵明 '," + quoted(PHONE)), range(2)))
        assert results[0] == results[1]
        member = results[0]
        assert member['display_name'] == '赵明' and member['contact_phone'] == PHONE
        assert member['status'] == 'pending' and member['role'] is None
        assert db.run('SELECT count(*) FROM gear_2026.events') == '1'
        assert db.run('SELECT count(*) FROM gear_2026.notification_outbox') == '1'
        assert call(db, 'other', 'get_my_membership')['membership'] == member
        listed = call(db, 'admin', 'list_members')
        assert next(row for row in listed if row['id'] == member['id'])['contact_phone'] == PHONE
        for user in ['viewer', 'operator', 'other', 'disabled', 'unverified']:
            call(db, user, 'list_members', fail='admin_required')
        assert db.as_user('viewer', "SELECT count(*) FROM gear_2026.members WHERE id='" + member['id'] + "'") == '0'
        for role in ['anon', 'service_role']:
            for signature in ["'赵明'", "'赵明'," + quoted(PHONE)]:
                db.run('SET ROLE ' + role + '; SELECT gear_2026.apply_for_access(' + signature + ')',
                       fail='permission denied')
        # No role or data change is possible by repeating the registration.
        approved = change(db, 'admin', member['id'], 1, 'active', 'viewer')
        assert approved['contact_phone'] == PHONE
        assert call(db, 'other', 'apply_for_access', "'测试','19900000000'") == approved
        disabled = change(db, 'admin', member['id'], 2, 'disabled')
        assert call(db, 'other', 'apply_for_access', "'赵明'") == disabled
        assert call(db, 'other', 'apply_for_access', "'赵明','19900000000'") == disabled
        assert identities == db.run('SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM auth.users u')
        assert db.run('SELECT id FROM unrelated.sentinel') == '7'
        print('PASS contacts and names validate server-side; bypasses, races and legacy callers cannot create invalid members')
        print('PASS contacts remain unverified and access-restricted; historical accounts, Auth and unrelated apps preserved')
    print(json.dumps({'application_contact_checks': 'passed', 'production_access': False}))


if __name__ == '__main__':
    main()
