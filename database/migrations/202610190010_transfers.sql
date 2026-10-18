-- Extend the existing shared draft/confirmation transaction, preserving RPCs and ACLs.
-- Ordinary transfer starts new possession; same-team responsibility keeps its identity.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.save_document(jsonb,jsonb,uuid,uuid,integer)') AND md5(prosrc)='4ac60977ee7744087ea74f7f35988c0e') THEN RAISE EXCEPTION 'transfer_source_mismatch'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.confirm_document(uuid,integer,uuid)') AND md5(prosrc)='36d12ea1360a0c3c870dfcc5c59359e6') THEN RAISE EXCEPTION 'transfer_source_mismatch'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION gear_private_2026.save_document(details jsonb, items jsonb, request_id uuid,
    document_id uuid DEFAULT NULL, expected_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; doc gear_2026.documents%ROWTYPE;
    payload jsonb; old_record jsonb; result jsonb; item jsonb; index integer := 0; new_data jsonb; saved_id uuid;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id = 1 FOR UPDATE;
    actor := gear_private_2026.inventory_actor(true);
    IF request_id IS NULL OR jsonb_typeof(details) IS DISTINCT FROM 'object' OR jsonb_typeof(items) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'invalid_document' USING ERRCODE = '22023'; END IF;
    payload := jsonb_build_object('action','save_document','details',details,'items',items,'document_id',document_id,'expected_version',expected_version);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id = save_document.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE = '22023'; END IF;
        RETURN previous.after_data;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(details) WHERE key NOT IN ('kind','handover_on','from_kind','to_kind','from_party_id','to_party_id',
        'from_person_id','to_person_id','from_label','to_label','sender_name','receiver_name','usage_kind','due_on','remarks','transfer_mode')
        OR jsonb_typeof(value) NOT IN ('string','null') OR length(value #>> '{}') > CASE WHEN key = 'remarks' THEN 2000 ELSE 120 END)
        OR details->>'kind' IS NULL OR details->>'kind' NOT IN ('receipt','issue','return','transfer')
        OR (details->>'from_kind' IS NOT NULL AND details->>'from_kind' NOT IN ('inventory','party','external'))
        OR (details->>'to_kind' IS NOT NULL AND details->>'to_kind' NOT IN ('inventory','party','external'))
        OR (details->>'usage_kind' IS NOT NULL AND details->>'usage_kind' NOT IN ('long_term','temporary'))
        OR (details->>'kind' = 'transfer' AND (details->>'transfer_mode' IS NULL OR details->>'transfer_mode' NOT IN ('holder','responsibility')))
        OR (details->>'kind' <> 'transfer' AND details->>'transfer_mode' IS NOT NULL)
        OR jsonb_array_length(items) > 100 THEN RAISE EXCEPTION 'invalid_document' USING ERRCODE = '22023'; END IF;
    IF document_id IS NOT NULL THEN
        SELECT * INTO doc FROM gear_2026.documents WHERE id = document_id FOR UPDATE;
        IF NOT FOUND OR doc.status <> 'draft' OR (doc.created_by <> actor AND gear_private_2026.current_role() <> 'admin') THEN
            RAISE EXCEPTION 'draft_access_denied' USING ERRCODE = '42501'; END IF;
        IF expected_version IS DISTINCT FROM doc.version THEN RAISE EXCEPTION 'document_conflict' USING ERRCODE = '40001'; END IF;
        old_record := gear_private_2026.document_record(document_id);
        saved_id := document_id;
    ELSE
        IF expected_version IS NOT NULL THEN RAISE EXCEPTION 'invalid_document' USING ERRCODE = '22023'; END IF;
        INSERT INTO gear_2026.documents(create_request_id,kind,transfer_mode,created_by) VALUES (request_id,details->>'kind',details->>'transfer_mode',actor) RETURNING id INTO saved_id;
    END IF;
    UPDATE gear_2026.documents SET kind = details->>'kind', transfer_mode = details->>'transfer_mode', handover_on = gear_private_2026.flow_date(details->>'handover_on'),
        from_kind = nullif(details->>'from_kind',''), to_kind = nullif(details->>'to_kind',''),
        from_party_id = nullif(details->>'from_party_id','')::uuid,to_party_id = nullif(details->>'to_party_id','')::uuid,
        from_person_id = nullif(details->>'from_person_id','')::uuid,to_person_id = nullif(details->>'to_person_id','')::uuid,
        from_label = nullif(btrim(details->>'from_label'),''),to_label = nullif(btrim(details->>'to_label'),''),
        sender_name = nullif(btrim(details->>'sender_name'),''),receiver_name = nullif(btrim(details->>'receiver_name'),''),
        usage_kind = nullif(details->>'usage_kind',''),due_on = gear_private_2026.flow_date(details->>'due_on'),remarks = nullif(btrim(details->>'remarks'),'')
        WHERE id = saved_id;
    DELETE FROM gear_2026.document_items WHERE gear_2026.document_items.document_id = saved_id;
    IF (SELECT count(*) FROM jsonb_array_elements(items) x WHERE nullif(x->>'asset_id','') IS NOT NULL)
        <> (SELECT count(DISTINCT (x->>'asset_id')::uuid) FROM jsonb_array_elements(items) x WHERE nullif(x->>'asset_id','') IS NOT NULL) THEN
        RAISE EXCEPTION 'duplicate_document_asset' USING ERRCODE = '22023'; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
        index := index + 1;
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM jsonb_each(item) WHERE key NOT IN
            ('asset_id','new_asset_data','expected_asset_version','condition_on_handover','location','note','allow_legacy_duplicate'))
            OR EXISTS (SELECT 1 FROM jsonb_each(item) WHERE key IN ('asset_id','condition_on_handover','location','note') AND jsonb_typeof(value) NOT IN ('string','null'))
            OR (item ? 'allow_legacy_duplicate' AND jsonb_typeof(item->'allow_legacy_duplicate') <> 'boolean')
            OR (item->>'condition_on_handover' IS NOT NULL AND item->>'condition_on_handover' NOT IN ('normal','faulty'))
            OR (item->>'condition_on_handover' = 'faulty' AND nullif(btrim(item->>'note'),'') IS NULL)
            OR length(coalesce(item->>'location','')) > 120 OR length(coalesce(item->>'note','')) > 2000 THEN
            RAISE EXCEPTION 'invalid_document_item' USING ERRCODE = '22023'; END IF;
        new_data := nullif(item->'new_asset_data','null'::jsonb);
        IF new_data IS NOT NULL AND (jsonb_typeof(new_data) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_each(new_data)
            WHERE key NOT IN ('name','category','legacy_code','serial_number','brand','model','note') OR jsonb_typeof(value) NOT IN ('string','null')
            OR length(value #>> '{}') > CASE WHEN key = 'note' THEN 2000 ELSE 120 END)) THEN
            RAISE EXCEPTION 'invalid_document_item' USING ERRCODE = '22023'; END IF;
        IF (nullif(item->>'asset_id','') IS NULL) = (new_data IS NULL)
            OR (new_data IS NOT NULL AND details->>'kind' <> 'receipt')
            OR (new_data IS NULL AND (jsonb_typeof(item->'expected_asset_version') IS DISTINCT FROM 'number'
                OR coalesce(item->>'expected_asset_version','') !~ '^[1-9][0-9]*$'))
            OR (new_data IS NOT NULL AND nullif(item->>'expected_asset_version','') IS NOT NULL)
            OR (new_data IS NULL AND coalesce((item->>'allow_legacy_duplicate')::boolean,false)) THEN
            RAISE EXCEPTION 'invalid_document_item' USING ERRCODE = '22023'; END IF;
        INSERT INTO gear_2026.document_items(document_id,line_no,asset_id,new_asset_data,expected_asset_version,condition_on_handover,location,note,allow_legacy_duplicate)
            VALUES (saved_id,index,nullif(item->>'asset_id','')::uuid,new_data,nullif(item->>'expected_asset_version','')::integer,
                item->>'condition_on_handover',nullif(btrim(item->>'location'),''),nullif(btrim(item->>'note'),''),coalesce((item->>'allow_legacy_duplicate')::boolean,false));
    END LOOP;
    result := gear_private_2026.document_record(saved_id);
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id = actor;
    INSERT INTO gear_2026.events(scope,event_type,actor_member_id,actor_label,actor_source,before_data,after_data,request_id,request_payload)
        VALUES ('draft',CASE WHEN document_id IS NULL THEN 'draft_created' ELSE 'draft_updated' END,actor,actor_name,'user',old_record,result,request_id,payload);
    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION gear_private_2026.confirm_document(document_id uuid, expected_version integer, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; doc gear_2026.documents%ROWTYPE; item gear_2026.document_items%ROWTYPE;
    asset gear_2026.assets%ROWTYPE; assignment gear_2026.assignments%ROWTYPE; from_party gear_2026.parties%ROWTYPE; to_party gear_2026.parties%ROWTYPE;
    before_state jsonb; after_state jsonb; snapshot jsonb; payload jsonb; result jsonb; event_id bigint;
    responsibility boolean; confirmed timestamptz; today date; number bigint; prefix text; code text; new_data jsonb; new_asset boolean;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id = 1 FOR UPDATE;
    actor := gear_private_2026.inventory_actor(true);
    IF request_id IS NULL THEN RAISE EXCEPTION 'invalid_document' USING ERRCODE = '22023'; END IF;
    payload := jsonb_build_object('action','confirm_document','document_id',document_id,'expected_version',expected_version);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id = confirm_document.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE = '22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO doc FROM gear_2026.documents WHERE id = document_id FOR UPDATE;
    IF NOT FOUND OR doc.status <> 'draft' OR (doc.created_by <> actor AND gear_private_2026.current_role() <> 'admin') THEN
        RAISE EXCEPTION 'draft_access_denied' USING ERRCODE = '42501'; END IF;
    IF doc.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'document_conflict' USING ERRCODE = '40001'; END IF;
    responsibility := doc.kind = 'transfer' AND doc.transfer_mode = 'responsibility';
    confirmed := clock_timestamp(); today := (confirmed AT TIME ZONE 'Asia/Shanghai')::date;
    IF doc.kind NOT IN ('receipt','issue','return','transfer') OR doc.handover_on IS NULL OR doc.handover_on > today
        OR doc.sender_name IS NULL OR doc.receiver_name IS NULL OR NOT EXISTS (SELECT 1 FROM gear_2026.document_items WHERE gear_2026.document_items.document_id = doc.id) THEN
        RAISE EXCEPTION 'incomplete_document' USING ERRCODE = '22023'; END IF;
    IF doc.kind = 'receipt' THEN
        IF doc.from_kind IS DISTINCT FROM 'external' OR doc.to_kind IS DISTINCT FROM 'inventory' OR doc.from_label IS NULL
            OR doc.from_party_id IS NOT NULL OR doc.to_party_id IS NOT NULL OR doc.from_person_id IS NOT NULL OR doc.to_person_id IS NOT NULL THEN
            RAISE EXCEPTION 'invalid_document_parties' USING ERRCODE = '22023'; END IF;
        doc.to_label := '经办人库存';
    ELSIF doc.kind = 'issue' THEN
        IF doc.from_kind IS DISTINCT FROM 'inventory' OR doc.to_kind IS DISTINCT FROM 'party' OR doc.from_party_id IS NOT NULL OR doc.from_person_id IS NOT NULL THEN
            RAISE EXCEPTION 'invalid_document_parties' USING ERRCODE = '22023'; END IF;
        doc.from_label := '经办人库存';
    ELSIF doc.kind = 'transfer' THEN
        IF doc.from_kind IS DISTINCT FROM 'party' OR doc.to_kind IS DISTINCT FROM 'party'
            OR doc.from_party_id IS NULL OR doc.to_party_id IS NULL OR doc.from_person_id IS NULL OR doc.to_person_id IS NULL
            OR doc.transfer_mode IS NULL OR doc.transfer_mode NOT IN ('holder','responsibility')
            OR (NOT responsibility AND doc.from_party_id = doc.to_party_id)
            OR (responsibility AND (doc.from_party_id IS DISTINCT FROM doc.to_party_id OR doc.from_person_id = doc.to_person_id
                OR NOT EXISTS (SELECT 1 FROM gear_2026.parties WHERE id=doc.from_party_id AND kind='team'))) THEN
            RAISE EXCEPTION 'invalid_transfer_parties' USING ERRCODE = '22023'; END IF;
    ELSE
        IF doc.from_kind IS NULL OR doc.to_kind IS NULL OR doc.from_kind NOT IN ('inventory','party') OR doc.to_kind NOT IN ('inventory','external')
            OR doc.from_kind = doc.to_kind OR doc.to_party_id IS NOT NULL OR doc.to_person_id IS NOT NULL
            OR (doc.from_kind = 'inventory' AND (doc.from_party_id IS NOT NULL OR doc.from_person_id IS NOT NULL))
            OR (doc.to_kind = 'external' AND doc.to_label IS NULL) OR nullif(btrim(doc.remarks),'') IS NULL THEN
            RAISE EXCEPTION 'invalid_document_parties' USING ERRCODE = '22023'; END IF;
        IF doc.from_kind = 'inventory' THEN doc.from_label := '经办人库存'; END IF;
        IF doc.to_kind = 'inventory' THEN doc.to_label := '经办人库存'; END IF;
    END IF;
    IF doc.from_kind = 'party' THEN
        SELECT * INTO from_party FROM gear_2026.parties WHERE id = doc.from_party_id AND kind IN ('person','team');
        -- Inactive recipients may still return real equipment; new issues require active recipients.
        IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM gear_2026.parties WHERE id = doc.from_person_id AND kind = 'person')
            OR (from_party.kind = 'person' AND doc.from_person_id IS DISTINCT FROM from_party.id) THEN
            RAISE EXCEPTION 'invalid_document_parties' USING ERRCODE = '22023'; END IF;
        doc.from_label := from_party.name;
    END IF;
    IF doc.to_kind = 'party' THEN
        SELECT * INTO to_party FROM gear_2026.parties WHERE id = doc.to_party_id AND kind IN ('person','team') AND is_active;
        IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM gear_2026.parties WHERE id = doc.to_person_id AND kind = 'person' AND is_active)
            OR (to_party.kind = 'person' AND doc.to_person_id IS DISTINCT FROM to_party.id) THEN
            RAISE EXCEPTION 'invalid_document_parties' USING ERRCODE = '22023'; END IF;
        doc.to_label := to_party.name;
    END IF;
    IF ((doc.kind = 'issue' OR (doc.kind = 'transfer' AND NOT responsibility)) AND (doc.usage_kind IS NULL OR doc.usage_kind NOT IN ('long_term','temporary')
        OR (doc.usage_kind = 'long_term' AND doc.due_on IS NOT NULL) OR (doc.usage_kind = 'temporary' AND (doc.due_on IS NULL OR doc.due_on < doc.handover_on))))
        OR (NOT (doc.kind = 'issue' OR (doc.kind = 'transfer' AND NOT responsibility)) AND (doc.usage_kind IS NOT NULL OR doc.due_on IS NOT NULL)) THEN
        RAISE EXCEPTION 'invalid_placement' USING ERRCODE = '22023'; END IF;
    PERFORM a.id FROM gear_2026.assets a JOIN gear_2026.document_items i ON i.asset_id = a.id WHERE i.document_id = doc.id ORDER BY a.id FOR UPDATE OF a;
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id = actor;
    number := gear_private_2026.next_document_sequence(confirmed);
    prefix := CASE doc.kind WHEN 'receipt' THEN 'LR' WHEN 'issue' THEN 'FF' WHEN 'transfer' THEN 'ZJ' ELSE 'TH' END;
    doc.document_no := prefix || '-' || to_char(today,'YYYYMMDD') || '-' || lpad(number::text,greatest(4,length(number::text)),'0');
    FOR item IN SELECT * FROM gear_2026.document_items WHERE gear_2026.document_items.document_id = doc.id ORDER BY line_no LOOP
        new_asset := item.asset_id IS NULL;
        assignment := NULL;
        IF item.condition_on_handover IS NULL OR (item.condition_on_handover = 'faulty' AND nullif(btrim(item.note),'') IS NULL) THEN
            RAISE EXCEPTION 'invalid_document_item' USING ERRCODE = '22023'; END IF;
        IF new_asset THEN
            new_data := item.new_asset_data;
            IF doc.kind <> 'receipt' OR nullif(btrim(new_data->>'name'),'') IS NULL OR new_data->>'category' IS NULL
                OR new_data->>'category' NOT IN ('printer','water_dispenser','computer','laptop','power_strip','shredder','smart_display','other') THEN
                RAISE EXCEPTION 'invalid_asset' USING ERRCODE = '22023'; END IF;
            IF nullif(btrim(new_data->>'legacy_code'),'') IS NOT NULL AND NOT item.allow_legacy_duplicate AND EXISTS (
                SELECT 1 FROM gear_2026.assets WHERE btrim(legacy_code) = btrim(new_data->>'legacy_code')) THEN
                RAISE EXCEPTION 'legacy_code_duplicate' USING ERRCODE = '22023', DETAIL = jsonb_build_object('line_no',item.line_no)::text; END IF;
            LOOP
                number := nextval('gear_2026.asset_code_sequence'::regclass);
                code := 'SB-' || lpad(number::text,greatest(6,length(number::text)),'0');
                EXIT WHEN NOT EXISTS (SELECT 1 FROM gear_2026.assets WHERE asset_code = code);
            END LOOP;
            INSERT INTO gear_2026.assets(asset_code,name,category,legacy_code,serial_number,brand,model,note,location,condition,last_flow_on,created_by)
                VALUES (code,btrim(new_data->>'name'),new_data->>'category',CASE WHEN nullif(btrim(new_data->>'legacy_code'),'') IS NOT NULL THEN new_data->>'legacy_code' END,
                    nullif(btrim(new_data->>'serial_number'),''),nullif(btrim(new_data->>'brand'),''),nullif(btrim(new_data->>'model'),''),
                    nullif(btrim(new_data->>'note'),''),item.location,item.condition_on_handover,doc.handover_on,actor) RETURNING * INTO asset;
            before_state := '{}'::jsonb;
        ELSE
            SELECT * INTO asset FROM gear_2026.assets WHERE id = item.asset_id;
            IF NOT FOUND OR asset.invalidated_at IS NOT NULL OR asset.version IS DISTINCT FROM item.expected_asset_version THEN
                RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001', DETAIL = jsonb_build_object('asset_code',asset.asset_code)::text; END IF;
            SELECT * INTO assignment FROM gear_2026.assignments WHERE asset_id = asset.id AND closed_at IS NULL FOR UPDATE;
            IF doc.handover_on < greatest(asset.last_flow_on,assignment.started_on) THEN
                RAISE EXCEPTION 'invalid_document_date' USING ERRCODE = '22023', DETAIL = jsonb_build_object('asset_code',asset.asset_code)::text; END IF;
            IF (doc.kind = 'receipt' AND (asset.management_status <> 'returned_upstream' OR assignment.id IS NOT NULL))
                OR (doc.kind = 'issue' AND (asset.management_status <> 'managed' OR asset.condition <> 'normal' OR assignment.id IS NOT NULL OR item.condition_on_handover <> 'normal'))
                OR (doc.kind = 'return' AND (asset.management_status <> 'managed'
                    OR (doc.from_kind = 'inventory' AND assignment.id IS NOT NULL)
                    OR (doc.from_kind = 'party' AND (assignment.id IS NULL OR assignment.holder_party_id IS DISTINCT FROM doc.from_party_id
                        OR assignment.responsible_person_id IS DISTINCT FROM doc.from_person_id))))
                OR (doc.kind = 'transfer' AND (asset.management_status <> 'managed' OR assignment.id IS NULL
                    OR assignment.holder_party_id IS DISTINCT FROM doc.from_party_id
                    OR assignment.responsible_person_id IS DISTINCT FROM doc.from_person_id
                    OR (NOT responsibility AND (asset.condition <> 'normal' OR item.condition_on_handover <> 'normal'))
                    OR (responsibility AND item.condition_on_handover IS DISTINCT FROM asset.condition))) THEN
                RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001', DETAIL = jsonb_build_object('asset_code',asset.asset_code)::text; END IF;
            before_state := gear_private_2026.asset_record(asset.id);
        END IF;
        event_id := nextval(pg_get_serial_sequence('gear_2026.events','id'));
        IF responsibility THEN
            -- Responsibility changes inside the same continuous possession period.
            -- Keep assignment identity, original start/deadline, source and follow-up.
            UPDATE gear_2026.assignments SET responsible_person_id = doc.to_person_id WHERE id = assignment.id AND closed_at IS NULL;
            IF NOT FOUND THEN RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001'; END IF;
        ELSIF assignment.id IS NOT NULL THEN
            UPDATE gear_2026.assignments SET closed_at = confirmed,ended_on = doc.handover_on,closed_event_id = event_id WHERE id = assignment.id AND closed_at IS NULL;
            IF NOT FOUND THEN RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001', DETAIL = jsonb_build_object('asset_code',asset.asset_code)::text; END IF;
        END IF;
        IF NOT new_asset THEN
            UPDATE gear_2026.assets SET management_status = CASE WHEN doc.kind = 'return' AND doc.to_kind = 'external' THEN 'returned_upstream' ELSE 'managed' END,
                condition = item.condition_on_handover,location = item.location,last_flow_on = doc.handover_on
                WHERE id = asset.id AND version = item.expected_asset_version;
            IF NOT FOUND THEN RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001', DETAIL = jsonb_build_object('asset_code',asset.asset_code)::text; END IF;
        END IF;
        IF doc.kind = 'issue' OR (doc.kind = 'transfer' AND NOT responsibility) THEN
            INSERT INTO gear_2026.assignments(asset_id,holder_party_id,responsible_person_id,usage_kind,started_on,due_on,opened_event_id,source_item_id,followup_member_id)
                VALUES (asset.id,doc.to_party_id,doc.to_person_id,doc.usage_kind,doc.handover_on,doc.due_on,event_id,item.id,actor);
        END IF;
        after_state := gear_private_2026.asset_record(asset.id) || jsonb_build_object('document_id',doc.id,'document_no',doc.document_no,'document_kind',doc.kind);
        snapshot := after_state - ARRAY['document_id','document_no','document_kind'];
        INSERT INTO gear_2026.events(id,scope,event_type,asset_id,document_id,document_item_id,occurred_on,actor_member_id,actor_label,actor_source,
            affects_asset_state,before_data,after_data,reason) OVERRIDING SYSTEM VALUE
            VALUES (event_id,'asset','document_confirmed',asset.id,doc.id,item.id,doc.handover_on,actor,actor_name,'user',true,before_state,after_state,coalesce(item.note,doc.remarks));
        UPDATE gear_2026.document_items SET asset_id = asset.id,asset_snapshot = snapshot,state_before = before_state,state_after = after_state,confirmed_event_id = event_id WHERE id = item.id;
    END LOOP;
    UPDATE gear_2026.documents SET status = 'confirmed',document_no = doc.document_no,numbering_on = today,
        number_value = split_part(doc.document_no,'-',3)::bigint,handover_on = doc.handover_on,
        from_label = doc.from_label,to_label = doc.to_label,
        header_snapshot = jsonb_build_object('title',(SELECT document_header FROM gear_2026.app_settings WHERE id = 1),'operator_name',actor_name,'number_format','prefix-business-date-daily-sequence'),
        parties_snapshot = jsonb_build_object('from_label',doc.from_label,'to_label',doc.to_label,'sender_name',doc.sender_name,'receiver_name',doc.receiver_name,
            'from_responsible_name',(SELECT name FROM gear_2026.parties WHERE id = doc.from_person_id),'to_responsible_name',(SELECT name FROM gear_2026.parties WHERE id = doc.to_person_id),
            'usage_kind',doc.usage_kind,'due_on',doc.due_on,'handover_on',doc.handover_on,'transfer_mode',doc.transfer_mode),
        evidence_state = 'awaiting_upload',confirmed_by = actor,confirmed_at = confirmed,confirmed_revision = doc.version WHERE id = doc.id AND version = expected_version;
    IF NOT FOUND THEN RAISE EXCEPTION 'document_conflict' USING ERRCODE = '40001'; END IF;
    result := gear_private_2026.document_record(doc.id);
    INSERT INTO gear_2026.events(scope,event_type,document_id,occurred_on,actor_member_id,actor_label,actor_source,after_data,request_id,request_payload)
        VALUES ('document','document_confirmed',doc.id,doc.handover_on,actor,actor_name,'user',result,request_id,payload);
    RETURN result;
END;
$$;

-- CREATE OR REPLACE retains existing ownership, object IDs and EXECUTE grants.
NOTIFY pgrst,'reload schema';
COMMIT;
