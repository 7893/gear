-- Exact recipient holdings and explicit team user annotations; no cloud configuration.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.asset_record(uuid)')
        AND md5(prosrc)='4a34946ecc823bda71db89df05252ce3') THEN
        RAISE EXCEPTION 'party_holdings_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='gear_2026.events'::regclass AND conname='events_event_type_check'
        AND md5(pg_get_constraintdef(oid))='75349dd944b82d2311b2d07a5e0f4310') THEN
        RAISE EXCEPTION 'party_holdings_source_mismatch'; END IF;
END;
$$;
ALTER TABLE gear_2026.assignments ADD COLUMN actual_user_id uuid REFERENCES gear_2026.parties(id) ON DELETE RESTRICT;
ALTER TABLE gear_2026.events DROP CONSTRAINT events_event_type_check;
ALTER TABLE gear_2026.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
    'asset_initialized','asset_updated','asset_fault_reported','asset_repaired','asset_lost','asset_scrapped',
    'asset_found','asset_invalidated','assignment_extended','document_confirmed','document_voided','document_corrected',
    'draft_created','draft_updated','draft_deleted','party_created','party_updated','member_applied',
    'member_reviewed','member_role_changed','settings_updated','attachment_uploaded','attachment_reviewed',
    'attachment_corrected','attachment_reserved','attachment_cancelled','assignment_user_changed'));

CREATE OR REPLACE FUNCTION gear_private_2026.asset_record(identity_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT to_jsonb(a) || jsonb_build_object(
        'display_status',CASE WHEN a.management_status <> 'managed' THEN a.management_status
            WHEN x.id IS NOT NULL THEN 'in_use' WHEN a.condition = 'faulty' THEN 'inventory_faulty' ELSE 'inventory_available' END,
        'holder_party_id',x.holder_party_id,'holder_kind',h.kind,'holder_name',h.name,
        'responsible_person_id',x.responsible_person_id,'responsible_name',p.name,
        'usage_kind',x.usage_kind,'started_on',x.started_on,'due_on',x.due_on,
        'followup_name',m.display_name,
        'actual_user_id',CASE WHEN h.kind='person' THEN h.id ELSE u.id END,
        'actual_user_name',CASE WHEN h.kind='person' THEN h.name ELSE u.name END)
    FROM gear_2026.assets a LEFT JOIN gear_2026.assignments x ON x.asset_id = a.id AND x.closed_at IS NULL
    LEFT JOIN gear_2026.parties h ON h.id = x.holder_party_id LEFT JOIN gear_2026.parties p ON p.id = x.responsible_person_id
    LEFT JOIN gear_2026.parties u ON u.id=x.actual_user_id
    LEFT JOIN gear_2026.members m ON m.id = x.followup_member_id WHERE a.id = identity_id;
$$;

CREATE FUNCTION gear_private_2026.check_assignment_user() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.actual_user_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM gear_2026.parties p WHERE p.id=NEW.actual_user_id AND p.kind='person')
        OR NOT EXISTS(SELECT 1 FROM gear_2026.parties p WHERE p.id=NEW.holder_party_id AND p.kind='team')) THEN
        RAISE EXCEPTION 'invalid_assignment_user' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER assignments_user_valid BEFORE INSERT OR UPDATE ON gear_2026.assignments
    FOR EACH ROW EXECUTE FUNCTION gear_private_2026.check_assignment_user();

CREATE FUNCTION gear_private_2026.list_party_assets(party_id uuid, relationship text DEFAULT 'holding') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE party gear_2026.parties%ROWTYPE; items jsonb;
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    SELECT * INTO party FROM gear_2026.parties p WHERE p.id=party_id AND p.kind IN ('person','team');
    IF NOT FOUND THEN RAISE EXCEPTION 'party_not_found' USING ERRCODE='22023'; END IF;
    IF relationship IS NULL OR relationship NOT IN ('holding','responsible','actual','all')
        OR (party.kind='team' AND relationship NOT IN ('holding','all')) THEN
        RAISE EXCEPTION 'invalid_party_asset_filter' USING ERRCODE='22023'; END IF;
    SELECT coalesce(jsonb_agg(gear_private_2026.asset_record(a.id) ORDER BY a.asset_code,a.id),'[]'::jsonb) INTO items
        FROM gear_2026.assets a JOIN gear_2026.assignments x ON x.asset_id=a.id AND x.closed_at IS NULL
        WHERE a.invalidated_at IS NULL AND a.management_status='managed' AND (
            (relationship IN ('holding','all') AND x.holder_party_id=party.id)
            OR (party.kind='person' AND relationship IN ('responsible','all') AND x.responsible_person_id=party.id
                AND x.holder_party_id<>party.id)
            OR (party.kind='person' AND relationship IN ('actual','all') AND x.actual_user_id=party.id));
    RETURN jsonb_build_object('party',to_jsonb(party),'relationship',relationship,'items',items,'matched',jsonb_array_length(items),
        'business_on',(now() AT TIME ZONE 'Asia/Shanghai')::date);
END;
$$;

CREATE FUNCTION gear_private_2026.set_assignment_user(asset_id uuid, expected_version integer,
    actual_user_id uuid, reason text, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; asset gear_2026.assets%ROWTYPE;
    assignment gear_2026.assignments%ROWTYPE; before_state jsonb; result jsonb; payload jsonb; explanation text:=btrim(reason);
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF asset_id IS NULL OR expected_version IS NULL OR expected_version<1 OR request_id IS NULL
        OR explanation IS NULL OR length(explanation) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'invalid_assignment_user' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','set_assignment_user','asset_id',asset_id,'expected_version',expected_version,
        'actual_user_id',actual_user_id,'reason',explanation);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=set_assignment_user.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO asset FROM gear_2026.assets a WHERE a.id=set_assignment_user.asset_id FOR UPDATE;
    IF NOT FOUND OR asset.version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'assignment_user_conflict' USING ERRCODE='40001'; END IF;
    SELECT * INTO assignment FROM gear_2026.assignments x WHERE x.asset_id=asset.id AND x.closed_at IS NULL FOR UPDATE;
    IF asset.invalidated_at IS NOT NULL OR asset.management_status<>'managed' OR assignment.id IS NULL
        OR NOT EXISTS(SELECT 1 FROM gear_2026.parties p WHERE p.id=assignment.holder_party_id AND p.kind='team') THEN
        RAISE EXCEPTION 'assignment_user_unavailable' USING ERRCODE='22023'; END IF;
    IF actual_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gear_2026.parties p WHERE p.id=actual_user_id AND p.kind='person' AND p.is_active) THEN
        RAISE EXCEPTION 'actual_user_unavailable' USING ERRCODE='22023'; END IF;
    IF assignment.actual_user_id IS NOT DISTINCT FROM actual_user_id THEN
        RAISE EXCEPTION 'assignment_user_unchanged' USING ERRCODE='22023'; END IF;
    before_state:=gear_private_2026.asset_record(asset.id);
    UPDATE gear_2026.assignments SET actual_user_id=set_assignment_user.actual_user_id WHERE id=assignment.id;
    UPDATE gear_2026.assets SET updated_at=now() WHERE id=asset.id;
    result:=gear_private_2026.asset_record(asset.id);
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id=actor;
    INSERT INTO gear_2026.events(scope,event_type,asset_id,occurred_on,actor_member_id,actor_label,actor_source,
        affects_asset_state,before_data,after_data,reason,request_id,request_payload)
        VALUES('asset','assignment_user_changed',asset.id,(now() AT TIME ZONE 'Asia/Shanghai')::date,actor,actor_name,'user',
            true,before_state,result,explanation,request_id,payload);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_2026.list_party_assets(party_id uuid, relationship text DEFAULT 'holding') RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
    AS $$ SELECT gear_private_2026.list_party_assets(party_id,relationship); $$;
CREATE FUNCTION gear_2026.set_assignment_user(asset_id uuid, expected_version integer, actual_user_id uuid, reason text, request_id uuid)
    RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = ''
    AS $$ SELECT gear_private_2026.set_assignment_user(asset_id,expected_version,actual_user_id,reason,request_id); $$;
REVOKE ALL ON FUNCTION gear_private_2026.check_assignment_user() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION gear_private_2026.list_party_assets(uuid,text),gear_2026.list_party_assets(uuid,text),
    gear_private_2026.set_assignment_user(uuid,integer,uuid,text,uuid),gear_2026.set_assignment_user(uuid,integer,uuid,text,uuid)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.list_party_assets(uuid,text),gear_2026.list_party_assets(uuid,text),
    gear_private_2026.set_assignment_user(uuid,integer,uuid,text,uuid),gear_2026.set_assignment_user(uuid,integer,uuid,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
