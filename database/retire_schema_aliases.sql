-- Only after all runtime callers and API exposure use the configured year-suffixed schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE name text; item record;
BEGIN
    IF to_regnamespace('gear_2026') IS NULL OR to_regnamespace('gear_private_2026') IS NULL THEN
        RAISE EXCEPTION 'schema_year_target_missing'; END IF;
    FOREACH name IN ARRAY ARRAY['gear','gear_private'] LOOP
        IF to_regnamespace(name) IS NULL THEN CONTINUE; END IF;
        IF obj_description(to_regnamespace(name),'pg_namespace') IS DISTINCT FROM 'Gear schema-year compatibility aliases; retire after rollout' THEN
            RAISE EXCEPTION 'unexpected_legacy_schema'; END IF;
        FOR item IN SELECT p.oid,pg_get_function_identity_arguments(p.oid) AS arguments,p.proname
            FROM pg_proc p WHERE p.pronamespace=to_regnamespace(name) LOOP
            IF obj_description(item.oid,'pg_proc') IS DISTINCT FROM 'Gear schema-year compatibility alias' THEN
                RAISE EXCEPTION 'unexpected_legacy_function'; END IF;
            EXECUTE format('DROP FUNCTION %I.%I(%s) RESTRICT',name,item.proname,item.arguments);
        END LOOP;
        -- No CASCADE: any unexpected table, grant dependency or other object aborts everything.
        EXECUTE format('DROP SCHEMA %I RESTRICT',name);
    END LOOP;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
