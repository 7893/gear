-- Initial inventory and lightweight recipients. No handover or shared Auth changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION gear_private.inventory_actor(writing boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE member_id uuid := gear_private.current_member_id(); member_role text := gear_private.current_role();
BEGIN
    IF member_id IS NULL OR member_role IS NULL OR (writing AND member_role NOT IN ('admin','operator')) THEN
        RAISE EXCEPTION 'inventory_access_denied' USING ERRCODE = '42501';
    END IF;
    RETURN member_id;
END;
$$;

CREATE FUNCTION gear_private.asset_record(identity_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT to_jsonb(a) || jsonb_build_object(
        'display_status',CASE WHEN a.management_status <> 'managed' THEN a.management_status
            WHEN x.id IS NOT NULL THEN 'in_use' WHEN a.condition = 'faulty' THEN 'inventory_faulty' ELSE 'inventory_available' END,
        'holder_party_id',x.holder_party_id,'holder_kind',h.kind,'holder_name',h.name,
        'responsible_person_id',x.responsible_person_id,'responsible_name',p.name,
        'usage_kind',x.usage_kind,'started_on',x.started_on,'due_on',x.due_on,
        'followup_name',m.display_name)
    FROM gear.assets a LEFT JOIN gear.assignments x ON x.asset_id = a.id AND x.closed_at IS NULL
    LEFT JOIN gear.parties h ON h.id = x.holder_party_id LEFT JOIN gear.parties p ON p.id = x.responsible_person_id
    LEFT JOIN gear.members m ON m.id = x.followup_member_id WHERE a.id = identity_id;
$$;

CREATE FUNCTION gear_private.list_parties() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM gear_private.inventory_actor();
    RETURN (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.kind,p.name,p.id),'[]'::jsonb)
        FROM gear.parties p WHERE p.is_active AND p.kind IN ('person','team'));
END;
$$;

CREATE FUNCTION gear_private.create_party(details jsonb, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor_id uuid; actor_name text; previous gear.events%ROWTYPE; result jsonb;
    data jsonb; party_id uuid; person_id uuid; party_kind text; party_name text;
BEGIN
    PERFORM 1 FROM gear.app_settings WHERE id = 1 FOR UPDATE;
    actor_id := gear_private.inventory_actor(true);
    IF request_id IS NULL OR jsonb_typeof(details) IS DISTINCT FROM 'object'
        OR EXISTS (SELECT 1 FROM jsonb_each(details) WHERE key NOT IN
            ('kind','name','person_type','organization_name','default_responsible_id','note')
            OR jsonb_typeof(value) NOT IN ('string','null')) THEN
        RAISE EXCEPTION 'invalid_party' USING ERRCODE = '22023'; END IF;
    party_kind := details->>'kind'; party_name := btrim(details->>'name');
    IF party_kind IS NULL OR party_kind NOT IN ('person','team') OR party_name IS NULL OR length(party_name) NOT BETWEEN 1 AND 80
        OR length(coalesce(details->>'organization_name','')) > 120 OR length(coalesce(details->>'note','')) > 2000 THEN
        RAISE EXCEPTION 'invalid_party' USING ERRCODE = '22023'; END IF;
    person_id := nullif(details->>'default_responsible_id','')::uuid;
    IF (party_kind = 'person' AND (person_id IS NOT NULL OR coalesce(details->>'person_type','staff') NOT IN ('staff','seconded','attached','temporary','other')))
        OR (party_kind = 'team' AND (person_id IS NULL OR nullif(details->>'person_type','') IS NOT NULL)) THEN
        RAISE EXCEPTION 'invalid_party' USING ERRCODE = '22023'; END IF;
    data := jsonb_build_object('action','create_party','kind',party_kind,'name',party_name,
        'person_type',CASE WHEN party_kind = 'person' THEN coalesce(details->>'person_type','staff') END,
        'organization_name',nullif(btrim(details->>'organization_name'),''),
        'default_responsible_id',person_id,'note',nullif(btrim(details->>'note'),''));
    SELECT * INTO previous FROM gear.events e WHERE e.request_id = create_party.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor_id OR previous.request_payload IS DISTINCT FROM data THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE = '22023'; END IF;
        RETURN previous.after_data;
    END IF;
    IF party_kind = 'team' AND NOT EXISTS (SELECT 1 FROM gear.parties WHERE id = person_id AND kind = 'person' AND is_active) THEN
        RAISE EXCEPTION 'responsible_person_required' USING ERRCODE = '22023'; END IF;
    SELECT display_name INTO actor_name FROM gear.members WHERE id = actor_id;
    INSERT INTO gear.parties(kind,name,person_type,organization_name,default_responsible_id,note,created_by)
        VALUES (party_kind,party_name,data->>'person_type',data->>'organization_name',person_id,data->>'note',actor_id)
        RETURNING id INTO party_id;
    SELECT to_jsonb(p) INTO result FROM gear.parties p WHERE p.id = party_id;
    INSERT INTO gear.events(scope,event_type,target_party_id,actor_member_id,actor_label,actor_source,after_data,request_id,request_payload)
        VALUES ('party','party_created',party_id,actor_id,actor_name,'user',result,create_party.request_id,data);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_private.initialize_asset(details jsonb, placement jsonb, request_id uuid,
    allow_legacy_duplicate boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor_id uuid; actor_name text; previous gear.events%ROWTYPE; data jsonb; result jsonb;
    holder gear.parties%ROWTYPE; responsible_id uuid; holder_id uuid; use_kind text; known_on date; due_date date;
    asset_id uuid; event_id bigint; number bigint; code text; asset_name text; asset_category text;
    legacy text; duplicate boolean; today date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
    PERFORM 1 FROM gear.app_settings WHERE id = 1 FOR UPDATE;
    actor_id := gear_private.inventory_actor(true);
    IF request_id IS NULL OR allow_legacy_duplicate IS NULL OR jsonb_typeof(details) IS DISTINCT FROM 'object'
        OR jsonb_typeof(placement) IS DISTINCT FROM 'object'
        OR EXISTS (SELECT 1 FROM jsonb_each(details) WHERE key NOT IN
            ('name','category','condition','legacy_code','serial_number','brand','model','location','note')
            OR jsonb_typeof(value) NOT IN ('string','null'))
        OR EXISTS (SELECT 1 FROM jsonb_each(placement) WHERE key NOT IN
            ('holder_party_id','responsible_person_id','usage_kind','known_on','due_on')
            OR jsonb_typeof(value) NOT IN ('string','null')) THEN
        RAISE EXCEPTION 'invalid_asset' USING ERRCODE = '22023'; END IF;
    asset_name := btrim(details->>'name'); asset_category := details->>'category';
    IF asset_name IS NULL OR length(asset_name) NOT BETWEEN 1 AND 120 OR asset_category IS NULL
        OR asset_category NOT IN ('printer','water_dispenser','computer','laptop','power_strip','shredder','smart_display','other')
        OR details->>'condition' IS NULL OR details->>'condition' NOT IN ('normal','faulty')
        OR EXISTS (SELECT 1 FROM jsonb_each_text(details) WHERE length(value) > CASE WHEN key = 'note' THEN 2000 ELSE 120 END) THEN
        RAISE EXCEPTION 'invalid_asset' USING ERRCODE = '22023'; END IF;
    legacy := CASE WHEN nullif(btrim(details->>'legacy_code'),'') IS NOT NULL THEN details->>'legacy_code' END;
    holder_id := nullif(placement->>'holder_party_id','')::uuid;
    responsible_id := nullif(placement->>'responsible_person_id','')::uuid;
    use_kind := nullif(placement->>'usage_kind','');
    IF EXISTS (SELECT 1 FROM jsonb_each_text(placement) WHERE key IN ('known_on','due_on')
        AND nullif(value,'') IS NOT NULL AND value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN
        RAISE EXCEPTION 'invalid_inventory_date' USING ERRCODE = '22023'; END IF;
    BEGIN
        known_on := nullif(placement->>'known_on','')::date;
        due_date := nullif(placement->>'due_on','')::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'invalid_inventory_date' USING ERRCODE = '22023';
    END;
    IF known_on > today THEN RAISE EXCEPTION 'invalid_inventory_date' USING ERRCODE = '22023'; END IF;
    IF holder_id IS NULL THEN
        IF responsible_id IS NOT NULL OR use_kind IS NOT NULL OR due_date IS NOT NULL THEN
            RAISE EXCEPTION 'invalid_placement' USING ERRCODE = '22023'; END IF;
    ELSE
        IF use_kind IS NULL OR use_kind NOT IN ('long_term','temporary')
            OR (use_kind = 'temporary' AND due_date IS NULL) OR (use_kind = 'long_term' AND due_date IS NOT NULL)
            OR due_date < known_on THEN RAISE EXCEPTION 'invalid_placement' USING ERRCODE = '22023'; END IF;
    END IF;
    data := jsonb_build_object('action','initialize_asset','details',jsonb_build_object(
        'name',asset_name,'category',asset_category,'condition',details->>'condition','legacy_code',legacy,
        'serial_number',nullif(btrim(details->>'serial_number'),''),'brand',nullif(btrim(details->>'brand'),''),
        'model',nullif(btrim(details->>'model'),''),'location',nullif(btrim(details->>'location'),''),'note',nullif(btrim(details->>'note'),'')),
        'placement',jsonb_build_object('holder_party_id',holder_id,'responsible_person_id',responsible_id,
            'usage_kind',use_kind,'known_on',known_on,'due_on',due_date),'allow_legacy_duplicate',allow_legacy_duplicate);
    SELECT * INTO previous FROM gear.events e WHERE e.request_id = initialize_asset.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor_id OR previous.request_payload IS DISTINCT FROM data THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE = '22023'; END IF;
        RETURN previous.after_data;
    END IF;
    IF holder_id IS NOT NULL THEN
        SELECT * INTO holder FROM gear.parties WHERE id = holder_id AND kind IN ('person','team') AND is_active;
        IF NOT FOUND THEN RAISE EXCEPTION 'holder_unavailable' USING ERRCODE = '22023'; END IF;
        IF holder.kind = 'person' THEN
            IF responsible_id IS DISTINCT FROM holder_id THEN RAISE EXCEPTION 'responsible_person_required' USING ERRCODE = '22023'; END IF;
        ELSIF NOT EXISTS (SELECT 1 FROM gear.parties WHERE id = responsible_id AND kind = 'person' AND is_active) THEN
            RAISE EXCEPTION 'responsible_person_required' USING ERRCODE = '22023'; END IF;
    END IF;
    duplicate := legacy IS NOT NULL AND EXISTS (SELECT 1 FROM gear.assets a WHERE btrim(a.legacy_code) = btrim(legacy));
    IF duplicate AND NOT allow_legacy_duplicate THEN RAISE EXCEPTION 'legacy_code_duplicate' USING ERRCODE = '22023'; END IF;
    LOOP
        number := nextval('gear.asset_code_sequence'::regclass);
        code := 'SB-' || lpad(number::text,greatest(6,length(number::text)),'0');
        EXIT WHEN NOT EXISTS (SELECT 1 FROM gear.assets WHERE asset_code = code);
    END LOOP;
    SELECT display_name INTO actor_name FROM gear.members WHERE id = actor_id;
    INSERT INTO gear.assets(asset_code,legacy_code,serial_number,name,category,brand,model,location,note,condition,last_flow_on,created_by)
        VALUES (code,legacy,data->'details'->>'serial_number',asset_name,asset_category,data->'details'->>'brand',
            data->'details'->>'model',data->'details'->>'location',data->'details'->>'note',details->>'condition',known_on,actor_id)
        RETURNING id INTO asset_id;
    result := gear_private.asset_record(asset_id) || jsonb_build_object(
        'display_status',CASE WHEN holder_id IS NOT NULL THEN 'in_use' WHEN details->>'condition' = 'faulty' THEN 'inventory_faulty' ELSE 'inventory_available' END,
        'holder_party_id',holder_id,'holder_kind',holder.kind,'holder_name',holder.name,
        'responsible_person_id',responsible_id,'responsible_name',(SELECT name FROM gear.parties WHERE id = responsible_id),
        'usage_kind',use_kind,'started_on',CASE WHEN holder_id IS NOT NULL THEN known_on END,'due_on',due_date,
        'followup_name',CASE WHEN holder_id IS NOT NULL THEN actor_name END,
        'legacy_duplicate_acknowledged',duplicate,'historical_evidence','not_uploaded');
    INSERT INTO gear.events(scope,event_type,asset_id,occurred_on,actor_member_id,actor_label,actor_source,after_data,request_id,request_payload)
        VALUES ('asset','asset_initialized',asset_id,known_on,actor_id,actor_name,'user',result,
            initialize_asset.request_id,data) RETURNING id INTO event_id;
    IF holder_id IS NOT NULL THEN
        INSERT INTO gear.assignments(asset_id,holder_party_id,responsible_person_id,usage_kind,started_on,due_on,opened_event_id,followup_member_id)
            VALUES (asset_id,holder_id,responsible_id,use_kind,known_on,due_date,event_id,actor_id);
    END IF;
    RETURN result;
END;
$$;

CREATE FUNCTION gear_private.list_assets(search text DEFAULT '', category text DEFAULT NULL,
    state text DEFAULT NULL, holder_kind text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE items jsonb; summary jsonb;
BEGIN
    PERFORM gear_private.inventory_actor();
    IF length(coalesce(search,'')) > 120 OR (state IS NOT NULL AND state NOT IN
        ('inventory_available','inventory_faulty','in_use','returned_upstream','lost','scrapped'))
        OR (holder_kind IS NOT NULL AND holder_kind NOT IN ('inventory','person','team')) THEN
        RAISE EXCEPTION 'invalid_inventory_filter' USING ERRCODE = '22023'; END IF;
    WITH records AS (SELECT gear_private.asset_record(a.id) AS value FROM gear.assets a WHERE a.invalidated_at IS NULL)
    SELECT coalesce(jsonb_agg(value ORDER BY value->>'asset_code'),'[]'::jsonb) INTO items FROM records
        WHERE (category IS NULL OR value->>'category' = category) AND (state IS NULL OR value->>'display_status' = state)
        AND (holder_kind IS NULL OR (holder_kind = 'inventory' AND value->>'display_status' IN ('inventory_available','inventory_faulty'))
            OR value->>'holder_kind' = holder_kind)
        AND (coalesce(btrim(search),'') = '' OR strpos(lower(concat_ws(' ',value->>'asset_code',value->>'legacy_code',value->>'serial_number',
            value->>'name',value->>'brand',value->>'model',value->>'holder_name',value->>'responsible_name',value->>'location')),lower(btrim(search))) > 0);
    SELECT jsonb_build_object('total',count(*),'inventory_available',count(*) FILTER (WHERE display_status = 'inventory_available'),
        'inventory_faulty',count(*) FILTER (WHERE display_status = 'inventory_faulty'),'in_use',count(*) FILTER (WHERE display_status = 'in_use'),
        'returned_upstream',count(*) FILTER (WHERE display_status = 'returned_upstream'),'lost',count(*) FILTER (WHERE display_status = 'lost'),
        'scrapped',count(*) FILTER (WHERE display_status = 'scrapped'),'managed_faulty',count(*) FILTER (WHERE management_status = 'managed' AND condition = 'faulty'))
        INTO summary FROM gear.asset_ledger;
    RETURN jsonb_build_object('items',items,'matched',jsonb_array_length(items),'summary',summary);
END;
$$;

CREATE FUNCTION gear_private.get_asset(asset_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE asset jsonb; history jsonb;
BEGIN
    PERFORM gear_private.inventory_actor();
    asset := gear_private.asset_record(asset_id);
    IF asset IS NULL THEN RAISE EXCEPTION 'asset_not_found' USING ERRCODE = '22023'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id::text,'event_type',e.event_type,'occurred_on',e.occurred_on,
        'recorded_at',e.recorded_at,'actor_label',e.actor_label,'reason',e.reason,'after_data',e.after_data) ORDER BY e.id DESC),'[]'::jsonb)
        INTO history FROM gear.events e WHERE e.scope = 'asset' AND e.asset_id = get_asset.asset_id;
    RETURN jsonb_build_object('asset',asset,'history',history);
END;
$$;

CREATE FUNCTION gear.list_parties() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.list_parties(); $$;
CREATE FUNCTION gear.create_party(details jsonb, request_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.create_party(details,request_id); $$;
CREATE FUNCTION gear.initialize_asset(details jsonb, placement jsonb, request_id uuid, allow_legacy_duplicate boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.initialize_asset(details,placement,request_id,allow_legacy_duplicate); $$;
CREATE FUNCTION gear.list_assets(search text DEFAULT '', category text DEFAULT NULL, state text DEFAULT NULL, holder_kind text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.list_assets(search,category,state,holder_kind); $$;
CREATE FUNCTION gear.get_asset(asset_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.get_asset(asset_id); $$;

REVOKE ALL ON FUNCTION gear_private.inventory_actor(boolean),gear_private.asset_record(uuid),
    gear_private.list_parties(),gear_private.create_party(jsonb,uuid),gear_private.initialize_asset(jsonb,jsonb,uuid,boolean),
    gear_private.list_assets(text,text,text,text),gear_private.get_asset(uuid),gear.list_parties(),gear.create_party(jsonb,uuid),
    gear.initialize_asset(jsonb,jsonb,uuid,boolean),gear.list_assets(text,text,text,text),gear.get_asset(uuid)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private.list_parties(),gear_private.create_party(jsonb,uuid),gear_private.initialize_asset(jsonb,jsonb,uuid,boolean),
    gear_private.list_assets(text,text,text,text),gear_private.get_asset(uuid),gear.list_parties(),gear.create_party(jsonb,uuid),
    gear.initialize_asset(jsonb,jsonb,uuid,boolean),gear.list_assets(text,text,text,text),gear.get_asset(uuid) TO authenticated;
COMMIT;
