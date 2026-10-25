-- Human references supplement internal UUIDs; original rows and snapshots stay intact.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.asset_record(uuid)') AND md5(prosrc)='8c041300f38034fe0e0b84c3acec38c6') THEN RAISE EXCEPTION 'reference_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.list_assets(text,text,text,text)') AND md5(prosrc)='bb6e0edf1fc3de5c88f6bf38b87c2553') THEN RAISE EXCEPTION 'reference_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.list_documents(text,text,text)') AND md5(prosrc)='c871160dffec21dc65f2a104e4757dce') THEN RAISE EXCEPTION 'reference_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.list_originals()') AND md5(prosrc)='51923c9a69fc2f4c14a4304fa575a4bd') THEN RAISE EXCEPTION 'reference_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.protect_record()') AND md5(prosrc)='09f421a9346a53a4249907c5023aa966') THEN RAISE EXCEPTION 'reference_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.protect_attachment()') AND md5(prosrc)='39c8f8f1c475a52ef620bf7bd1786ae2') THEN RAISE EXCEPTION 'reference_source_mismatch'; END IF;
END; $$;

CREATE FUNCTION gear_private_2026.reference_code(prefix text,identity_id uuid,created_at timestamptz) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
DECLARE alphabet text:='0123456789ABCDEFGHJKMNPQRSTVWXYZ'; number bigint;
    token text:=''; position integer;
BEGIN
    number:=('x'||right(replace(identity_id::text,'-',''),10))::bit(40)::bigint;
    FOR position IN 1..8 LOOP
        token:=substr(alphabet,(number%32)::integer+1,1)||token;
        number:=number/32;
    END LOOP;
    RETURN prefix||'-'||to_char(created_at AT TIME ZONE 'Asia/Shanghai','YY')||'-'||left(token,4)||'-'||right(token,4);
END; $$;
REVOKE ALL ON FUNCTION gear_private_2026.reference_code(text,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE gear_2026.assets ADD COLUMN reference_code text GENERATED ALWAYS AS (gear_private_2026.reference_code('EQ',id,created_at)) STORED NOT NULL;
CREATE UNIQUE INDEX assets_reference_code_key ON gear_2026.assets(reference_code);

ALTER TABLE gear_2026.documents ADD COLUMN reference_code text GENERATED ALWAYS AS (gear_private_2026.reference_code('DC',id,created_at)) STORED NOT NULL;
CREATE UNIQUE INDEX documents_reference_code_key ON gear_2026.documents(reference_code);

ALTER TABLE gear_2026.parties ADD COLUMN reference_code text GENERATED ALWAYS AS (gear_private_2026.reference_code(CASE WHEN kind='person' THEN 'PE' WHEN kind='team' THEN 'TM' ELSE 'PT' END,id,created_at)) STORED NOT NULL;
CREATE UNIQUE INDEX parties_reference_code_key ON gear_2026.parties(reference_code);

ALTER TABLE gear_2026.attachments ADD COLUMN reference_code text GENERATED ALWAYS AS (gear_private_2026.reference_code('AT',id,created_at)) STORED NOT NULL;
CREATE UNIQUE INDEX attachments_reference_code_key ON gear_2026.attachments(reference_code);

CREATE OR REPLACE FUNCTION gear_private_2026.asset_record(identity_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT to_jsonb(a) || jsonb_build_object(
        'asset_code',a.reference_code,'previous_asset_code',a.asset_code,
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
CREATE OR REPLACE FUNCTION gear_private_2026.list_assets(search text DEFAULT '', category text DEFAULT NULL,
    state text DEFAULT NULL, holder_kind text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE items jsonb; summary jsonb;
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    IF length(coalesce(search,'')) > 120 OR (state IS NOT NULL AND state NOT IN
        ('inventory_available','inventory_faulty','in_use','returned_upstream','lost','scrapped'))
        OR (holder_kind IS NOT NULL AND holder_kind NOT IN ('inventory','person','team')) THEN
        RAISE EXCEPTION 'invalid_inventory_filter' USING ERRCODE = '22023'; END IF;
    WITH records AS (SELECT gear_private_2026.asset_record(a.id) AS value FROM gear_2026.assets a WHERE a.invalidated_at IS NULL)
    SELECT coalesce(jsonb_agg(value ORDER BY value->>'asset_code'),'[]'::jsonb) INTO items FROM records
        WHERE (category IS NULL OR value->>'category' = category) AND (state IS NULL OR value->>'display_status' = state)
        AND (holder_kind IS NULL OR (holder_kind = 'inventory' AND value->>'display_status' IN ('inventory_available','inventory_faulty'))
            OR value->>'holder_kind' = holder_kind)
        AND (coalesce(btrim(search),'') = '' OR strpos(lower(concat_ws(' ',value->>'asset_code',value->>'previous_asset_code',value->>'legacy_code',value->>'serial_number',
            value->>'name',value->>'brand',value->>'model',value->>'holder_name',value->>'responsible_name',value->>'location')),lower(btrim(search))) > 0);
    SELECT jsonb_build_object('total',count(*),'inventory_available',count(*) FILTER (WHERE display_status = 'inventory_available'),
        'inventory_faulty',count(*) FILTER (WHERE display_status = 'inventory_faulty'),'in_use',count(*) FILTER (WHERE display_status = 'in_use'),
        'returned_upstream',count(*) FILTER (WHERE display_status = 'returned_upstream'),'lost',count(*) FILTER (WHERE display_status = 'lost'),
        'scrapped',count(*) FILTER (WHERE display_status = 'scrapped'),'managed_faulty',count(*) FILTER (WHERE management_status = 'managed' AND condition = 'faulty'))
        INTO summary FROM gear_2026.asset_ledger;
    RETURN jsonb_build_object('items',items,'matched',jsonb_array_length(items),'summary',summary);
END;
$$;
CREATE OR REPLACE FUNCTION gear_private_2026.list_documents(search text DEFAULT '', kind text DEFAULT NULL, state text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid := gear_private_2026.inventory_actor(); result jsonb;
BEGIN
    IF length(coalesce(search,'')) > 120 OR (kind IS NOT NULL AND kind NOT IN ('receipt','issue','return','transfer'))
        OR (state IS NOT NULL AND state NOT IN ('draft','confirmed','voided')) THEN
        RAISE EXCEPTION 'invalid_document' USING ERRCODE = '22023'; END IF;
    SELECT coalesce(jsonb_agg(value ORDER BY value->>'created_at' DESC,value->>'id'),'[]'::jsonb) INTO result
        FROM (SELECT to_jsonb(d) || jsonb_build_object('item_count',(SELECT count(*) FROM gear_2026.document_items i WHERE i.document_id = d.id)) AS value
        FROM gear_2026.documents d WHERE (d.status <> 'draft' OR gear_private_2026.current_role() = 'admin'
            OR (gear_private_2026.current_role() = 'operator' AND d.created_by = actor))
        AND (list_documents.kind IS NULL OR d.kind = list_documents.kind)
        AND (state IS NULL OR d.status = state)
        AND (coalesce(btrim(search),'') = '' OR strpos(lower(concat_ws(' ',d.document_no,d.reference_code,d.from_label,d.to_label,d.sender_name,d.receiver_name)),lower(btrim(search))) > 0)) t;
    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION gear_private_2026.list_originals() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'reference_code',a.reference_code,'created_at',a.created_at,'document_id',a.document_id,
        'event_id',a.event_id::text,'original_name',a.original_name,'media_type',a.media_type,'size_bytes',a.size_bytes,
        'sha256',a.sha256,'is_active',a.is_active,'review_state',a.review_state) ORDER BY a.id)
        FROM gear_2026.attachments a LEFT JOIN gear_2026.documents d ON d.id=a.document_id
        WHERE a.upload_state='ready' AND (a.event_id IS NOT NULL OR d.status<>'draft')),'[]'::jsonb);
END;
$$;

-- Generated values are unavailable inside BEFORE triggers; compare frozen source fields only.
CREATE OR REPLACE FUNCTION gear_private_2026.protect_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE protected_doc uuid;
BEGIN
    IF TG_TABLE_NAME = 'events' THEN RAISE EXCEPTION 'events are append only' USING ERRCODE = '23514'; END IF;
    IF TG_TABLE_NAME = 'assets' THEN
        IF TG_OP = 'DELETE' OR NEW.asset_code IS DISTINCT FROM OLD.asset_code THEN
            RAISE EXCEPTION 'asset identity is permanent' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'parties' THEN
        IF NEW.kind IS DISTINCT FROM OLD.kind THEN
            RAISE EXCEPTION 'party kind is permanent' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'documents' THEN
        IF OLD.status <> 'draft' THEN
            IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'formal document cannot be deleted' USING ERRCODE = '23514'; END IF;
            IF (OLD.status = 'voided' AND NEW.status <> 'voided') OR NEW.status = 'draft'
                OR (to_jsonb(NEW) - ARRAY['reference_code','status','evidence_state','archived_by','archived_at','voided_by','voided_at','void_reason','version','updated_at'])
                    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['reference_code','status','evidence_state','archived_by','archived_at','voided_by','voided_at','void_reason','version','updated_at']) THEN
                RAISE EXCEPTION 'formal document fields are frozen' USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'document_items' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT d.id INTO protected_doc FROM gear_2026.documents d WHERE d.id = OLD.document_id AND d.status <> 'draft';
        END IF;
        IF protected_doc IS NOT NULL OR (TG_OP <> 'DELETE' AND EXISTS (
            SELECT 1 FROM gear_2026.documents d WHERE d.id = NEW.document_id AND d.status <> 'draft')) THEN
            RAISE EXCEPTION 'formal document items are frozen' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gear_private_2026.protect_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'DELETE' OR (OLD.upload_state = 'ready' AND
        (to_jsonb(NEW) - ARRAY['reference_code','document_id','event_id','review_state','reviewed_by','reviewed_at','is_active',
            'correction_reason','source_kind','external_reference','ocr_state','ocr_result','ocr_error_code','version','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['reference_code','document_id','event_id','review_state','reviewed_by','reviewed_at','is_active',
            'correction_reason','source_kind','external_reference','ocr_state','ocr_result','ocr_error_code','version','updated_at'])) THEN
        RAISE EXCEPTION 'attachment_original_is_permanent' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION gear_private_2026.resolve_reference(entity_kind text,reference text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=gear_private_2026.inventory_actor(); result uuid; code text:=upper(btrim(reference));
BEGIN
    IF code IS NULL OR length(code)>64 OR code !~ '^[A-Z0-9-]+$' THEN
        RAISE EXCEPTION 'reference_not_found' USING ERRCODE='22023'; END IF;
    CASE entity_kind
    WHEN 'asset' THEN SELECT id INTO result FROM gear_2026.assets WHERE reference_code=code OR asset_code=code;
    WHEN 'document' THEN
        SELECT d.id INTO result FROM gear_2026.documents d WHERE (d.reference_code=code OR d.document_no=code)
            AND (d.status<>'draft' OR gear_private_2026.current_role()='admin'
                OR (gear_private_2026.current_role()='operator' AND d.created_by=actor));
    WHEN 'party' THEN SELECT id INTO result FROM gear_2026.parties WHERE reference_code=code AND kind IN ('person','team');
    ELSE RAISE EXCEPTION 'reference_not_found' USING ERRCODE='22023';
    END CASE;
    IF result IS NULL THEN RAISE EXCEPTION 'reference_not_found' USING ERRCODE='22023'; END IF;
    RETURN result;
END; $$;
CREATE FUNCTION gear_2026.resolve_reference(entity_kind text,reference text) RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT gear_private_2026.resolve_reference(entity_kind,reference); $$;
REVOKE ALL ON FUNCTION gear_private_2026.resolve_reference(text,text),gear_2026.resolve_reference(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.resolve_reference(text,text),gear_2026.resolve_reference(text,text) TO authenticated;

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
                RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001', DETAIL = jsonb_build_object('asset_code',asset.reference_code)::text; END IF;
            SELECT * INTO assignment FROM gear_2026.assignments WHERE asset_id = asset.id AND closed_at IS NULL FOR UPDATE;
            IF doc.handover_on < greatest(asset.last_flow_on,assignment.started_on,
                (SELECT max(e.occurred_on) FROM gear_2026.events e WHERE e.asset_id = asset.id
                    AND e.event_type IN ('asset_fault_reported','asset_repaired'))) THEN
                RAISE EXCEPTION 'invalid_document_date' USING ERRCODE = '22023', DETAIL = jsonb_build_object('asset_code',asset.reference_code)::text; END IF;
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
                RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001', DETAIL = jsonb_build_object('asset_code',asset.reference_code)::text; END IF;
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
            IF NOT FOUND THEN RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001', DETAIL = jsonb_build_object('asset_code',asset.reference_code)::text; END IF;
        END IF;
        IF NOT new_asset THEN
            UPDATE gear_2026.assets SET management_status = CASE WHEN doc.kind = 'return' AND doc.to_kind = 'external' THEN 'returned_upstream' ELSE 'managed' END,
                condition = item.condition_on_handover,location = item.location,last_flow_on = doc.handover_on
                WHERE id = asset.id AND version = item.expected_asset_version;
            IF NOT FOUND THEN RAISE EXCEPTION 'asset_flow_conflict' USING ERRCODE = '40001', DETAIL = jsonb_build_object('asset_code',asset.reference_code)::text; END IF;
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

CREATE OR REPLACE FUNCTION gear_private_2026.void_document(document_id uuid, expected_version integer,
    reason text, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; doc gear_2026.documents%ROWTYPE;
    item gear_2026.document_items%ROWTYPE; asset gear_2026.assets%ROWTYPE;
    assignment gear_2026.assignments%ROWTYPE; prior_assignment gear_2026.assignments%ROWTYPE;
    original gear_2026.events%ROWTYPE; before_state jsonb; after_state jsonb; original_doc jsonb;
    payload jsonb; result jsonb; reversal_id bigint; latest bigint; explanation text:=btrim(reason);
    today date:=(now() AT TIME ZONE 'Asia/Shanghai')::date;
    state_keys text[]:=ARRAY['management_status','condition','location','last_flow_on',
        'holder_party_id','responsible_person_id','usage_kind','started_on','due_on'];
    key text;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.document_review_actor();
    IF request_id IS NULL OR document_id IS NULL OR expected_version IS NULL OR expected_version<1
        OR explanation IS NULL OR length(explanation) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'invalid_document_void' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','void_document','document_id',document_id,
        'expected_version',expected_version,'reason',explanation);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=void_document.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO doc FROM gear_2026.documents d WHERE d.id=void_document.document_id FOR UPDATE;
    IF NOT FOUND OR doc.version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'document_conflict' USING ERRCODE='40001'; END IF;
    IF doc.status<>'confirmed' THEN RAISE EXCEPTION 'document_not_confirmed' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM gear_2026.events e JOIN gear_2026.documents source ON source.id=e.document_id
        WHERE e.event_type='document_corrected' AND e.after_data->>'replacement_document_id'=doc.id::text
            AND source.status='confirmed') THEN
        RAISE EXCEPTION 'document_has_dependencies' USING ERRCODE='22023'; END IF;
    original_doc:=gear_private_2026.document_record(doc.id)-'changes';
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id=actor;
    PERFORM a.id FROM gear_2026.assets a JOIN gear_2026.document_items i ON i.asset_id=a.id
        WHERE i.document_id=doc.id ORDER BY a.id FOR UPDATE OF a;
    FOR item IN SELECT * FROM gear_2026.document_items i WHERE i.document_id=doc.id ORDER BY i.line_no LOOP
        SELECT * INTO asset FROM gear_2026.assets a WHERE a.id=item.asset_id;
        SELECT * INTO original FROM gear_2026.events e WHERE e.id=item.confirmed_event_id;
        SELECT max(e.id) INTO latest FROM gear_2026.events e WHERE e.asset_id=asset.id AND e.affects_asset_state
            AND e.reverses_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM gear_2026.events z WHERE z.reverses_event_id=e.id);
        IF asset.id IS NULL OR asset.invalidated_at IS NOT NULL OR original.id IS NULL
            OR original.document_id IS DISTINCT FROM doc.id OR latest IS DISTINCT FROM original.id
            OR EXISTS(SELECT 1 FROM gear_2026.events z WHERE z.reverses_event_id=original.id) THEN
            RAISE EXCEPTION 'document_has_dependencies' USING ERRCODE='22023',DETAIL=jsonb_build_object('asset_code',asset.reference_code)::text; END IF;
        before_state:=gear_private_2026.asset_record(asset.id);
        FOREACH key IN ARRAY state_keys LOOP
            IF before_state->key IS DISTINCT FROM item.state_after->key THEN
                RAISE EXCEPTION 'document_state_conflict' USING ERRCODE='40001',DETAIL=jsonb_build_object('asset_code',asset.reference_code)::text; END IF;
        END LOOP;
        SELECT * INTO assignment FROM gear_2026.assignments x WHERE x.asset_id=asset.id AND x.closed_at IS NULL FOR UPDATE;
        SELECT * INTO prior_assignment FROM gear_2026.assignments x WHERE x.asset_id=asset.id AND x.closed_event_id=original.id FOR UPDATE;
        reversal_id:=nextval(pg_get_serial_sequence('gear_2026.events','id'));
        IF doc.kind='transfer' AND doc.transfer_mode='responsibility' THEN
            IF assignment.id IS NULL OR prior_assignment.id IS NOT NULL THEN
                RAISE EXCEPTION 'document_state_conflict' USING ERRCODE='40001'; END IF;
            UPDATE gear_2026.assignments SET responsible_person_id=(item.state_before->>'responsible_person_id')::uuid
                WHERE id=assignment.id;
        ELSE
            IF doc.kind IN ('issue','transfer') THEN
                IF assignment.id IS NULL OR assignment.opened_event_id IS DISTINCT FROM original.id
                    OR assignment.source_item_id IS DISTINCT FROM item.id THEN
                    RAISE EXCEPTION 'document_state_conflict' USING ERRCODE='40001'; END IF;
                UPDATE gear_2026.assignments SET closed_at=now(),ended_on=doc.handover_on,closed_event_id=reversal_id WHERE id=assignment.id;
            ELSIF assignment.id IS NOT NULL THEN
                RAISE EXCEPTION 'document_state_conflict' USING ERRCODE='40001'; END IF;
            IF item.state_before->>'holder_party_id' IS NOT NULL THEN
                IF prior_assignment.id IS NULL THEN RAISE EXCEPTION 'document_state_conflict' USING ERRCODE='40001'; END IF;
                UPDATE gear_2026.assignments SET closed_at=NULL,ended_on=NULL,closed_event_id=NULL WHERE id=prior_assignment.id;
            ELSIF prior_assignment.id IS NOT NULL THEN
                RAISE EXCEPTION 'document_state_conflict' USING ERRCODE='40001'; END IF;
        END IF;
        IF item.state_before='{}'::jsonb THEN
            UPDATE gear_2026.assets SET invalidated_at=now(),invalidated_by=actor,invalid_reason=explanation WHERE id=asset.id;
        ELSE
            -- Restore handover fields only; later descriptive corrections survive.
            UPDATE gear_2026.assets SET management_status=item.state_before->>'management_status',
                condition=item.state_before->>'condition',location=item.state_before->>'location',
                last_flow_on=(item.state_before->>'last_flow_on')::date WHERE id=asset.id;
        END IF;
        after_state:=gear_private_2026.asset_record(asset.id) || jsonb_build_object('document_id',doc.id,'document_no',doc.document_no);
        INSERT INTO gear_2026.events(id,scope,event_type,asset_id,document_id,document_item_id,occurred_on,
            actor_member_id,actor_label,actor_source,affects_asset_state,before_data,after_data,reason,reverses_event_id)
            OVERRIDING SYSTEM VALUE VALUES(reversal_id,'asset','document_voided',asset.id,doc.id,item.id,today,
                actor,actor_name,'user',true,before_state,after_state,explanation,original.id);
    END LOOP;
    UPDATE gear_2026.documents SET status='voided',voided_by=actor,voided_at=now(),void_reason=explanation
        WHERE id=doc.id RETURNING version INTO doc.version;
    result:=jsonb_build_object('id',doc.id,'status','voided','version',doc.version);
    INSERT INTO gear_2026.events(scope,event_type,document_id,occurred_on,actor_member_id,actor_label,
        actor_source,before_data,after_data,reason,request_id,request_payload)
        VALUES('document','document_voided',doc.id,today,actor,actor_name,'user',original_doc,result,explanation,request_id,payload);
    RETURN result;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
