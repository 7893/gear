-- Temporary-use follow-up only; existing handovers and originals stay frozen.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION gear_private_2026.list_due_assets(state text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE today date := (now() AT TIME ZONE 'Asia/Shanghai')::date; lead_days integer; records jsonb; items jsonb; summary jsonb;
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    SELECT reminder_lead_days INTO STRICT lead_days FROM gear_2026.app_settings WHERE id = 1;
    IF state IS NOT NULL AND state NOT IN ('overdue','today','upcoming','later') THEN
        RAISE EXCEPTION 'invalid_due_filter' USING ERRCODE = '22023'; END IF;
    SELECT coalesce(jsonb_agg(gear_private_2026.asset_record(a.id) || jsonb_build_object(
        'due_state',CASE WHEN x.due_on < today THEN 'overdue' WHEN x.due_on = today THEN 'today'
            WHEN x.due_on <= today + lead_days THEN 'upcoming' ELSE 'later' END)
        ORDER BY x.due_on,a.asset_code),'[]'::jsonb) INTO records
        FROM gear_2026.assets a JOIN gear_2026.assignments x ON x.asset_id = a.id AND x.closed_at IS NULL
        WHERE a.invalidated_at IS NULL AND a.management_status = 'managed' AND x.usage_kind = 'temporary';
    SELECT coalesce(jsonb_agg(value ORDER BY value->>'due_on',value->>'asset_code'),'[]'::jsonb) INTO items
        FROM jsonb_array_elements(records) WHERE state IS NULL OR value->>'due_state' = state;
    SELECT jsonb_build_object('total',count(*),'overdue',count(*) FILTER (WHERE value->>'due_state' = 'overdue'),
        'today',count(*) FILTER (WHERE value->>'due_state' = 'today'),
        'upcoming',count(*) FILTER (WHERE value->>'due_state' = 'upcoming'),
        'later',count(*) FILTER (WHERE value->>'due_state' = 'later')) INTO summary FROM jsonb_array_elements(records);
    RETURN jsonb_build_object('business_on',today,'notice_days',lead_days,'items',items,'summary',summary);
END;
$$;

CREATE FUNCTION gear_private_2026.extend_assignment(asset_id uuid, expected_version integer,
    new_due_on text, reason text, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; asset gear_2026.assets%ROWTYPE;
    assignment gear_2026.assignments%ROWTYPE; payload jsonb; before_state jsonb; result jsonb;
    today date := (now() AT TIME ZONE 'Asia/Shanghai')::date; due_date date; explanation text := btrim(reason);
BEGIN
    -- Same ordering as confirmation: serialize requests, then lock asset and assignment.
    PERFORM 1 FROM gear_2026.app_settings WHERE id = 1 FOR UPDATE;
    actor := gear_private_2026.inventory_actor(true);
    IF request_id IS NULL OR asset_id IS NULL OR expected_version IS NULL OR expected_version < 1
        OR explanation IS NULL OR length(explanation) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'invalid_extension' USING ERRCODE = '22023'; END IF;
    IF new_due_on IS NULL OR new_due_on !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_extension_date' USING ERRCODE = '22023'; END IF;
    BEGIN
        due_date := new_due_on::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'invalid_extension_date' USING ERRCODE = '22023';
    END;
    payload := jsonb_build_object('action','extend_assignment','asset_id',asset_id,
        'expected_version',expected_version,'new_due_on',due_date,'reason',explanation);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id = extend_assignment.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE = '22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO asset FROM gear_2026.assets a WHERE a.id = extend_assignment.asset_id FOR UPDATE;
    IF NOT FOUND OR asset.version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'assignment_conflict' USING ERRCODE = '40001'; END IF;
    SELECT * INTO assignment FROM gear_2026.assignments x WHERE x.asset_id = asset.id AND x.closed_at IS NULL FOR UPDATE;
    IF NOT FOUND OR asset.invalidated_at IS NOT NULL OR asset.management_status <> 'managed'
        OR assignment.usage_kind <> 'temporary' THEN
        RAISE EXCEPTION 'assignment_not_temporary' USING ERRCODE = '22023'; END IF;
    IF due_date <= assignment.due_on OR due_date < today THEN
        RAISE EXCEPTION 'invalid_extension_date' USING ERRCODE = '22023'; END IF;
    before_state := gear_private_2026.asset_record(asset.id);
    UPDATE gear_2026.assignments SET due_on = due_date WHERE id = assignment.id;
    -- Advance the asset version so a previously prepared return/issue must be rechecked.
    UPDATE gear_2026.assets SET updated_at = now() WHERE id = asset.id;
    result := gear_private_2026.asset_record(asset.id) || jsonb_build_object(
        'assignment_id',assignment.id,'previous_due_on',assignment.due_on);
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id = actor;
    INSERT INTO gear_2026.events(scope,event_type,asset_id,occurred_on,actor_member_id,actor_label,
        actor_source,affects_asset_state,before_data,after_data,reason,request_id,request_payload)
        VALUES ('asset','assignment_extended',asset.id,today,actor,actor_name,'user',true,
            before_state,result,explanation,request_id,payload);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_2026.list_due_assets(state text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private_2026.list_due_assets(state); $$;
CREATE FUNCTION gear_2026.extend_assignment(asset_id uuid, expected_version integer, new_due_on text, reason text, request_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private_2026.extend_assignment(asset_id,expected_version,new_due_on,reason,request_id); $$;
REVOKE ALL ON FUNCTION gear_private_2026.list_due_assets(text),gear_private_2026.extend_assignment(uuid,integer,text,text,uuid),
    gear_2026.list_due_assets(text),gear_2026.extend_assignment(uuid,integer,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.list_due_assets(text),gear_private_2026.extend_assignment(uuid,integer,text,text,uuid),
    gear_2026.list_due_assets(text),gear_2026.extend_assignment(uuid,integer,text,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
