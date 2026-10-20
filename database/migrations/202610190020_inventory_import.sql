-- One batch, one transaction; reuse individual inventory validation and history.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE FUNCTION gear_private_2026.import_assets(rows jsonb,request_id uuid,allow_legacy_duplicate boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE actor uuid; prior gear_2026.events%ROWTYPE; payload jsonb; item jsonb; result jsonb;
    items jsonb:='[]'::jsonb; position integer:=0; nonce uuid; person uuid; error_message text;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF request_id IS NULL OR allow_legacy_duplicate IS NULL OR jsonb_typeof(rows) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'invalid_inventory_import' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(rows) NOT BETWEEN 1 AND 200 OR octet_length(rows::text)>1048576 THEN
        RAISE EXCEPTION 'invalid_inventory_import' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','import_assets','rows',rows,'allow_legacy_duplicate',allow_legacy_duplicate);
    SELECT * INTO prior FROM gear_2026.events e WHERE e.request_id=import_assets.request_id;
    IF FOUND THEN
        IF prior.actor_member_id IS DISTINCT FROM actor OR prior.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN prior.after_data;
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
        position:=position+1;
        BEGIN
            IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['details','placement','actual_user_id']<>'{}'::jsonb THEN
                RAISE EXCEPTION 'invalid_inventory_import' USING ERRCODE='22023'; END IF;
            nonce:=md5(request_id::text||':'||position::text)::uuid;
            result:=gear_private_2026.initialize_asset(item->'details',item->'placement',nonce,allow_legacy_duplicate);
            person:=nullif(item->>'actual_user_id','')::uuid;
            IF person IS NOT NULL THEN
                result:=gear_private_2026.set_assignment_user((result->>'id')::uuid,(result->>'version')::integer,
                    person,'批量导入已有设备的具体使用人',md5(request_id::text||':user:'||position::text)::uuid);
            END IF;
            items:=items||jsonb_build_array(result);
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS error_message=MESSAGE_TEXT;
            RAISE EXCEPTION 'inventory_import_row_error' USING ERRCODE='22023',
                DETAIL=jsonb_build_object('line_no',position+1,'cause',error_message)::text;
        END;
    END LOOP;
    result:=jsonb_build_object('items',items,'imported',position);
    INSERT INTO gear_2026.events(scope,event_type,actor_member_id,actor_label,actor_source,after_data,request_id,request_payload)
        VALUES('settings','assets_imported',actor,(SELECT display_name FROM gear_2026.members WHERE id=actor),'user',result,request_id,payload);
    RETURN result;
END;
$$;
CREATE FUNCTION gear_2026.import_assets(rows jsonb,request_id uuid,allow_legacy_duplicate boolean DEFAULT false)
    RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
    SELECT gear_private_2026.import_assets(rows,request_id,allow_legacy_duplicate); $$;
REVOKE ALL ON FUNCTION gear_2026.import_assets(jsonb,uuid,boolean),gear_private_2026.import_assets(jsonb,uuid,boolean)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_2026.import_assets(jsonb,uuid,boolean),gear_private_2026.import_assets(jsonb,uuid,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
