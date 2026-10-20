-- Historical/event originals reuse the private original-file pipeline.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.get_attachment(uuid)') AND md5(prosrc)='6706c75cf87ccf1bf4e3921169a92d9f') THEN RAISE EXCEPTION 'completion_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_2026.commit_attachment(uuid,uuid,jsonb)') AND md5(prosrc)='a364e41c9b7f86335141b81504afd453') THEN RAISE EXCEPTION 'completion_source_mismatch'; END IF;
END; $$;

CREATE FUNCTION gear_private_2026.event_evidence_target(event_id bigint) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE target gear_2026.events%ROWTYPE;
BEGIN
    SELECT * INTO target FROM gear_2026.events WHERE id=event_id;
    IF NOT FOUND OR target.scope<>'asset' OR target.event_type NOT IN
        ('asset_initialized','asset_fault_reported','asset_repaired','asset_lost','asset_scrapped','asset_found','asset_invalidated','asset_lifecycle_corrected') THEN
        RAISE EXCEPTION 'evidence_event_unavailable' USING ERRCODE='22023'; END IF;
    RETURN target.asset_id;
END;
$$;
CREATE OR REPLACE FUNCTION gear_private_2026.get_attachment(attachment_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor uuid:=gear_private_2026.inventory_actor(); result gear_2026.attachments%ROWTYPE;
BEGIN
    SELECT * INTO result FROM gear_2026.attachments WHERE id=attachment_id;
    IF NOT FOUND OR (result.upload_state<>'ready' AND NOT (gear_private_2026.current_role()='admin' OR (gear_private_2026.current_role()='operator' AND result.uploaded_by=actor))) THEN
        RAISE EXCEPTION 'attachment_not_found' USING ERRCODE='42501'; END IF;
    IF result.document_id IS NOT NULL THEN PERFORM gear_private_2026.get_document(result.document_id);
    ELSE PERFORM gear_private_2026.event_evidence_target(result.event_id); END IF;
    RETURN to_jsonb(result);
END;
$$;
CREATE FUNCTION gear_private_2026.reserve_event_attachment(event_id bigint, details jsonb, expected_version integer, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor uuid; previous gear_2026.events%ROWTYPE; target gear_2026.events%ROWTYPE; asset_version integer; result gear_2026.attachments%ROWTYPE;
    payload jsonb; amount bigint; identity_id uuid:=gen_random_uuid(); source text; reference text; reason text;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF request_id IS NULL THEN RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','reserve_event_attachment','event_id',event_id,'details',details,'expected_version',expected_version);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=reserve_event_attachment.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO target FROM gear_2026.events WHERE id=event_id;
    PERFORM gear_private_2026.event_evidence_target(event_id);
    SELECT version INTO asset_version FROM gear_2026.assets WHERE id=target.asset_id FOR UPDATE;
    IF expected_version IS DISTINCT FROM asset_version THEN RAISE EXCEPTION 'asset_lifecycle_conflict' USING ERRCODE='40001'; END IF;
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
        OR (source='external' AND reference IS NULL) OR length(reason)>1000 THEN
        RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM gear_2026.attachments a WHERE a.event_id=reserve_event_attachment.event_id AND a.is_active
        AND a.upload_state IN ('ready','pending') AND a.upload_manifest->>'sha256'=details->>'sha256') THEN
        RAISE EXCEPTION 'duplicate_attachment' USING ERRCODE='22023'; END IF;
    IF (SELECT count(*) FROM gear_2026.attachments WHERE attachments.event_id=reserve_event_attachment.event_id
        AND is_active AND upload_state IN ('ready','pending'))>=10 OR
        (SELECT coalesce(sum(coalesce(size_bytes,reserved_size_bytes)),0) FROM gear_2026.attachments
        WHERE attachments.event_id=reserve_event_attachment.event_id AND is_active AND upload_state IN ('ready','pending'))+amount>104857600 THEN
        RAISE EXCEPTION 'evidence_limit_exceeded' USING ERRCODE='22023'; END IF;
    INSERT INTO gear_2026.attachments(id,event_id,storage_key,original_name,uploaded_by,reserved_size_bytes,upload_manifest,source_kind,external_reference,correction_reason)
    VALUES(identity_id,event_id,identity_id::text||'/'||gen_random_uuid()::text,btrim(details->>'original_name'),actor,amount,details,source,reference,reason)
    RETURNING * INTO result;
    INSERT INTO gear_2026.events(scope,event_type,asset_id,actor_member_id,actor_label,actor_source,after_data,reason,request_id,request_payload)
    VALUES('draft','attachment_reserved',NULL,actor,(SELECT display_name FROM gear_2026.members WHERE id=actor),'user',to_jsonb(result),reason,request_id,payload);
    RETURN to_jsonb(result);
END;
$$;
CREATE OR REPLACE FUNCTION gear_2026.commit_attachment(attachment_id uuid, actor_auth_id uuid, verified jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone='UTC' AS $$
DECLARE actor gear_2026.members%ROWTYPE; item gear_2026.attachments%ROWTYPE; doc gear_2026.documents%ROWTYPE;
    target gear_2026.events%ROWTYPE; previous gear_2026.events%ROWTYPE; payload jsonb; hints jsonb; before_state jsonb;
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
    IF item.event_id IS NOT NULL THEN
        SELECT * INTO target FROM gear_2026.events WHERE id=item.event_id;
        PERFORM gear_private_2026.event_evidence_target(item.event_id);
        IF item.upload_state<>'pending' OR NOT item.is_active THEN
            RAISE EXCEPTION 'evidence_document_unavailable' USING ERRCODE='22023'; END IF;
    ELSE
    SELECT * INTO doc FROM gear_2026.documents WHERE id=item.document_id FOR UPDATE;
    IF doc.status<>'confirmed' OR item.upload_state<>'pending' OR NOT item.is_active THEN
        RAISE EXCEPTION 'evidence_document_unavailable' USING ERRCODE='22023'; END IF;
    IF doc.evidence_state='archived' AND (actor.role<>'admin' OR item.correction_reason IS NULL) THEN
        RAISE EXCEPTION 'archived_evidence_admin_required' USING ERRCODE='42501'; END IF;
    END IF;
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
    IF item.document_id IS NOT NULL THEN PERFORM gear_private_2026.evidence_changed(doc.id); END IF;
    SELECT * INTO item FROM gear_2026.attachments WHERE id=attachment_id;
    INSERT INTO gear_2026.events(scope,event_type,document_id,asset_id,actor_member_id,actor_label,actor_source,before_data,after_data,reason,request_id,request_payload)
    VALUES(CASE WHEN item.event_id IS NULL THEN 'document' ELSE 'asset' END,'attachment_uploaded',doc.id,target.asset_id,
        actor.id,actor.display_name,'user',before_state,to_jsonb(item),item.correction_reason,attachment_id,payload);
    -- Drain Gear deferred checks while inside the narrowly scoped definer, without table grants to service_role.
    SET CONSTRAINTS gear_2026.check_relations IMMEDIATE;
    SET CONSTRAINTS gear_2026.check_relations DEFERRED;
    RETURN to_jsonb(item);
END;
$$;

CREATE FUNCTION gear_private_2026.list_event_evidence(event_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE actor uuid:=gear_private_2026.inventory_actor(); target uuid;
BEGIN
    target:=gear_private_2026.event_evidence_target(event_id);
    RETURN jsonb_build_object('asset_version',(SELECT version FROM gear_2026.assets WHERE id=target),
        'items',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at,a.id) FROM gear_2026.attachments a
            WHERE a.event_id=list_event_evidence.event_id AND (a.upload_state='ready' OR gear_private_2026.current_role()='admin'
            OR (gear_private_2026.current_role()='operator' AND a.uploaded_by=actor))),'[]'::jsonb));
END;
$$;
CREATE FUNCTION gear_private_2026.review_event_attachment(attachment_id uuid,expected_version integer,
    accepted boolean,reason text,request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE actor uuid; item gear_2026.attachments%ROWTYPE; prior gear_2026.events%ROWTYPE;
    payload jsonb; before_state jsonb; target uuid;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF request_id IS NULL OR accepted IS NULL OR length(btrim(coalesce(reason,''))) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','review_event_attachment','attachment_id',attachment_id,
        'expected_version',expected_version,'accepted',accepted,'reason',btrim(reason));
    SELECT * INTO prior FROM gear_2026.events e WHERE e.request_id=review_event_attachment.request_id;
    IF FOUND THEN
        IF prior.actor_member_id IS DISTINCT FROM actor OR prior.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN prior.after_data;
    END IF;
    SELECT * INTO item FROM gear_2026.attachments WHERE id=attachment_id FOR UPDATE;
    IF NOT FOUND OR item.event_id IS NULL OR item.upload_state<>'ready' OR NOT item.is_active THEN
        RAISE EXCEPTION 'attachment_not_found' USING ERRCODE='22023'; END IF;
    target:=gear_private_2026.event_evidence_target(item.event_id);
    IF item.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'attachment_conflict' USING ERRCODE='40001'; END IF;
    IF item.review_state<>'pending' AND gear_private_2026.current_role()<>'admin' THEN
        RAISE EXCEPTION 'archived_evidence_admin_required' USING ERRCODE='42501'; END IF;
    before_state:=to_jsonb(item);
    UPDATE gear_2026.attachments SET review_state=CASE WHEN accepted THEN 'accepted' ELSE 'rejected' END,
        reviewed_by=actor,reviewed_at=now(),correction_reason=btrim(reason) WHERE id=item.id RETURNING * INTO item;
    INSERT INTO gear_2026.events(scope,event_type,asset_id,actor_member_id,actor_label,actor_source,
        before_data,after_data,reason,request_id,request_payload)
        VALUES('asset','attachment_reviewed',target,actor,(SELECT display_name FROM gear_2026.members WHERE id=actor),
            'user',before_state,to_jsonb(item),btrim(reason),request_id,payload);
    RETURN to_jsonb(item);
END;
$$;
CREATE FUNCTION gear_private_2026.list_originals() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'document_id',a.document_id,
        'event_id',a.event_id::text,'original_name',a.original_name,'media_type',a.media_type,'size_bytes',a.size_bytes,
        'sha256',a.sha256,'is_active',a.is_active,'review_state',a.review_state) ORDER BY a.id)
        FROM gear_2026.attachments a LEFT JOIN gear_2026.documents d ON d.id=a.document_id
        WHERE a.upload_state='ready' AND (a.event_id IS NOT NULL OR d.status<>'draft')),'[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION gear_private_2026.event_evidence_target(bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION gear_2026.reserve_event_attachment(event_id bigint, details jsonb, expected_version integer, request_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT gear_private_2026.reserve_event_attachment(event_id,details,expected_version,request_id); $$;
REVOKE ALL ON FUNCTION gear_2026.reserve_event_attachment(bigint,jsonb,integer,uuid),gear_private_2026.reserve_event_attachment(bigint,jsonb,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_2026.reserve_event_attachment(bigint,jsonb,integer,uuid),gear_private_2026.reserve_event_attachment(bigint,jsonb,integer,uuid) TO authenticated;
CREATE FUNCTION gear_2026.list_event_evidence(event_id bigint) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT gear_private_2026.list_event_evidence(event_id); $$;
REVOKE ALL ON FUNCTION gear_2026.list_event_evidence(bigint),gear_private_2026.list_event_evidence(bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_2026.list_event_evidence(bigint),gear_private_2026.list_event_evidence(bigint) TO authenticated;
CREATE FUNCTION gear_2026.review_event_attachment(attachment_id uuid, expected_version integer, accepted boolean, reason text, request_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT gear_private_2026.review_event_attachment(attachment_id,expected_version,accepted,reason,request_id); $$;
REVOKE ALL ON FUNCTION gear_2026.review_event_attachment(uuid,integer,boolean,text,uuid),gear_private_2026.review_event_attachment(uuid,integer,boolean,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_2026.review_event_attachment(uuid,integer,boolean,text,uuid),gear_private_2026.review_event_attachment(uuid,integer,boolean,text,uuid) TO authenticated;
CREATE FUNCTION gear_2026.list_originals() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT gear_private_2026.list_originals(); $$;
REVOKE ALL ON FUNCTION gear_2026.list_originals(),gear_private_2026.list_originals() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_2026.list_originals(),gear_private_2026.list_originals() TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
