-- Lightweight recipient maintenance; assignments and frozen documents stay intact.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.create_party(jsonb,uuid)')
        AND md5(prosrc)='f97f02cb4debdd4c49de322d2034363b') THEN
        RAISE EXCEPTION 'party_maintenance_source_mismatch'; END IF;
END;
$$;

CREATE FUNCTION gear_private_2026.party_fields(details jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE kind text; name text; person uuid;
BEGIN
    IF jsonb_typeof(details) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(details)
        WHERE key NOT IN ('kind','name','person_type','organization_name','default_responsible_id','contact','note')
        OR jsonb_typeof(value) NOT IN ('string','null')) THEN
        RAISE EXCEPTION 'invalid_party' USING ERRCODE='22023'; END IF;
    kind:=details->>'kind'; name:=btrim(details->>'name');
    IF kind IS NULL OR kind NOT IN ('person','team') OR name IS NULL OR length(name) NOT BETWEEN 1 AND 80
        OR length(coalesce(details->>'organization_name',''))>120 OR length(coalesce(details->>'contact',''))>200
        OR length(coalesce(details->>'note',''))>2000 THEN
        RAISE EXCEPTION 'invalid_party' USING ERRCODE='22023'; END IF;
    BEGIN person:=nullif(details->>'default_responsible_id','')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid_party' USING ERRCODE='22023'; END;
    IF (kind='person' AND (person IS NOT NULL OR coalesce(details->>'person_type','staff') NOT IN ('staff','seconded','attached','temporary','other')))
        OR (kind='team' AND (person IS NULL OR nullif(details->>'person_type','') IS NOT NULL)) THEN
        RAISE EXCEPTION 'invalid_party' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('kind',kind,'name',name,
        'person_type',CASE WHEN kind='person' THEN coalesce(details->>'person_type','staff') END,
        'organization_name',nullif(btrim(details->>'organization_name'),''),'default_responsible_id',person,
        'contact',nullif(btrim(details->>'contact'),''),'note',nullif(btrim(details->>'note'),''));
END;
$$;

CREATE OR REPLACE FUNCTION gear_private_2026.create_party(details jsonb, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; fields jsonb; payload jsonb; result jsonb; identity_id uuid;
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF request_id IS NULL THEN RAISE EXCEPTION 'invalid_party' USING ERRCODE='22023'; END IF;
    fields:=gear_private_2026.party_fields(details);
    -- Preserve the payload of pre-migration requests when contact was not supplied.
    payload:=jsonb_build_object('action','create_party') || (fields-'contact');
    IF fields->>'contact' IS NOT NULL THEN payload:=payload || jsonb_build_object('contact',fields->>'contact'); END IF;
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=create_party.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    IF fields->>'kind'='team' AND NOT EXISTS(SELECT 1 FROM gear_2026.parties
        WHERE id=(fields->>'default_responsible_id')::uuid AND kind='person' AND is_active) THEN
        RAISE EXCEPTION 'responsible_person_required' USING ERRCODE='22023'; END IF;
    INSERT INTO gear_2026.parties(kind,name,person_type,organization_name,default_responsible_id,contact,note,created_by)
        VALUES(fields->>'kind',fields->>'name',fields->>'person_type',fields->>'organization_name',
            (fields->>'default_responsible_id')::uuid,fields->>'contact',fields->>'note',actor) RETURNING id INTO identity_id;
    SELECT to_jsonb(p) INTO result FROM gear_2026.parties p WHERE p.id=identity_id;
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id=actor;
    INSERT INTO gear_2026.events(scope,event_type,target_party_id,actor_member_id,actor_label,actor_source,after_data,request_id,request_payload)
        VALUES('party','party_created',identity_id,actor,actor_name,'user',result,request_id,payload);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_private_2026.list_party_records() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    RETURN (SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object(
        'current_asset_count',(SELECT count(*) FROM gear_2026.assignments a WHERE a.closed_at IS NULL
            AND (a.holder_party_id=p.id OR a.responsible_person_id=p.id)),
        'default_team_count',(SELECT count(*) FROM gear_2026.parties t WHERE t.is_active AND t.default_responsible_id=p.id))
        ORDER BY p.kind,p.name,p.id),'[]'::jsonb) FROM gear_2026.parties p WHERE p.kind IN ('person','team'));
END;
$$;

CREATE FUNCTION gear_private_2026.get_party(party_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    SELECT jsonb_build_object('party',to_jsonb(p),'history',coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',e.id::text,'event_type',e.event_type,'recorded_at',e.recorded_at,'actor_label',e.actor_label,
        'reason',e.reason,'before_data',e.before_data,'after_data',e.after_data) ORDER BY e.id DESC)
        FROM gear_2026.events e WHERE e.target_party_id=p.id AND e.scope='party'),'[]'::jsonb)) INTO result
        FROM gear_2026.parties p WHERE p.id=party_id AND p.kind IN ('person','team');
    IF result IS NULL THEN RAISE EXCEPTION 'party_not_found' USING ERRCODE='22023'; END IF;
    RETURN result;
END;
$$;

CREATE FUNCTION gear_private_2026.update_party(party_id uuid, expected_version integer, details jsonb,
    active boolean, reason text, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; party gear_2026.parties%ROWTYPE;
    fields jsonb; payload jsonb; result jsonb; explanation text:=btrim(reason);
BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF party_id IS NULL OR expected_version IS NULL OR expected_version<1 OR active IS NULL OR request_id IS NULL
        OR explanation IS NULL OR length(explanation) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'invalid_party' USING ERRCODE='22023'; END IF;
    IF NOT (details ?& ARRAY['kind','name','person_type','organization_name','default_responsible_id','contact','note']) THEN
        RAISE EXCEPTION 'invalid_party' USING ERRCODE='22023'; END IF;
    fields:=gear_private_2026.party_fields(details);
    payload:=jsonb_build_object('action','update_party','party_id',party_id,'expected_version',expected_version,
        'details',fields,'active',active,'reason',explanation);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=update_party.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data-'default_responsible_name';
    END IF;
    SELECT * INTO party FROM gear_2026.parties p WHERE p.id=update_party.party_id FOR UPDATE;
    IF NOT FOUND OR party.kind NOT IN ('person','team') OR party.version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION 'party_conflict' USING ERRCODE='40001'; END IF;
    IF party.kind IS DISTINCT FROM fields->>'kind' THEN RAISE EXCEPTION 'party_kind_permanent' USING ERRCODE='22023'; END IF;
    IF to_jsonb(party) @> (fields || jsonb_build_object('is_active',active)) THEN
        RAISE EXCEPTION 'party_unchanged' USING ERRCODE='22023'; END IF;
    IF party.kind='team' AND NOT EXISTS(SELECT 1 FROM gear_2026.parties p
        WHERE p.id=(fields->>'default_responsible_id')::uuid AND p.kind='person' AND (p.is_active OR NOT active)) THEN
        RAISE EXCEPTION 'responsible_person_required' USING ERRCODE='22023'; END IF;
    IF NOT active AND EXISTS(SELECT 1 FROM gear_2026.parties t WHERE t.is_active AND t.default_responsible_id=party.id) THEN
        RAISE EXCEPTION 'party_default_in_use' USING ERRCODE='22023'; END IF;
    UPDATE gear_2026.parties SET name=fields->>'name',person_type=fields->>'person_type',
        organization_name=fields->>'organization_name',contact=fields->>'contact',note=fields->>'note',
        default_responsible_id=(fields->>'default_responsible_id')::uuid,is_active=active WHERE id=party.id;
    SELECT to_jsonb(p) INTO result FROM gear_2026.parties p WHERE p.id=party.id;
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id=actor;
    INSERT INTO gear_2026.events(scope,event_type,target_party_id,actor_member_id,actor_label,actor_source,
        before_data,after_data,reason,request_id,request_payload)
        VALUES('party','party_updated',party.id,actor,actor_name,'user',
            to_jsonb(party) || jsonb_build_object('default_responsible_name',
                (SELECT p.name FROM gear_2026.parties p WHERE p.id=party.default_responsible_id)),
            result || jsonb_build_object('default_responsible_name',
                (SELECT p.name FROM gear_2026.parties p WHERE p.id=(fields->>'default_responsible_id')::uuid)),
            explanation,request_id,payload);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_2026.list_party_records() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
    AS $$ SELECT gear_private_2026.list_party_records(); $$;
CREATE FUNCTION gear_2026.get_party(party_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
    AS $$ SELECT gear_private_2026.get_party(party_id); $$;
CREATE FUNCTION gear_2026.update_party(party_id uuid, expected_version integer, details jsonb, active boolean, reason text, request_id uuid)
    RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = ''
    AS $$ SELECT gear_private_2026.update_party(party_id,expected_version,details,active,reason,request_id); $$;
REVOKE ALL ON FUNCTION gear_private_2026.party_fields(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION gear_private_2026.list_party_records(),gear_private_2026.get_party(uuid),
    gear_private_2026.update_party(uuid,integer,jsonb,boolean,text,uuid),gear_2026.list_party_records(),
    gear_2026.get_party(uuid),gear_2026.update_party(uuid,integer,jsonb,boolean,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.list_party_records(),gear_private_2026.get_party(uuid),
    gear_private_2026.update_party(uuid,integer,jsonb,boolean,text,uuid),gear_2026.list_party_records(),
    gear_2026.get_party(uuid),gear_2026.update_party(uuid,integer,jsonb,boolean,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
