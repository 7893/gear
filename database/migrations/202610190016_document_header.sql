-- Administrator-only document heading, isolated from mail and reminder settings.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION gear_private_2026.get_app_settings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    IF gear_private_2026.current_role()<>'admin' THEN RAISE EXCEPTION 'admin_required' USING ERRCODE='42501'; END IF;
    RETURN (SELECT jsonb_build_object('document_header',s.document_header,'version',s.version,
        'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'recorded_at',e.recorded_at,
            'actor_label',e.actor_label,'reason',e.reason,'before_header',e.before_data->>'document_header',
            'after_header',e.after_data->>'document_header') ORDER BY e.id DESC)
            FROM gear_2026.events e WHERE e.scope='settings' AND e.event_type='settings_updated'
                AND e.request_payload->>'action'='update_document_header'),'[]'::jsonb)) FROM gear_2026.app_settings s WHERE s.id=1);
END;
$$;

CREATE FUNCTION gear_private_2026.update_document_header(expected_version integer, document_header text,
    reason text, request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE actor uuid; actor_name text; previous gear_2026.events%ROWTYPE; settings gear_2026.app_settings%ROWTYPE;
    title text:=btrim(document_header); explanation text:=btrim(reason); payload jsonb; result jsonb;
BEGIN
    SELECT * INTO settings FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF gear_private_2026.current_role()<>'admin' THEN RAISE EXCEPTION 'admin_required' USING ERRCODE='42501'; END IF;
    IF request_id IS NULL OR expected_version IS NULL OR expected_version<1 OR title IS NULL OR length(title) NOT BETWEEN 1 AND 120
        OR title ~ '[[:cntrl:]]' OR explanation IS NULL OR length(explanation) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'invalid_document_header' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','update_document_header','expected_version',expected_version,'document_header',title,'reason',explanation);
    SELECT * INTO previous FROM gear_2026.events e WHERE e.request_id=update_document_header.request_id;
    IF FOUND THEN
        IF previous.actor_member_id IS DISTINCT FROM actor OR previous.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN previous.after_data;
    END IF;
    IF settings.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'settings_conflict' USING ERRCODE='40001'; END IF;
    IF settings.document_header=title THEN RAISE EXCEPTION 'settings_unchanged' USING ERRCODE='22023'; END IF;
    UPDATE gear_2026.app_settings SET document_header=title WHERE id=1;
    SELECT jsonb_build_object('document_header',s.document_header,'version',s.version) INTO result FROM gear_2026.app_settings s WHERE s.id=1;
    SELECT display_name INTO actor_name FROM gear_2026.members WHERE id=actor;
    INSERT INTO gear_2026.events(scope,event_type,actor_member_id,actor_label,actor_source,before_data,after_data,reason,request_id,request_payload)
        VALUES('settings','settings_updated',actor,actor_name,'user',jsonb_build_object('document_header',settings.document_header,'version',settings.version),
            result,explanation,request_id,payload);
    RETURN result;
END;
$$;

CREATE FUNCTION gear_2026.get_app_settings() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
    AS $$ SELECT gear_private_2026.get_app_settings(); $$;
CREATE FUNCTION gear_2026.update_document_header(expected_version integer, document_header text, reason text, request_id uuid)
    RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = ''
    AS $$ SELECT gear_private_2026.update_document_header(expected_version,document_header,reason,request_id); $$;
REVOKE ALL ON FUNCTION gear_private_2026.get_app_settings(),gear_2026.get_app_settings(),
    gear_private_2026.update_document_header(integer,text,text,uuid),gear_2026.update_document_header(integer,text,text,uuid)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private_2026.get_app_settings(),gear_2026.get_app_settings(),
    gear_private_2026.update_document_header(integer,text,text,uuid),gear_2026.update_document_header(integer,text,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
