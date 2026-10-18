-- Private originals, manual review and audited corrections. Storage is configured separately.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE gear_2026.attachments
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    ADD COLUMN reserved_size_bytes bigint CHECK (reserved_size_bytes BETWEEN 1 AND 20971520),
    ADD COLUMN upload_manifest jsonb CHECK (jsonb_typeof(upload_manifest) = 'object'),
    ADD COLUMN source_kind text NOT NULL DEFAULT 'internal' CHECK (source_kind IN ('internal','external')),
    ADD COLUMN external_reference text CHECK (length(external_reference) <= 120);
ALTER TABLE gear_2026.events DROP CONSTRAINT events_event_type_check;
ALTER TABLE gear_2026.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
    'asset_initialized','asset_updated','asset_fault_reported','asset_repaired','asset_lost','asset_scrapped',
    'asset_found','asset_invalidated','assignment_extended','document_confirmed','document_voided',
    'draft_created','draft_updated','draft_deleted','party_created','party_updated','member_applied',
    'member_reviewed','member_role_changed','settings_updated','attachment_uploaded','attachment_reviewed',
    'attachment_corrected','attachment_reserved','attachment_cancelled'));

CREATE FUNCTION gear_private_2026.protect_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'DELETE' OR (OLD.upload_state = 'ready' AND
        (to_jsonb(NEW) - ARRAY['document_id','event_id','review_state','reviewed_by','reviewed_at','is_active',
            'correction_reason','source_kind','external_reference','ocr_state','ocr_result','ocr_error_code','version','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['document_id','event_id','review_state','reviewed_by','reviewed_at','is_active',
            'correction_reason','source_kind','external_reference','ocr_state','ocr_result','ocr_error_code','version','updated_at'])) THEN
        RAISE EXCEPTION 'attachment_original_is_permanent' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_attachment BEFORE UPDATE OR DELETE ON gear_2026.attachments
    FOR EACH ROW EXECUTE FUNCTION gear_private_2026.protect_attachment();

CREATE FUNCTION gear_private_2026.evidence_changed(doc_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    UPDATE gear_2026.attachments SET review_state='pending',reviewed_by=NULL,reviewed_at=NULL
        WHERE document_id=doc_id AND is_active AND upload_state='ready' AND review_state<>'pending';
    UPDATE gear_2026.documents SET evidence_state=CASE WHEN EXISTS (SELECT 1 FROM gear_2026.attachments
        WHERE document_id=doc_id AND is_active AND upload_state='ready') THEN 'awaiting_review' ELSE 'awaiting_upload' END,
        archived_by=NULL,archived_at=NULL WHERE id=doc_id;
END;
$$;
CREATE FUNCTION gear_private_2026.evidence_hints(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE item jsonb;
BEGIN
    IF value IS NULL THEN RETURN '{"document_ids":[],"document_numbers":[],"source":"browser_hint"}'::jsonb; END IF;
    IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value-'document_ids'-'document_numbers' <> '{}'::jsonb
        OR jsonb_typeof(value->'document_ids') IS DISTINCT FROM 'array'
        OR jsonb_typeof(value->'document_numbers') IS DISTINCT FROM 'array'
        OR jsonb_array_length(value->'document_ids')>20 OR jsonb_array_length(value->'document_numbers')>20 THEN
        RAISE EXCEPTION 'invalid_evidence_hints' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT v FROM jsonb_array_elements(value->'document_ids') v LOOP
        IF jsonb_typeof(item)<>'string' OR (item#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'invalid_evidence_hints' USING ERRCODE='22023'; END IF;
    END LOOP;
    FOR item IN SELECT v FROM jsonb_array_elements(value->'document_numbers') v LOOP
        IF jsonb_typeof(item)<>'string' OR (item#>>'{}') !~ '^(LR|FF|TH|ZJ)-[0-9]{8}-[0-9]{4,19}$' THEN
            RAISE EXCEPTION 'invalid_evidence_hints' USING ERRCODE='22023'; END IF;
    END LOOP;
    RETURN value||'{"source":"browser_hint"}'::jsonb;
END;
$$;
CREATE FUNCTION gear_private_2026.get_attachment(attachment_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor uuid:=gear_private_2026.inventory_actor(); result gear_2026.attachments%ROWTYPE;
BEGIN
    SELECT * INTO result FROM gear_2026.attachments WHERE id=attachment_id;
    IF NOT FOUND OR result.document_id IS NULL OR (result.upload_state<>'ready' AND NOT (gear_private_2026.current_role()='admin' OR (gear_private_2026.current_role()='operator' AND result.uploaded_by=actor))) THEN
        RAISE EXCEPTION 'attachment_not_found' USING ERRCODE='42501'; END IF;
    PERFORM gear_private_2026.get_document(result.document_id);
    RETURN to_jsonb(result);
END;
$$;
CREATE FUNCTION gear_private_2026.list_evidence(document_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor uuid:=gear_private_2026.inventory_actor(); doc jsonb;
BEGIN
    doc:=gear_private_2026.get_document(document_id);
    RETURN jsonb_build_object('document_version',doc->'version','evidence_state',doc->'evidence_state',
        'items',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at,a.id) FROM gear_2026.attachments a
        WHERE a.document_id=list_evidence.document_id AND (a.upload_state='ready' OR (a.uploaded_by=actor AND gear_private_2026.current_role()='operator')
            OR gear_private_2026.current_role()='admin')),'[]'::jsonb),
        'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'event_type',e.event_type,
            'recorded_at',e.recorded_at,'actor_label',e.actor_label,'reason',e.reason,'before_data',e.before_data,
            'after_data',e.after_data) ORDER BY e.id DESC) FROM gear_2026.events e
            WHERE e.event_type IN ('attachment_reserved','attachment_uploaded','attachment_cancelled','attachment_reviewed','attachment_corrected')
            AND (e.document_id=list_evidence.document_id OR e.before_data->>'document_id'=list_evidence.document_id::text
                OR e.after_data->>'document_id'=list_evidence.document_id::text) AND (e.scope='document' OR gear_private_2026.current_role()='admin' OR (gear_private_2026.current_role()='operator' AND e.actor_member_id=actor))),'[]'::jsonb));
END;
$$;
CREATE FUNCTION gear_private_2026.match_evidence(hints jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid:=gear_private_2026.inventory_actor(); safe jsonb:=gear_private_2026.evidence_hints(hints);
BEGIN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'document_no',d.document_no,
        'kind',d.kind,'status',d.status,'handover_on',d.handover_on,'from_label',d.from_label,'to_label',d.to_label))
        FROM gear_2026.documents d WHERE d.status<>'draft' AND (safe->'document_ids' ? d.id::text
            OR safe->'document_numbers' ? d.document_no)),'[]'::jsonb);
END;
$$;
CREATE FUNCTION gear_private_2026.reserve_attachment(document_id uuid, details jsonb, expected_version integer, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor uuid; previous gear_2026.events%ROWTYPE; doc gear_2026.documents%ROWTYPE; result gear_2026.attachments%ROWTYPE;
    payload jsonb; amount bigint; identity_id uuid:=gen_random_uuid(); source text; reference text; reason text;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF request_id IS NULL THEN RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','reserve_attachment','document_id',document_id,'details',details,'expected_version',expected_version);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=reserve_attachment.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO doc FROM gear_2026.documents WHERE id=document_id FOR UPDATE;
    IF NOT FOUND OR doc.status<>'confirmed' THEN RAISE EXCEPTION 'evidence_document_unavailable' USING ERRCODE='22023'; END IF;
    IF expected_version IS DISTINCT FROM doc.version THEN RAISE EXCEPTION 'document_conflict' USING ERRCODE='40001'; END IF;
    IF jsonb_typeof(details) IS DISTINCT FROM 'object' OR details-ARRAY['original_name','size_bytes','sha256','media_type','source_kind','external_reference','correction_reason']<>'{}'::jsonb
        OR jsonb_typeof(details->'original_name') IS DISTINCT FROM 'string' OR length(btrim(details->>'original_name')) NOT BETWEEN 1 AND 180
        OR details->>'original_name' ~ '[/\\[:cntrl:]]' OR jsonb_typeof(details->'size_bytes') IS DISTINCT FROM 'number'
        OR (details->>'size_bytes') !~ '^[0-9]{1,8}$' OR (details->>'sha256') !~ '^[0-9a-f]{64}$'
        OR details->>'sha256' IS NULL OR coalesce(details->>'media_type','') NOT IN ('image/jpeg','image/png','application/pdf')
        OR EXISTS(SELECT 1 FROM jsonb_each(details) WHERE key NOT IN ('size_bytes') AND jsonb_typeof(value) NOT IN ('string','null')) THEN
        RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    amount:=(details->>'size_bytes')::bigint; source:=coalesce(details->>'source_kind','internal');
    reference:=nullif(btrim(details->>'external_reference'),''); reason:=nullif(btrim(details->>'correction_reason'),'');
    IF amount NOT BETWEEN 1 AND 20971520 OR source NOT IN ('internal','external') OR length(reference)>120
        OR (source='external' AND (reference IS NULL OR doc.kind<>'receipt')) OR length(reason)>1000 THEN
        RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    IF doc.evidence_state='archived' AND (gear_private_2026.current_role()<>'admin' OR reason IS NULL) THEN
        RAISE EXCEPTION 'archived_evidence_admin_required' USING ERRCODE='42501'; END IF;
    IF EXISTS(SELECT 1 FROM gear_2026.attachments a WHERE a.document_id=reserve_attachment.document_id AND a.is_active
        AND a.upload_state IN ('ready','pending') AND a.upload_manifest->>'sha256'=details->>'sha256') THEN
        RAISE EXCEPTION 'duplicate_attachment' USING ERRCODE='22023'; END IF;
    IF (SELECT count(*) FROM gear_2026.attachments WHERE attachments.document_id=reserve_attachment.document_id
        AND is_active AND upload_state IN ('ready','pending'))>=10 OR
        (SELECT coalesce(sum(coalesce(size_bytes,reserved_size_bytes)),0) FROM gear_2026.attachments
        WHERE attachments.document_id=reserve_attachment.document_id AND is_active AND upload_state IN ('ready','pending'))+amount>104857600 THEN
        RAISE EXCEPTION 'evidence_limit_exceeded' USING ERRCODE='22023'; END IF;
    INSERT INTO gear_2026.attachments(id,document_id,storage_key,original_name,uploaded_by,reserved_size_bytes,upload_manifest,source_kind,external_reference,correction_reason)
    VALUES(identity_id,document_id,identity_id::text||'/'||gen_random_uuid()::text,btrim(details->>'original_name'),actor,amount,details,source,reference,reason)
    RETURNING * INTO result;
    INSERT INTO gear_2026.events(scope,event_type,document_id,actor_member_id,actor_label,actor_source,after_data,reason,request_id,request_payload)
    VALUES('draft','attachment_reserved',NULL,actor,(SELECT display_name FROM gear_2026.members WHERE id=actor),'user',to_jsonb(result),reason,request_id,payload);
    RETURN to_jsonb(result);
END;
$$;
-- Only the dedicated Edge function may attest file bytes, hash, MIME and PDF page count.
CREATE FUNCTION gear_2026.commit_attachment(attachment_id uuid, actor_auth_id uuid, verified jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor gear_2026.members%ROWTYPE; item gear_2026.attachments%ROWTYPE; doc gear_2026.documents%ROWTYPE;
    previous gear_2026.events%ROWTYPE; payload jsonb; hints jsonb; before_state jsonb;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    SELECT m.* INTO actor FROM gear_2026.members m JOIN auth.users u ON u.id=m.auth_user_id
        WHERE u.id=actor_auth_id AND u.email_confirmed_at IS NOT NULL AND u.email IS NOT NULL
        AND m.status='active' AND m.role IN ('admin','operator');
    IF NOT FOUND THEN RAISE EXCEPTION 'inventory_access_denied' USING ERRCODE='42501'; END IF;
    SELECT * INTO item FROM gear_2026.attachments WHERE id=attachment_id FOR UPDATE;
    IF NOT FOUND OR item.uploaded_by<>actor.id THEN RAISE EXCEPTION 'attachment_not_found' USING ERRCODE='42501'; END IF;
    payload:=jsonb_build_object('action','commit_attachment','attachment_id',attachment_id,'verified',verified);
    SELECT * INTO previous FROM gear_2026.events WHERE request_id=attachment_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor.id OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO doc FROM gear_2026.documents WHERE id=item.document_id FOR UPDATE;
    IF doc.status<>'confirmed' OR item.upload_state<>'pending' OR NOT item.is_active THEN
        RAISE EXCEPTION 'evidence_document_unavailable' USING ERRCODE='22023'; END IF;
    IF doc.evidence_state='archived' AND (actor.role<>'admin' OR item.correction_reason IS NULL) THEN
        RAISE EXCEPTION 'archived_evidence_admin_required' USING ERRCODE='42501'; END IF;
    IF jsonb_typeof(verified) IS DISTINCT FROM 'object' OR verified-ARRAY['media_type','size_bytes','sha256','page_count','recognition']<>'{}'::jsonb
        OR verified->>'media_type' IS DISTINCT FROM item.upload_manifest->>'media_type'
        OR verified->>'sha256' IS DISTINCT FROM item.upload_manifest->>'sha256'
        OR verified->>'size_bytes' IS DISTINCT FROM item.upload_manifest->>'size_bytes'
        OR jsonb_typeof(verified->'page_count') IS DISTINCT FROM 'number' OR (verified->>'page_count') !~ '^[0-9]{1,2}$'
        OR (verified->>'page_count')::integer NOT BETWEEN 1 AND 20
        OR (verified->>'media_type'<>'application/pdf' AND (verified->>'page_count')::integer<>1) THEN
        RAISE EXCEPTION 'invalid_verified_file' USING ERRCODE='22023'; END IF;
    hints:=gear_private_2026.evidence_hints(verified->'recognition');
    before_state:=jsonb_build_object('document',to_jsonb(doc),'attachments',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb)
        FROM gear_2026.attachments a WHERE a.document_id=doc.id AND a.upload_state='ready'));
    UPDATE gear_2026.attachments SET upload_state='ready',uploaded_at=clock_timestamp(),media_type=verified->>'media_type',
        size_bytes=(verified->>'size_bytes')::bigint,sha256=verified->>'sha256',page_count=(verified->>'page_count')::integer,
        ocr_state=CASE WHEN hints->'document_ids'='[]'::jsonb AND hints->'document_numbers'='[]'::jsonb THEN 'failed' ELSE 'succeeded' END,
        ocr_result=hints,ocr_error_code=CASE WHEN hints->'document_ids'='[]'::jsonb AND hints->'document_numbers'='[]'::jsonb THEN 'not_detected' ELSE NULL END
        WHERE id=attachment_id RETURNING * INTO item;
    PERFORM gear_private_2026.evidence_changed(doc.id);
    SELECT * INTO item FROM gear_2026.attachments WHERE id=attachment_id;
    INSERT INTO gear_2026.events(scope,event_type,document_id,actor_member_id,actor_label,actor_source,before_data,after_data,reason,request_id,request_payload)
    VALUES('document','attachment_uploaded',doc.id,actor.id,actor.display_name,'user',before_state,to_jsonb(item),item.correction_reason,attachment_id,payload);
    -- Drain Gear deferred checks while inside the narrowly scoped definer, without table grants to service_role.
    SET CONSTRAINTS gear_2026.check_relations IMMEDIATE;
    SET CONSTRAINTS gear_2026.check_relations DEFERRED;
    RETURN to_jsonb(item);
END;
$$;
CREATE FUNCTION gear_private_2026.cancel_attachment(attachment_id uuid, expected_version integer, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor uuid; item gear_2026.attachments%ROWTYPE; previous gear_2026.events%ROWTYPE; payload jsonb; before_state jsonb;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE; actor:=gear_private_2026.inventory_actor(true);
    IF request_id IS NULL THEN RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','cancel_attachment','attachment_id',attachment_id,'expected_version',expected_version);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=cancel_attachment.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF; RETURN previous.after_data; END IF;
    SELECT * INTO item FROM gear_2026.attachments WHERE id=attachment_id FOR UPDATE;
    IF NOT FOUND OR (item.uploaded_by<>actor AND gear_private_2026.current_role()<>'admin') THEN
        RAISE EXCEPTION 'attachment_not_found' USING ERRCODE='42501'; END IF;
    IF item.version IS DISTINCT FROM expected_version OR item.upload_state='ready' THEN
        RAISE EXCEPTION 'attachment_conflict' USING ERRCODE='40001'; END IF;
    before_state:=to_jsonb(item);
    UPDATE gear_2026.attachments SET upload_state='failed',is_active=false WHERE id=attachment_id RETURNING * INTO item;
    INSERT INTO gear_2026.events(scope,event_type,document_id,actor_member_id,actor_label,actor_source,before_data,after_data,request_id,request_payload)
    VALUES('draft','attachment_cancelled',NULL,actor,(SELECT display_name FROM gear_2026.members WHERE id=actor),'user',before_state,to_jsonb(item),request_id,payload);
    RETURN to_jsonb(item);
END;
$$;
CREATE FUNCTION gear_private_2026.update_attachment(attachment_id uuid, expected_version integer, changes jsonb, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor uuid; item gear_2026.attachments%ROWTYPE; target uuid; source_doc gear_2026.documents%ROWTYPE; target_doc gear_2026.documents%ROWTYPE;
    previous gear_2026.events%ROWTYPE; payload jsonb; reason text; reference text; active boolean; before_state jsonb; hints jsonb;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE; actor:=gear_private_2026.inventory_actor(true);
    IF request_id IS NULL OR jsonb_typeof(changes) IS DISTINCT FROM 'object'
        OR changes-ARRAY['document_id','is_active','external_reference','recognition','reason']<>'{}'::jsonb
        OR jsonb_typeof(changes->'reason') IS DISTINCT FROM 'string' OR length(btrim(changes->>'reason')) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','update_attachment','attachment_id',attachment_id,'expected_version',expected_version,'changes',changes);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=update_attachment.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF; RETURN previous.after_data; END IF;
    SELECT * INTO item FROM gear_2026.attachments WHERE id=attachment_id FOR UPDATE;
    IF NOT FOUND OR item.document_id IS NULL OR item.upload_state<>'ready' THEN RAISE EXCEPTION 'attachment_not_found' USING ERRCODE='42501'; END IF;
    IF item.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'attachment_conflict' USING ERRCODE='40001'; END IF;
    IF changes ? 'document_id' AND (jsonb_typeof(changes->'document_id')<>'string' OR (changes->>'document_id') !~ '^[0-9a-f-]{36}$')
        OR changes ? 'is_active' AND jsonb_typeof(changes->'is_active')<>'boolean'
        OR changes ? 'external_reference' AND jsonb_typeof(changes->'external_reference') NOT IN ('string','null') THEN
        RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    target:=coalesce((changes->>'document_id')::uuid,item.document_id); reason:=btrim(changes->>'reason');
    active:=coalesce((changes->>'is_active')::boolean,item.is_active);
    reference:=CASE WHEN changes ? 'external_reference' THEN nullif(btrim(changes->>'external_reference'),'') ELSE item.external_reference END;
    IF length(reference)>120 OR (item.source_kind='external' AND reference IS NULL) THEN RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM gear_2026.documents WHERE id IN (item.document_id,target) ORDER BY id FOR UPDATE;
    SELECT * INTO source_doc FROM gear_2026.documents WHERE id=item.document_id; SELECT * INTO target_doc FROM gear_2026.documents WHERE id=target;
    IF target_doc.id IS NULL OR source_doc.status<>'confirmed' OR target_doc.status<>'confirmed' OR (item.source_kind='external' AND target_doc.kind<>'receipt') THEN
        RAISE EXCEPTION 'evidence_document_unavailable' USING ERRCODE='22023'; END IF;
    IF (source_doc.evidence_state='archived' OR target_doc.evidence_state='archived' OR item.review_state='accepted') AND gear_private_2026.current_role()<>'admin' THEN
        RAISE EXCEPTION 'archived_evidence_admin_required' USING ERRCODE='42501'; END IF;
    IF active AND ((SELECT count(*) FROM gear_2026.attachments a WHERE a.document_id=target AND a.id<>item.id AND a.is_active AND a.upload_state IN ('ready','pending'))>=10
        OR (SELECT coalesce(sum(coalesce(a.size_bytes,a.reserved_size_bytes)),0) FROM gear_2026.attachments a WHERE a.document_id=target AND a.id<>item.id
            AND a.is_active AND a.upload_state IN ('ready','pending'))+item.size_bytes>104857600) THEN
        RAISE EXCEPTION 'evidence_limit_exceeded' USING ERRCODE='22023'; END IF;
    hints:=CASE WHEN changes ? 'recognition' THEN gear_private_2026.evidence_hints(changes->'recognition') ELSE item.ocr_result END;
    before_state:=jsonb_build_object('document_id',item.document_id,'attachment',to_jsonb(item),'source_document',to_jsonb(source_doc),
        'target_document',to_jsonb(target_doc),'reviews',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) FROM gear_2026.attachments a WHERE a.document_id IN (item.document_id,target) AND a.upload_state='ready'));
    UPDATE gear_2026.attachments SET document_id=target,is_active=active,external_reference=reference,correction_reason=reason,
        review_state='pending',reviewed_by=NULL,reviewed_at=NULL,ocr_result=hints,
        ocr_state=CASE WHEN hints IS NULL THEN 'none' WHEN hints->'document_ids'='[]'::jsonb AND hints->'document_numbers'='[]'::jsonb THEN 'failed' ELSE 'succeeded' END,
        ocr_error_code=CASE WHEN hints->'document_ids'='[]'::jsonb AND hints->'document_numbers'='[]'::jsonb THEN 'not_detected' ELSE NULL END
        WHERE id=attachment_id;
    PERFORM gear_private_2026.evidence_changed(source_doc.id);
    IF target<>source_doc.id THEN PERFORM gear_private_2026.evidence_changed(target); END IF;
    SELECT * INTO item FROM gear_2026.attachments WHERE id=attachment_id;
    INSERT INTO gear_2026.events(scope,event_type,document_id,actor_member_id,actor_label,actor_source,before_data,after_data,reason,request_id,request_payload)
    VALUES('document','attachment_corrected',target,actor,(SELECT display_name FROM gear_2026.members WHERE id=actor),'user',before_state,to_jsonb(item),reason,request_id,payload);
    RETURN to_jsonb(item);
END;
$$;
CREATE FUNCTION gear_private_2026.archive_evidence(document_id uuid, expected_version integer, attachment_ids uuid[], checks jsonb, manual_reason text, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor uuid; doc gear_2026.documents%ROWTYPE; previous gear_2026.events%ROWTYPE; payload jsonb; selected uuid[];
    before_state jsonb; result jsonb; item gear_2026.attachments%ROWTYPE; hints jsonb; requires_manual boolean:=false;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE; actor:=gear_private_2026.inventory_actor(true);
    IF request_id IS NULL THEN RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','archive_evidence','document_id',document_id,'expected_version',expected_version,
        'attachment_ids',attachment_ids,'checks',checks,'manual_reason',manual_reason);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=archive_evidence.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF; RETURN previous.after_data; END IF;
    SELECT * INTO doc FROM gear_2026.documents WHERE id=document_id FOR UPDATE;
    IF NOT FOUND OR doc.status<>'confirmed' THEN RAISE EXCEPTION 'evidence_document_unavailable' USING ERRCODE='22023'; END IF;
    IF doc.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'document_conflict' USING ERRCODE='40001'; END IF;
    IF doc.evidence_state='archived' THEN RAISE EXCEPTION 'attachment_conflict' USING ERRCODE='40001'; END IF;
    IF checks IS DISTINCT FROM '{"signatures":true,"number":true,"content":true,"pages":true}'::jsonb
        OR length(coalesce(manual_reason,''))>1000 THEN RAISE EXCEPTION 'evidence_review_required' USING ERRCODE='22023'; END IF;
    SELECT array_agg(a.id ORDER BY a.id) INTO selected FROM gear_2026.attachments a WHERE a.document_id=archive_evidence.document_id AND a.is_active AND a.upload_state='ready';
    IF selected IS NULL OR coalesce(cardinality(attachment_ids),0) NOT BETWEEN 1 AND 10 OR selected IS DISTINCT FROM (SELECT array_agg(v ORDER BY v) FROM unnest(attachment_ids) v)
        OR EXISTS(SELECT 1 FROM gear_2026.attachments a WHERE a.document_id=archive_evidence.document_id AND a.is_active AND a.upload_state='pending') THEN
        RAISE EXCEPTION 'evidence_review_required' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT * FROM gear_2026.attachments a WHERE a.id=ANY(selected) LOOP
        hints:=coalesce(item.ocr_result,'{}'::jsonb);
        IF NOT (coalesce(hints->'document_ids','[]') ? document_id::text OR coalesce(hints->'document_numbers','[]') ? doc.document_no)
            OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(hints->'document_ids','[]')) v WHERE v<>document_id::text)
            OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(hints->'document_numbers','[]')) v WHERE v<>doc.document_no) THEN requires_manual:=true; END IF;
    END LOOP;
    IF requires_manual AND nullif(btrim(manual_reason),'') IS NULL THEN RAISE EXCEPTION 'evidence_manual_reason_required' USING ERRCODE='22023'; END IF;
    before_state:=jsonb_build_object('document',to_jsonb(doc),'attachments',(SELECT jsonb_agg(to_jsonb(a)) FROM gear_2026.attachments a WHERE id=ANY(selected)));
    UPDATE gear_2026.attachments SET review_state='accepted',reviewed_by=actor,reviewed_at=clock_timestamp() WHERE id=ANY(selected);
    UPDATE gear_2026.documents SET evidence_state='archived',archived_by=actor,archived_at=clock_timestamp() WHERE id=document_id RETURNING * INTO doc;
    result:=jsonb_build_object('document_id',doc.id,'document_version',doc.version,'evidence_state',doc.evidence_state,'attachment_ids',selected,'checks',checks,'manual_reason',manual_reason);
    INSERT INTO gear_2026.events(scope,event_type,document_id,actor_member_id,actor_label,actor_source,before_data,after_data,reason,request_id,request_payload)
    VALUES('document','attachment_reviewed',document_id,actor,(SELECT display_name FROM gear_2026.members WHERE id=actor),'user',before_state,result,nullif(btrim(manual_reason),''),request_id,payload);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_2026.list_evidence(document_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$ SELECT gear_private_2026.list_evidence(document_id); $$;
CREATE FUNCTION gear_2026.get_attachment(attachment_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$ SELECT gear_private_2026.get_attachment(attachment_id); $$;
CREATE FUNCTION gear_2026.match_evidence(hints jsonb) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$ SELECT gear_private_2026.match_evidence(hints); $$;
CREATE FUNCTION gear_2026.reserve_attachment(document_id uuid,details jsonb,expected_version integer,request_id uuid) RETURNS jsonb LANGUAGE sql SET search_path='' AS $$ SELECT gear_private_2026.reserve_attachment(document_id,details,expected_version,request_id); $$;
CREATE FUNCTION gear_2026.cancel_attachment(attachment_id uuid,expected_version integer,request_id uuid) RETURNS jsonb LANGUAGE sql SET search_path='' AS $$ SELECT gear_private_2026.cancel_attachment(attachment_id,expected_version,request_id); $$;
CREATE FUNCTION gear_2026.update_attachment(attachment_id uuid,expected_version integer,changes jsonb,request_id uuid) RETURNS jsonb LANGUAGE sql SET search_path='' AS $$ SELECT gear_private_2026.update_attachment(attachment_id,expected_version,changes,request_id); $$;
CREATE FUNCTION gear_2026.archive_evidence(document_id uuid,expected_version integer,attachment_ids uuid[],checks jsonb,manual_reason text,request_id uuid) RETURNS jsonb LANGUAGE sql SET search_path='' AS $$ SELECT gear_private_2026.archive_evidence(document_id,expected_version,attachment_ids,checks,manual_reason,request_id); $$;
DO $$
DECLARE fn record;
BEGIN
    FOR fn IN SELECT p.oid::regprocedure AS signature,n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('gear_2026','gear_private_2026') AND p.proname IN ('protect_attachment','evidence_changed','evidence_hints',
            'list_evidence','get_attachment','match_evidence','reserve_attachment','cancel_attachment','update_attachment','archive_evidence','commit_attachment') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn.signature);
        IF fn.proname='commit_attachment' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
        ELSIF fn.proname IN ('list_evidence','get_attachment','match_evidence','reserve_attachment','cancel_attachment','update_attachment','archive_evidence') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',fn.signature); END IF;
    END LOOP;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
