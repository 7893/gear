-- Gear-only membership RPCs. Does not change shared Auth or Data API settings.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION gear_private.membership_result(member_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' SET timezone = 'UTC' AS $$
    SELECT jsonb_build_object('id', m.id, 'display_name', m.display_name,
        'status', m.status, 'role', m.role, 'version', m.version,
        'reviewed_at', m.reviewed_at, 'review_note', m.review_note)
    FROM gear.members m WHERE m.id = member_id;
$$;

CREATE FUNCTION gear_private.get_my_membership() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE identity_id uuid := auth.uid(); identity_email text; verified boolean; member_id uuid;
BEGIN
    SELECT u.email, u.email_confirmed_at IS NOT NULL INTO identity_email, verified
        FROM auth.users u WHERE u.id = identity_id;
    IF identity_id IS NULL OR identity_email IS NULL THEN
        RAISE EXCEPTION 'login_required' USING ERRCODE = '42501';
    END IF;
    SELECT m.id INTO member_id FROM gear.members m WHERE m.auth_user_id = identity_id;
    RETURN jsonb_build_object('email', identity_email, 'email_verified', verified,
        'membership', gear_private.membership_result(member_id));
END;
$$;

CREATE FUNCTION gear_private.apply_for_access(display_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE identity_id uuid := auth.uid(); member_id uuid; event_id bigint; applicant_name text := btrim(display_name);
BEGIN
    IF identity_id IS NULL THEN RAISE EXCEPTION 'login_required' USING ERRCODE = '42501'; END IF;
    IF applicant_name IS NULL OR length(applicant_name) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = identity_id
        AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'email_not_verified' USING ERRCODE = '42501';
    END IF;
    -- Serializes application creation, bootstrap and all membership decisions.
    PERFORM 1 FROM gear.app_settings s WHERE s.id = 1 FOR UPDATE;
    SELECT m.id INTO member_id FROM gear.members m WHERE m.auth_user_id = identity_id;
    IF member_id IS NOT NULL THEN RETURN gear_private.membership_result(member_id); END IF;
    INSERT INTO gear.members (auth_user_id, display_name)
        VALUES (identity_id, applicant_name) RETURNING id INTO member_id;
    INSERT INTO gear.events (scope, event_type, target_member_id, actor_member_id,
        actor_label, actor_source, after_data)
        VALUES ('member', 'member_applied', member_id, member_id, applicant_name, 'user',
            gear_private.membership_result(member_id)) RETURNING id INTO event_id;
    INSERT INTO gear.notification_outbox (dedup_key, notification_type, recipient_member_id, source_event_id, payload)
        SELECT 'application:' || event_id::text || ':' || a.id::text, 'application_pending', a.id, event_id,
            jsonb_build_object('member_id', member_id)
        FROM gear.members a JOIN auth.users u ON u.id = a.auth_user_id
        WHERE a.status = 'active' AND a.role = 'admin' AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL;
    RETURN gear_private.membership_result(member_id);
END;
$$;

CREATE FUNCTION gear_private.list_members(filter_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE result jsonb;
BEGIN
    IF gear_private.current_role() IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;
    IF filter_status IS NOT NULL AND filter_status NOT IN ('pending','active','rejected','disabled') THEN
        RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(jsonb_agg(gear_private.membership_result(m.id) || jsonb_build_object(
        'email', u.email, 'email_verified', u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL,
        'identity_exists', u.id IS NOT NULL, 'created_at', m.created_at) ORDER BY m.created_at, m.id), '[]'::jsonb)
        INTO result FROM gear.members m LEFT JOIN auth.users u ON u.id = m.auth_user_id
        WHERE filter_status IS NULL OR m.status = filter_status;
    RETURN result;
END;
$$;

CREATE FUNCTION gear_private.set_member_access(
    target_member_id uuid, expected_version integer, new_status text, new_role text,
    reason text, request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor_id uuid; actor_name text; target gear.members%ROWTYPE; previous jsonb;
    request_data jsonb; existing_event gear.events%ROWTYPE; result jsonb; event_id bigint;
    normalized_reason text := nullif(btrim(reason), ''); effective_role text;
BEGIN
    IF gear_private.current_role() IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;
    IF target_member_id IS NULL OR expected_version IS NULL OR expected_version < 1 OR request_id IS NULL
        OR new_status IS NULL OR new_status NOT IN ('pending','active','rejected','disabled')
        OR (new_status = 'active' AND (new_role IS NULL OR new_role NOT IN ('admin','operator','viewer')))
        OR (new_status <> 'active' AND new_role IS NOT NULL)
        OR length(normalized_reason) > 500 THEN
        RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM gear.app_settings s WHERE s.id = 1 FOR UPDATE;
    -- Recheck after waiting: another administrator may have revoked this caller.
    IF gear_private.current_role() IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;
    actor_id := gear_private.current_member_id();
    SELECT m.display_name INTO actor_name FROM gear.members m WHERE m.id = actor_id;
    effective_role := CASE WHEN new_status = 'active' THEN new_role ELSE NULL END;
    request_data := jsonb_build_object('member_id', target_member_id, 'expected_version', expected_version,
        'status', new_status, 'role', effective_role, 'reason', normalized_reason);
    SELECT e.* INTO existing_event FROM gear.events e WHERE e.request_id = set_member_access.request_id;
    IF FOUND THEN
        IF existing_event.actor_member_id IS DISTINCT FROM actor_id OR existing_event.request_payload IS DISTINCT FROM request_data THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE = '22023';
        END IF;
        RETURN existing_event.after_data;
    END IF;
    SELECT m.* INTO target FROM gear.members m WHERE m.id = target_member_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'member_not_found' USING ERRCODE = '22023'; END IF;
    IF target.version <> expected_version THEN RAISE EXCEPTION 'version_conflict' USING ERRCODE = '22023'; END IF;
    IF NOT (
        (target.status = 'pending' AND new_status IN ('active','rejected'))
        OR (target.status = 'active' AND new_status IN ('active','disabled'))
        OR (target.status = 'disabled' AND new_status = 'active')
        OR (target.status = 'rejected' AND new_status = 'pending')
    ) OR (target.status = new_status AND target.role IS NOT DISTINCT FROM effective_role) THEN
        RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
    END IF;
    IF NOT (target.status = 'pending' AND new_status = 'active') AND normalized_reason IS NULL THEN
        RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
    END IF;
    IF new_status = 'active' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = target.auth_user_id
        AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'email_not_verified' USING ERRCODE = '42501';
    END IF;
    previous := gear_private.membership_result(target.id);
    UPDATE gear.members m SET status = new_status, role = effective_role,
        reviewed_by = actor_id, reviewed_at = clock_timestamp(), review_note = normalized_reason WHERE m.id = target.id;
    IF NOT EXISTS (SELECT 1 FROM gear.members m JOIN auth.users u ON u.id = m.auth_user_id
        WHERE m.status = 'active' AND m.role = 'admin' AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'last_admin' USING ERRCODE = '22023';
    END IF;
    result := gear_private.membership_result(target.id);
    INSERT INTO gear.events (scope, event_type, target_member_id, actor_member_id, actor_label, actor_source,
        before_data, after_data, reason, request_id, request_payload)
        VALUES ('member', CASE WHEN target.status = new_status THEN 'member_role_changed' ELSE 'member_reviewed' END,
            target.id, actor_id, actor_name, 'user', previous, result, normalized_reason,
            set_member_access.request_id, request_data) RETURNING id INTO event_id;
    IF target.status = 'pending' AND new_status IN ('active','rejected') THEN
        INSERT INTO gear.notification_outbox (dedup_key, notification_type, recipient_member_id, source_event_id, payload)
            VALUES ('review:' || event_id::text || ':' || target.id::text, 'application_result', target.id,
                event_id, jsonb_build_object('member_id', target.id, 'status', new_status));
    END IF;
    RETURN result;
END;
$$;

-- Deployer-only initialization. No public bootstrap endpoint or default password.
CREATE FUNCTION gear_private.bootstrap_admin(identity_id uuid, display_name text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE member_id uuid; existing gear.members%ROWTYPE; initial_name text := btrim(display_name);
BEGIN
    IF initial_name IS NULL OR length(initial_name) NOT BETWEEN 1 AND 80 OR identity_id IS NULL THEN
        RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM gear.app_settings s WHERE s.id = 1 FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = identity_id
        AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'email_not_verified' USING ERRCODE = '42501';
    END IF;
    SELECT m.* INTO existing FROM gear.members m WHERE m.auth_user_id = identity_id;
    IF existing.status = 'active' AND existing.role = 'admin' THEN
        RETURN gear_private.membership_result(existing.id);
    END IF;
    IF EXISTS (SELECT 1 FROM gear.members m WHERE m.role = 'admin') OR EXISTS (
        SELECT 1 FROM gear.events e WHERE e.actor_source = 'bootstrap' AND e.event_type = 'member_reviewed') THEN
        RAISE EXCEPTION 'bootstrap_not_allowed' USING ERRCODE = '42501';
    END IF;
    IF existing.id IS NOT NULL AND existing.status <> 'pending' THEN
        RAISE EXCEPTION 'bootstrap_not_allowed' USING ERRCODE = '42501';
    END IF;
    IF existing.id IS NULL THEN
        member_id := gen_random_uuid();
        INSERT INTO gear.members (id,auth_user_id,display_name,status,role,reviewed_by,reviewed_at)
            VALUES (member_id, identity_id, initial_name, 'active', 'admin', member_id, clock_timestamp());
    ELSE
        member_id := existing.id;
        UPDATE gear.members m SET status = 'active', role = 'admin', display_name = initial_name,
            reviewed_by = member_id, reviewed_at = clock_timestamp() WHERE m.id = member_id;
    END IF;
    INSERT INTO gear.events (scope,event_type,target_member_id,actor_label,actor_source,after_data,reason)
        VALUES ('member','member_reviewed',member_id,'Deployer','bootstrap',
            gear_private.membership_result(member_id),'Initial administrator');
    RETURN gear_private.membership_result(member_id);
END;
$$;

CREATE FUNCTION gear.get_my_membership() RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.get_my_membership(); $$;
CREATE FUNCTION gear.apply_for_access(display_name text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.apply_for_access(display_name); $$;
CREATE FUNCTION gear.list_members(filter_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.list_members(filter_status); $$;
CREATE FUNCTION gear.set_member_access(target_member_id uuid, expected_version integer, new_status text,
    new_role text, reason text, request_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT gear_private.set_member_access(target_member_id,expected_version,new_status,new_role,reason,request_id);
$$;

REVOKE ALL ON FUNCTION gear.get_my_membership(), gear.apply_for_access(text), gear.list_members(text),
    gear.set_member_access(uuid,integer,text,text,text,uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION gear_private.membership_result(uuid), gear_private.get_my_membership(),
    gear_private.apply_for_access(text), gear_private.list_members(text),
    gear_private.set_member_access(uuid,integer,text,text,text,uuid), gear_private.bootstrap_admin(uuid,text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION gear.get_my_membership(), gear.apply_for_access(text), gear.list_members(text),
    gear.set_member_access(uuid,integer,text,text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION gear_private.get_my_membership(), gear_private.apply_for_access(text),
    gear_private.list_members(text), gear_private.set_member_access(uuid,integer,text,text,text,uuid) TO authenticated;
COMMENT ON SCHEMA gear IS 'Gear migration 202610170002: account membership RPCs';
COMMIT;
