-- Gear contact details are unverified business data, never Auth phone identities.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id = 1 FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('gear_private_2026.membership_result(uuid)')
        AND md5(prosrc) = '6251a609b7caa6548add339e53bd8d53')
        OR NOT EXISTS (SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('gear_private_2026.apply_for_access(text)')
        AND md5(prosrc) = '388f6dda50c25716d46515ef44497d1b') THEN
        RAISE EXCEPTION 'application_contacts_source_mismatch';
    END IF;
END; $$;

ALTER TABLE gear_2026.members ADD COLUMN contact_phone text
    CHECK (contact_phone IS NULL OR
        (char_length(contact_phone) = 11 AND contact_phone ~ '^1[3-9][0-9]{9}$'));
COMMENT ON COLUMN gear_2026.members.contact_phone IS
    'Unverified mainland mobile contact; existing members are not backfilled or disabled';

CREATE FUNCTION gear_private_2026.valid_application_name(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT value IS NOT NULL AND char_length(btrim(value)) BETWEEN 2 AND 80
        AND btrim(value) ~ '^[A-Za-zÀ-ÖØ-öø-ɏḀ-ỿ一-鿿㐀-䶿]+([ ·•・''’-][A-Za-zÀ-ÖØ-öø-ɏḀ-ỿ一-鿿㐀-䶿]+)*$'
        AND lower(replace(btrim(value), ' ', '')) !~
            '^(张三|测试(用户|账号|姓名|人员)?|姓名|真实姓名|你的姓名|请输入姓名|匿名|无名氏|管理员|test(user)?|admin|administrator|unknown|anonymous|null|undefined)$';
$$;
REVOKE ALL ON FUNCTION gear_private_2026.valid_application_name(text)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION gear_private_2026.membership_result(member_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' SET timezone = 'UTC' AS $$
    SELECT jsonb_build_object('id', m.id, 'display_name', m.display_name,
        'contact_phone', m.contact_phone, 'status', m.status, 'role', m.role,
        'version', m.version, 'reviewed_at', m.reviewed_at, 'review_note', m.review_note)
    FROM gear_2026.members m WHERE m.id = member_id;
$$;

CREATE FUNCTION gear_private_2026.apply_for_access(display_name text, contact_phone text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE identity_id uuid := auth.uid(); member_id uuid; event_id bigint;
    applicant_name text := btrim(display_name);
BEGIN
    IF identity_id IS NULL THEN RAISE EXCEPTION 'login_required' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = identity_id
        AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'email_not_verified' USING ERRCODE = '42501';
    END IF;
    -- Serialize with reviews and bootstrap; retries never overwrite contact data,
    -- revive a rejected/disabled account, or enqueue duplicate notifications.
    PERFORM 1 FROM gear_2026.app_settings s WHERE s.id = 1 FOR UPDATE;
    SELECT m.id INTO member_id FROM gear_2026.members m WHERE m.auth_user_id = identity_id;
    IF member_id IS NOT NULL THEN RETURN gear_private_2026.membership_result(member_id); END IF;
    IF NOT gear_private_2026.valid_application_name(applicant_name) THEN
        RAISE EXCEPTION 'invalid_application_name' USING ERRCODE = '22023';
    END IF;
    IF contact_phone IS NULL OR char_length(contact_phone) <> 11
        OR contact_phone !~ '^1[3-9][0-9]{9}$' THEN
        RAISE EXCEPTION 'invalid_contact_phone' USING ERRCODE = '22023';
    END IF;
    INSERT INTO gear_2026.members (auth_user_id, display_name, contact_phone)
        VALUES (identity_id, applicant_name, contact_phone) RETURNING id INTO member_id;
    INSERT INTO gear_2026.events (scope, event_type, target_member_id, actor_member_id,
        actor_label, actor_source, after_data)
        VALUES ('member', 'member_applied', member_id, member_id, applicant_name, 'user',
            gear_private_2026.membership_result(member_id)) RETURNING id INTO event_id;
    INSERT INTO gear_2026.notification_outbox
        (dedup_key, notification_type, recipient_member_id, source_event_id, payload)
        SELECT 'application:' || event_id::text || ':' || a.id::text,
            'application_pending', a.id, event_id, jsonb_build_object('member_id', member_id)
        FROM gear_2026.members a JOIN auth.users u ON u.id = a.auth_user_id
        WHERE a.status = 'active' AND a.role = 'admin'
            AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL;
    RETURN gear_private_2026.membership_result(member_id);
END;
$$;

-- Keep the old signature for deployed clients and repeat applications, but it
-- cannot create a new member without the now-required contact number.
CREATE OR REPLACE FUNCTION gear_private_2026.apply_for_access(display_name text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
    SELECT gear_private_2026.apply_for_access(display_name, NULL::text);
$$;
CREATE FUNCTION gear_2026.apply_for_access(display_name text, contact_phone text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT gear_private_2026.apply_for_access(display_name, contact_phone);
$$;
REVOKE ALL ON FUNCTION gear_private_2026.apply_for_access(text,text),
    gear_2026.apply_for_access(text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.apply_for_access(text,text),
    gear_2026.apply_for_access(text,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
