-- Compensating events: originals and device numbers remain permanent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.get_asset(uuid)') AND md5(prosrc)='97ee322b3b19f613936765e2a2f9ae3d') THEN RAISE EXCEPTION 'completion_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.check_lifecycle_chronology()') AND md5(prosrc)='f41561165257862eddbe8a4f791d8b7c') THEN RAISE EXCEPTION 'completion_source_mismatch'; END IF;
END; $$;

ALTER TABLE gear_2026.events DROP CONSTRAINT events_event_type_check;
ALTER TABLE gear_2026.events ADD CONSTRAINT events_event_type_check CHECK(event_type IN (
 'asset_initialized','asset_updated','asset_fault_reported','asset_repaired','asset_lost','asset_scrapped',
 'asset_found','asset_invalidated','assignment_extended','document_confirmed','document_voided','document_corrected',
 'draft_created','draft_updated','draft_deleted','party_created','party_updated','member_applied','member_reviewed',
 'member_role_changed','settings_updated','attachment_uploaded','attachment_reviewed','attachment_corrected',
 'attachment_reserved','attachment_cancelled','assignment_user_changed','asset_lifecycle_corrected','assets_imported'));
CREATE FUNCTION gear_private_2026.correct_asset_lifecycle(asset_id uuid,expected_version integer,
    event_id bigint,reason text,request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE actor uuid; asset gear_2026.assets%ROWTYPE; original gear_2026.events%ROWTYPE;
    prior gear_2026.events%ROWTYPE; payload jsonb; result jsonb; before_state jsonb; reversal bigint; last_id bigint;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF gear_private_2026.current_role()<>'admin' THEN
        RAISE EXCEPTION 'asset_lifecycle_admin_required' USING ERRCODE='42501'; END IF;
    IF request_id IS NULL OR event_id IS NULL OR length(btrim(coalesce(reason,''))) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'invalid_asset_lifecycle' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','correct_asset_lifecycle','asset_id',asset_id,'expected_version',expected_version,
        'event_id',event_id::text,'reason',btrim(reason));
    SELECT * INTO prior FROM gear_2026.events e WHERE e.request_id=correct_asset_lifecycle.request_id;
    IF FOUND THEN
        IF prior.actor_member_id IS DISTINCT FROM actor OR prior.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN prior.after_data;
    END IF;
    SELECT * INTO asset FROM gear_2026.assets a WHERE a.id=correct_asset_lifecycle.asset_id FOR UPDATE;
    IF NOT FOUND OR asset.version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'asset_lifecycle_conflict' USING ERRCODE='40001'; END IF;
    SELECT * INTO original FROM gear_2026.events e WHERE e.id=event_id AND e.asset_id=asset.id AND e.scope='asset'
        AND e.event_type IN ('asset_lost','asset_scrapped','asset_found','asset_invalidated');
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_asset_lifecycle' USING ERRCODE='22023'; END IF;
    SELECT max(e.id) INTO last_id FROM gear_2026.events e WHERE e.asset_id=asset.id AND e.affects_asset_state
        AND e.reverses_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM gear_2026.events r WHERE r.reverses_event_id=e.id);
    IF last_id IS DISTINCT FROM original.id OR EXISTS(SELECT 1 FROM gear_2026.events r WHERE r.reverses_event_id=original.id) THEN
        RAISE EXCEPTION 'asset_lifecycle_dependencies' USING ERRCODE='22023'; END IF;
    before_state:=gear_private_2026.asset_record(asset.id);
    IF before_state->'management_status' IS DISTINCT FROM original.after_data->'management_status'
        OR before_state->'invalidated_at' IS DISTINCT FROM original.after_data->'invalidated_at'
        OR before_state->'holder_party_id' IS DISTINCT FROM original.after_data->'holder_party_id'
        OR before_state->'condition' IS DISTINCT FROM original.after_data->'condition' THEN
        RAISE EXCEPTION 'asset_lifecycle_conflict' USING ERRCODE='40001'; END IF;
    reversal:=nextval(pg_get_serial_sequence('gear_2026.events','id'));
    UPDATE gear_2026.assignments x SET closed_at=now(),ended_on=(now() AT TIME ZONE 'Asia/Shanghai')::date,
        closed_event_id=reversal WHERE x.asset_id=asset.id AND closed_at IS NULL AND opened_event_id=original.id;
    UPDATE gear_2026.assets SET management_status=original.before_data->>'management_status',
        condition=original.before_data->>'condition',
        location=CASE WHEN original.event_type='asset_found' AND before_state->'location' IS NOT DISTINCT FROM original.after_data->'location'
            THEN original.before_data->>'location' ELSE location END,
        last_flow_on=(original.before_data->>'last_flow_on')::date,
        invalidated_at=(original.before_data->>'invalidated_at')::timestamptz,
        invalidated_by=(original.before_data->>'invalidated_by')::uuid,invalid_reason=original.before_data->>'invalid_reason'
        WHERE id=asset.id;
    UPDATE gear_2026.assignments x SET closed_at=NULL,ended_on=NULL,closed_event_id=NULL
        WHERE x.asset_id=asset.id AND closed_event_id=original.id;
    result:=gear_private_2026.asset_record(asset.id);
    INSERT INTO gear_2026.events(id,scope,event_type,asset_id,occurred_on,actor_member_id,actor_label,actor_source,
        affects_asset_state,before_data,after_data,reason,reverses_event_id,request_id,request_payload) OVERRIDING SYSTEM VALUE
        VALUES(reversal,'asset','asset_lifecycle_corrected',asset.id,(now() AT TIME ZONE 'Asia/Shanghai')::date,actor,
            (SELECT display_name FROM gear_2026.members WHERE id=actor),'user',true,before_state,result,btrim(reason),original.id,request_id,payload);
    RETURN result;
END;
$$;
CREATE OR REPLACE FUNCTION gear_private_2026.check_lifecycle_chronology() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
    IF NEW.event_type IN ('document_confirmed','asset_fault_reported','asset_repaired') AND NEW.asset_id IS NOT NULL
        AND NEW.occurred_on<(SELECT max(e.occurred_on) FROM gear_2026.events e WHERE e.asset_id=NEW.asset_id
            AND e.event_type IN ('asset_lost','asset_scrapped','asset_found','asset_invalidated')
            AND NOT EXISTS(SELECT 1 FROM gear_2026.events r WHERE r.reverses_event_id=e.id)) THEN
        IF NEW.event_type='document_confirmed' THEN RAISE EXCEPTION 'invalid_document_date' USING ERRCODE='22023'; END IF;
        RAISE EXCEPTION 'invalid_condition_date' USING ERRCODE='22023';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION gear_2026.correct_asset_lifecycle(asset_id uuid,expected_version integer,event_id bigint,reason text,request_id uuid)
    RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
    SELECT gear_private_2026.correct_asset_lifecycle(asset_id,expected_version,event_id,reason,request_id); $$;
REVOKE ALL ON FUNCTION gear_2026.correct_asset_lifecycle(uuid,integer,bigint,text,uuid),
    gear_private_2026.correct_asset_lifecycle(uuid,integer,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_2026.correct_asset_lifecycle(uuid,integer,bigint,text,uuid),
    gear_private_2026.correct_asset_lifecycle(uuid,integer,bigint,text,uuid) TO authenticated;
CREATE OR REPLACE FUNCTION gear_private_2026.get_asset(asset_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE asset jsonb; history jsonb;
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    asset := gear_private_2026.asset_record(asset_id);
    IF asset IS NULL THEN RAISE EXCEPTION 'asset_not_found' USING ERRCODE = '22023'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id::text,'reverses_event_id',e.reverses_event_id::text,'event_type',e.event_type,'occurred_on',e.occurred_on,
        'recorded_at',e.recorded_at,'actor_label',e.actor_label,'reason',e.reason,'before_data',e.before_data,'after_data',e.after_data) ORDER BY e.id DESC),'[]'::jsonb)
        INTO history FROM gear_2026.events e WHERE e.scope = 'asset' AND e.asset_id = get_asset.asset_id;
    RETURN jsonb_build_object('asset',asset,'history',history);
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
