-- Administrator-only exits, explicit recovery placement and mistaken initial entries.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.get_asset(uuid)')
        AND md5(prosrc)='98922b239c7dbe1398b7ccf183b318c1') THEN
        RAISE EXCEPTION 'asset_lifecycle_source_mismatch'; END IF;
END;
$$;

CREATE FUNCTION gear_private_2026.change_asset_lifecycle(asset_id uuid, expected_version integer,
    action text, occurred_on text, details jsonb, reason text, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; asset gear_2026.assets%ROWTYPE;
    assignment gear_2026.assignments%ROWTYPE; payload jsonb; result jsonb; before_state jsonb;
    event_date date; earliest date; due_date date; holder uuid; responsible uuid; holder_kind text; use_kind text;
    event_id bigint; event_kind text; fields jsonb:='{}'::jsonb;
    today date:=(now() AT TIME ZONE 'Asia/Shanghai')::date; explanation text:=btrim(reason);
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF gear_private_2026.current_role()<>'admin' THEN
        RAISE EXCEPTION 'asset_lifecycle_admin_required' USING ERRCODE='42501'; END IF;
    IF asset_id IS NULL OR expected_version IS NULL OR expected_version<1 OR request_id IS NULL
        OR action IS NULL OR action NOT IN ('lost','scrapped','found','invalidate')
        OR explanation IS NULL OR length(explanation) NOT BETWEEN 1 AND 2000
        OR jsonb_typeof(details) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid_asset_lifecycle' USING ERRCODE='22023'; END IF;
    IF occurred_on IS NULL OR occurred_on !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_lifecycle_date' USING ERRCODE='22023'; END IF;
    BEGIN event_date:=occurred_on::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'invalid_lifecycle_date' USING ERRCODE='22023'; END;
    IF action='found' THEN
        IF NOT (details ?& ARRAY['condition','location','holder_party_id','responsible_person_id','usage_kind','due_on'])
            OR EXISTS(SELECT 1 FROM jsonb_each(details) WHERE key NOT IN
                ('condition','location','holder_party_id','responsible_person_id','usage_kind','due_on')
                OR jsonb_typeof(value) NOT IN ('string','null'))
            OR details->>'condition' IS NULL OR details->>'condition' NOT IN ('normal','faulty')
            OR length(coalesce(details->>'location',''))>120 THEN
            RAISE EXCEPTION 'invalid_asset_lifecycle' USING ERRCODE='22023'; END IF;
        BEGIN
            holder:=nullif(details->>'holder_party_id','')::uuid;
            responsible:=nullif(details->>'responsible_person_id','')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'invalid_asset_lifecycle' USING ERRCODE='22023'; END;
        use_kind:=nullif(details->>'usage_kind','');
        IF nullif(details->>'due_on','') IS NOT NULL AND details->>'due_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
            RAISE EXCEPTION 'invalid_lifecycle_date' USING ERRCODE='22023'; END IF;
        BEGIN due_date:=nullif(details->>'due_on','')::date;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
            RAISE EXCEPTION 'invalid_lifecycle_date' USING ERRCODE='22023'; END;
        IF (holder IS NULL AND (responsible IS NOT NULL OR use_kind IS NOT NULL OR due_date IS NOT NULL))
            OR (holder IS NOT NULL AND (responsible IS NULL OR use_kind IS NULL OR use_kind NOT IN ('long_term','temporary')
                OR (use_kind='long_term' AND due_date IS NOT NULL) OR (use_kind='temporary' AND due_date IS NULL))) THEN
            RAISE EXCEPTION 'invalid_asset_lifecycle' USING ERRCODE='22023'; END IF;
        IF due_date<event_date THEN RAISE EXCEPTION 'invalid_lifecycle_date' USING ERRCODE='22023'; END IF;
        fields:=jsonb_build_object('condition',details->>'condition','location',nullif(btrim(details->>'location'),''),
            'holder_party_id',holder,'responsible_person_id',responsible,'usage_kind',use_kind,'due_on',due_date);
    ELSIF details<>'{}'::jsonb THEN
        RAISE EXCEPTION 'invalid_asset_lifecycle' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','change_asset_lifecycle','asset_id',asset_id,'expected_version',expected_version,
        'operation',action,'occurred_on',event_date,'details',fields,'reason',explanation);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=change_asset_lifecycle.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO asset FROM gear_2026.assets a WHERE a.id=change_asset_lifecycle.asset_id FOR UPDATE;
    IF NOT FOUND OR asset.version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'asset_lifecycle_conflict' USING ERRCODE='40001'; END IF;
    IF asset.invalidated_at IS NOT NULL OR (action IN ('lost','scrapped','invalidate') AND asset.management_status<>'managed')
        OR (action='found' AND asset.management_status<>'lost') THEN
        RAISE EXCEPTION 'asset_lifecycle_transition' USING ERRCODE='22023'; END IF;
    SELECT * INTO assignment FROM gear_2026.assignments a WHERE a.asset_id=asset.id AND a.closed_at IS NULL FOR UPDATE;
    SELECT greatest(asset.last_flow_on,assignment.started_on,(SELECT max(e.occurred_on) FROM gear_2026.events e
        WHERE e.asset_id=asset.id AND (e.affects_asset_state OR e.event_type='asset_initialized')
            AND e.reverses_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM gear_2026.events r WHERE r.reverses_event_id=e.id))) INTO earliest;
    IF event_date>today OR event_date<earliest OR (action='invalidate' AND event_date<>today) THEN
        RAISE EXCEPTION 'invalid_lifecycle_date' USING ERRCODE='22023'; END IF;
    IF action='invalidate' AND (NOT EXISTS(SELECT 1 FROM gear_2026.events e WHERE e.asset_id=asset.id AND e.event_type='asset_initialized')
        OR EXISTS(SELECT 1 FROM gear_2026.events e WHERE e.asset_id=asset.id AND e.affects_asset_state
            AND e.reverses_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM gear_2026.events r WHERE r.reverses_event_id=e.id))
        OR EXISTS(SELECT 1 FROM gear_2026.document_items i WHERE i.asset_id=asset.id)) THEN
        RAISE EXCEPTION 'asset_invalidation_dependency' USING ERRCODE='22023'; END IF;
    IF action='found' AND holder IS NOT NULL THEN
        SELECT p.kind INTO holder_kind FROM gear_2026.parties p WHERE p.id=holder AND p.kind IN ('person','team') AND p.is_active;
        IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM gear_2026.parties p WHERE p.id=responsible AND p.kind='person' AND p.is_active)
            OR (holder_kind='person' AND holder IS DISTINCT FROM responsible) THEN
            RAISE EXCEPTION 'responsible_person_required' USING ERRCODE='22023'; END IF;
    END IF;
    before_state:=gear_private_2026.asset_record(asset.id);
    event_id:=nextval(pg_get_serial_sequence('gear_2026.events','id'));
    IF assignment.id IS NOT NULL THEN
        UPDATE gear_2026.assignments SET closed_at=now(),ended_on=event_date,closed_event_id=event_id WHERE id=assignment.id;
    END IF;
    IF action='invalidate' THEN
        UPDATE gear_2026.assets SET invalidated_at=now(),invalidated_by=actor,invalid_reason=explanation WHERE id=asset.id;
    ELSIF action='found' THEN
        UPDATE gear_2026.assets SET management_status='managed',condition=fields->>'condition',location=fields->>'location' WHERE id=asset.id;
        IF holder IS NOT NULL THEN
            INSERT INTO gear_2026.assignments(asset_id,holder_party_id,responsible_person_id,usage_kind,started_on,due_on,opened_event_id,followup_member_id)
                VALUES(asset.id,holder,responsible,use_kind,event_date,due_date,event_id,actor);
        END IF;
    ELSE
        UPDATE gear_2026.assets SET management_status=action WHERE id=asset.id;
    END IF;
    result:=gear_private_2026.asset_record(asset.id);
    event_kind:=CASE action WHEN 'lost' THEN 'asset_lost' WHEN 'scrapped' THEN 'asset_scrapped'
        WHEN 'found' THEN 'asset_found' ELSE 'asset_invalidated' END;
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id=actor;
    INSERT INTO gear_2026.events(id,scope,event_type,asset_id,occurred_on,actor_member_id,actor_label,actor_source,
        affects_asset_state,before_data,after_data,reason,request_id,request_payload) OVERRIDING SYSTEM VALUE
        VALUES(event_id,'asset',event_kind,asset.id,event_date,actor,actor_name,'user',true,before_state,result,explanation,request_id,payload);
    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION gear_private_2026.get_asset(asset_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE asset jsonb; history jsonb;
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    asset := gear_private_2026.asset_record(asset_id);
    IF asset IS NULL THEN RAISE EXCEPTION 'asset_not_found' USING ERRCODE = '22023'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id::text,'event_type',e.event_type,'occurred_on',e.occurred_on,
        'recorded_at',e.recorded_at,'actor_label',e.actor_label,'reason',e.reason,'before_data',e.before_data,'after_data',e.after_data) ORDER BY e.id DESC),'[]'::jsonb)
        INTO history FROM gear_2026.events e WHERE e.scope = 'asset' AND e.asset_id = get_asset.asset_id;
    RETURN jsonb_build_object('asset',asset,'history',history);
END;
$$;

-- Existing handover and repair RPCs must not backdate facts before a recovery/exit.
CREATE FUNCTION gear_private_2026.check_lifecycle_chronology() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.event_type IN ('document_confirmed','asset_fault_reported','asset_repaired') AND NEW.asset_id IS NOT NULL
        AND NEW.occurred_on<(SELECT max(e.occurred_on) FROM gear_2026.events e WHERE e.asset_id=NEW.asset_id
            AND e.event_type IN ('asset_lost','asset_scrapped','asset_found','asset_invalidated')) THEN
        IF NEW.event_type='document_confirmed' THEN RAISE EXCEPTION 'invalid_document_date' USING ERRCODE='22023'; END IF;
        RAISE EXCEPTION 'invalid_condition_date' USING ERRCODE='22023';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER events_lifecycle_chronology BEFORE INSERT ON gear_2026.events
    FOR EACH ROW EXECUTE FUNCTION gear_private_2026.check_lifecycle_chronology();
CREATE FUNCTION gear_2026.change_asset_lifecycle(asset_id uuid, expected_version integer, action text,
    occurred_on text, details jsonb, reason text, request_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT gear_private_2026.change_asset_lifecycle(asset_id,expected_version,action,occurred_on,details,reason,request_id);
$$;
REVOKE ALL ON FUNCTION gear_private_2026.check_lifecycle_chronology() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION gear_private_2026.change_asset_lifecycle(uuid,integer,text,text,jsonb,text,uuid),
    gear_2026.change_asset_lifecycle(uuid,integer,text,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.change_asset_lifecycle(uuid,integer,text,text,jsonb,text,uuid),
    gear_2026.change_asset_lifecycle(uuid,integer,text,text,jsonb,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
