-- Administrator-only reversals and append-only correction statements.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.document_record(uuid)')
        AND md5(prosrc)='8366779062e7c588ee1e1994fb40e0d5') THEN
        RAISE EXCEPTION 'document_review_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='gear_2026.events'::regclass
        AND conname='events_event_type_check' AND md5(pg_get_constraintdef(oid))='98039ee0e04e2713cbea29a14f9b6228') THEN
        RAISE EXCEPTION 'document_review_source_mismatch'; END IF;
END;
$$;
ALTER TABLE gear_2026.events DROP CONSTRAINT events_event_type_check;
ALTER TABLE gear_2026.events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
    'asset_initialized','asset_updated','asset_fault_reported','asset_repaired','asset_lost','asset_scrapped',
    'asset_found','asset_invalidated','assignment_extended','document_confirmed','document_voided','document_corrected',
    'draft_created','draft_updated','draft_deleted','party_created','party_updated','member_applied',
    'member_reviewed','member_role_changed','settings_updated','attachment_uploaded','attachment_reviewed',
    'attachment_corrected','attachment_reserved','attachment_cancelled'));

CREATE OR REPLACE FUNCTION gear_private_2026.document_record(identity_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' SET timezone = 'UTC' AS $$
    SELECT to_jsonb(d) || jsonb_build_object(
        'items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.line_no)
            FROM gear_2026.document_items i WHERE i.document_id = d.id),'[]'::jsonb),
        'changes',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'id',e.id::text,'event_type',e.event_type,'recorded_at',e.recorded_at,
            'actor_label',e.actor_label,'reason',e.reason,'correction_text',e.after_data->>'correction_text',
            'replacement_document_id',e.after_data->>'replacement_document_id',
            'replacement_document_no',e.after_data->>'replacement_document_no') ORDER BY e.id)
            FROM gear_2026.events e WHERE e.document_id=d.id AND e.scope='document'
                AND e.event_type IN ('document_voided','document_corrected')),'[]'::jsonb))
        FROM gear_2026.documents d WHERE d.id = identity_id;
$$;

CREATE FUNCTION gear_private_2026.document_review_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE actor uuid:=gear_private_2026.inventory_actor(true);
BEGIN
    IF gear_private_2026.current_role()<>'admin' THEN
        RAISE EXCEPTION 'document_admin_required' USING ERRCODE='42501'; END IF;
    RETURN actor;
END;
$$;

CREATE FUNCTION gear_private_2026.correct_document(document_id uuid, expected_version integer,
    reason text, correction_text text, replacement_document_id uuid, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; doc gear_2026.documents%ROWTYPE;
    replacement gear_2026.documents%ROWTYPE; payload jsonb; result jsonb; original jsonb;
    explanation text:=btrim(reason); statement text:=btrim(correction_text);
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.document_review_actor();
    IF request_id IS NULL OR document_id IS NULL OR expected_version IS NULL OR expected_version<1
        OR explanation IS NULL OR length(explanation) NOT BETWEEN 1 AND 2000
        OR statement IS NULL OR length(statement) NOT BETWEEN 1 AND 4000 THEN
        RAISE EXCEPTION 'invalid_document_correction' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','correct_document','document_id',document_id,
        'expected_version',expected_version,'reason',explanation,'correction_text',statement,
        'replacement_document_id',replacement_document_id);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=correct_document.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    SELECT * INTO doc FROM gear_2026.documents d WHERE d.id=correct_document.document_id FOR UPDATE;
    IF NOT FOUND OR doc.version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'document_conflict' USING ERRCODE='40001'; END IF;
    IF doc.status<>'confirmed' THEN RAISE EXCEPTION 'document_not_confirmed' USING ERRCODE='22023'; END IF;
    IF replacement_document_id IS NOT NULL THEN
        SELECT * INTO replacement FROM gear_2026.documents d WHERE d.id=replacement_document_id FOR UPDATE;
        IF NOT FOUND OR replacement.id=doc.id OR replacement.status<>'confirmed' OR replacement.kind<>doc.kind
            OR (replacement.numbering_on,replacement.number_value)<=(doc.numbering_on,doc.number_value) THEN
            RAISE EXCEPTION 'invalid_replacement_document' USING ERRCODE='22023'; END IF;
    END IF;
    original:=gear_private_2026.document_record(doc.id)-'changes';
    UPDATE gear_2026.documents SET updated_at=now() WHERE id=doc.id RETURNING version INTO doc.version;
    result:=jsonb_build_object('id',doc.id,'status',doc.status,'version',doc.version,
        'correction_text',statement,'replacement_document_id',replacement.id,'replacement_document_no',replacement.document_no);
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id=actor;
    INSERT INTO gear_2026.events(scope,event_type,document_id,occurred_on,actor_member_id,actor_label,
        actor_source,before_data,after_data,reason,request_id,request_payload)
        VALUES('document','document_corrected',doc.id,(now() AT TIME ZONE 'Asia/Shanghai')::date,
            actor,actor_name,'user',original,result,explanation,request_id,payload);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_private_2026.void_document(document_id uuid, expected_version integer,
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
            RAISE EXCEPTION 'document_has_dependencies' USING ERRCODE='22023',DETAIL=jsonb_build_object('asset_code',asset.asset_code)::text; END IF;
        before_state:=gear_private_2026.asset_record(asset.id);
        FOREACH key IN ARRAY state_keys LOOP
            IF before_state->key IS DISTINCT FROM item.state_after->key THEN
                RAISE EXCEPTION 'document_state_conflict' USING ERRCODE='40001',DETAIL=jsonb_build_object('asset_code',asset.asset_code)::text; END IF;
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

CREATE FUNCTION gear_2026.correct_document(document_id uuid, expected_version integer, reason text,
    correction_text text, replacement_document_id uuid, request_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT gear_private_2026.correct_document(document_id,expected_version,reason,correction_text,replacement_document_id,request_id);
$$;
CREATE FUNCTION gear_2026.void_document(document_id uuid, expected_version integer, reason text, request_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT gear_private_2026.void_document(document_id,expected_version,reason,request_id);
$$;
REVOKE ALL ON FUNCTION gear_private_2026.document_review_actor() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION gear_private_2026.correct_document(uuid,integer,text,text,uuid,uuid),
    gear_private_2026.void_document(uuid,integer,text,uuid),gear_2026.correct_document(uuid,integer,text,text,uuid,uuid),
    gear_2026.void_document(uuid,integer,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.correct_document(uuid,integer,text,text,uuid,uuid),
    gear_private_2026.void_document(uuid,integer,text,uuid),gear_2026.correct_document(uuid,integer,text,text,uuid,uuid),
    gear_2026.void_document(uuid,integer,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
