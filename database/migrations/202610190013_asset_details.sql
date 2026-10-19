-- Audited descriptive corrections; no changes to ownership or handover facts.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION gear_private_2026.update_asset_details(asset_id uuid, expected_version integer,
    details jsonb, reason text, request_id uuid, allow_legacy_duplicate boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; asset gear_2026.assets%ROWTYPE;
    fields jsonb; payload jsonb; before_state jsonb; result jsonb;
    asset_name text; asset_category text; legacy text; explanation text:=btrim(reason);
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF asset_id IS NULL OR expected_version IS NULL OR expected_version<1 OR request_id IS NULL
        OR allow_legacy_duplicate IS NULL OR explanation IS NULL OR length(explanation) NOT BETWEEN 1 AND 2000
        OR jsonb_typeof(details) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid_asset_details' USING ERRCODE='22023'; END IF;
    IF NOT (details ?& ARRAY['name','category','legacy_code','serial_number','brand','model','location','note'])
        OR EXISTS(SELECT 1 FROM jsonb_each(details) WHERE key NOT IN
            ('name','category','legacy_code','serial_number','brand','model','location','note')
            OR jsonb_typeof(value) NOT IN ('string','null')) THEN
        RAISE EXCEPTION 'invalid_asset_details' USING ERRCODE='22023'; END IF;
    asset_name:=btrim(details->>'name'); asset_category:=details->>'category';
    IF asset_name IS NULL OR length(asset_name) NOT BETWEEN 1 AND 120 OR asset_category IS NULL
        OR asset_category NOT IN ('printer','water_dispenser','computer','laptop','power_strip','shredder','smart_display','other')
        OR EXISTS(SELECT 1 FROM jsonb_each_text(details) WHERE length(value)>CASE WHEN key='note' THEN 2000 ELSE 120 END) THEN
        RAISE EXCEPTION 'invalid_asset_details' USING ERRCODE='22023'; END IF;
    legacy:=CASE WHEN nullif(btrim(details->>'legacy_code'),'') IS NOT NULL THEN details->>'legacy_code' END;
    fields:=jsonb_build_object('name',asset_name,'category',asset_category,'legacy_code',legacy,
        'serial_number',nullif(btrim(details->>'serial_number'),''),'brand',nullif(btrim(details->>'brand'),''),
        'model',nullif(btrim(details->>'model'),''),'location',nullif(btrim(details->>'location'),''),'note',nullif(btrim(details->>'note'),''));
    payload:=jsonb_build_object('action','update_asset_details','asset_id',asset_id,'expected_version',expected_version,
        'details',fields,'reason',explanation,'allow_legacy_duplicate',allow_legacy_duplicate);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=update_asset_details.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data - 'previous_details';
    END IF;
    SELECT * INTO asset FROM gear_2026.assets a WHERE a.id=update_asset_details.asset_id FOR UPDATE;
    IF NOT FOUND OR asset.version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'asset_details_conflict' USING ERRCODE='40001'; END IF;
    IF asset.invalidated_at IS NOT NULL THEN
        RAISE EXCEPTION 'asset_details_unavailable' USING ERRCODE='22023'; END IF;
    IF to_jsonb(asset) @> fields THEN
        RAISE EXCEPTION 'asset_details_unchanged' USING ERRCODE='22023'; END IF;
    IF legacy IS NOT NULL AND legacy IS DISTINCT FROM asset.legacy_code AND NOT allow_legacy_duplicate
        AND EXISTS(SELECT 1 FROM gear_2026.assets a WHERE a.id<>asset.id AND btrim(a.legacy_code)=btrim(legacy)) THEN
        RAISE EXCEPTION 'legacy_code_duplicate' USING ERRCODE='22023'; END IF;
    before_state:=gear_private_2026.asset_record(asset.id);
    UPDATE gear_2026.assets SET name=fields->>'name',category=fields->>'category',legacy_code=legacy,
        serial_number=fields->>'serial_number',brand=fields->>'brand',model=fields->>'model',
        location=fields->>'location',note=fields->>'note' WHERE id=asset.id;
    result:=gear_private_2026.asset_record(asset.id);
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id=actor;
    INSERT INTO gear_2026.events(scope,event_type,asset_id,occurred_on,actor_member_id,actor_label,
        actor_source,affects_asset_state,before_data,after_data,reason,request_id,request_payload)
        VALUES('asset','asset_updated',asset.id,(now() AT TIME ZONE 'Asia/Shanghai')::date,actor,actor_name,
            'user',false,before_state,result || jsonb_build_object('previous_details',
                (SELECT jsonb_object_agg(key,value) FROM jsonb_each(before_state) WHERE fields ? key)),
            explanation,request_id,payload);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_2026.update_asset_details(asset_id uuid, expected_version integer, details jsonb,
    reason text, request_id uuid, allow_legacy_duplicate boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT gear_private_2026.update_asset_details(asset_id,expected_version,details,reason,request_id,allow_legacy_duplicate);
$$;
REVOKE ALL ON FUNCTION gear_private_2026.update_asset_details(uuid,integer,jsonb,text,uuid,boolean),
    gear_2026.update_asset_details(uuid,integer,jsonb,text,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.update_asset_details(uuid,integer,jsonb,text,uuid,boolean),
    gear_2026.update_asset_details(uuid,integer,jsonb,text,uuid,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
