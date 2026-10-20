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
NOTIFY pgrst,'reload schema';
COMMIT;
