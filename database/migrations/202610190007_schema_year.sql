-- Permanent creation-year suffix; never roll these namespaces forward annually.
-- Historical migrations 001-006 are intentionally unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$
BEGIN
    IF to_regnamespace('gear') IS NULL OR to_regnamespace('gear_private') IS NULL THEN
        RAISE EXCEPTION 'schema_year_source_missing'; END IF;
    IF to_regnamespace('gear_2026') IS NOT NULL OR to_regnamespace('gear_private_2026') IS NOT NULL THEN
        RAISE EXCEPTION 'schema_year_target_exists'; END IF;
END;
$$;
ALTER SCHEMA gear RENAME TO gear_2026;
ALTER SCHEMA gear_private RENAME TO gear_private_2026;
DO $$
DECLARE item record; definition text; compatibility boolean:=coalesce(current_setting('gear.rename_compatibility',true),'')='on';
    wrapper text; arguments text; role_name text; volatility text;
BEGIN
    -- Parsed dependencies retain their OIDs; string-bodied functions require explicit rewriting.
    FOR item IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('gear_2026','gear_private_2026') ORDER BY p.oid LOOP
        definition:=pg_get_functiondef(item.oid);
        definition:=regexp_replace(definition,'\mgear_private\.', 'gear_private_2026.','g');
        definition:=regexp_replace(definition,'\mgear\.', 'gear_2026.','g');
        EXECUTE definition;
    END LOOP;
    -- Only the existing Gear schedule is changed; preserve its ID, timing, role and active state.
    IF to_regclass('cron.job') IS NOT NULL THEN
        FOR item IN EXECUTE 'SELECT jobid,command FROM cron.job WHERE jobname=''gear-account-notifications''' LOOP
            IF item.command='SELECT gear_private.invoke_account_notifications();' THEN
                EXECUTE 'SELECT cron.alter_job($1,command := $2)' USING item.jobid,'SELECT gear_private_2026.invoke_account_notifications();';
            ELSIF item.command<>'SELECT gear_private_2026.invoke_account_notifications();' THEN
                RAISE EXCEPTION 'unexpected_gear_schedule_command';
            END IF;
        END LOOP;
    END IF;
    -- Opt-in live rollout bridge. Fresh installs leave only the year-suffixed namespaces.
    -- Set gear.rename_compatibility=on locally inside this transaction for a rolling deployment.
    IF compatibility THEN
        CREATE SCHEMA gear;
        COMMENT ON SCHEMA gear IS 'Gear schema-year compatibility aliases; retire after rollout';
        REVOKE ALL ON SCHEMA gear FROM PUBLIC,anon,authenticated,service_role;
        GRANT USAGE ON SCHEMA gear TO authenticated,service_role;
        FOR item IN SELECT p.*,pg_get_function_arguments(p.oid) AS arguments,pg_get_function_result(p.oid) AS result
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gear_2026' ORDER BY p.oid LOOP
            IF item.prokind<>'f' OR item.proretset OR item.prorettype='trigger'::regtype OR item.proargmodes IS NOT NULL THEN
                RAISE EXCEPTION 'unsupported_schema_alias_signature'; END IF;
            SELECT coalesce(string_agg('$'||i,',' ORDER BY i),'') INTO arguments FROM generate_series(1,item.pronargs) i;
            volatility:=CASE item.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END;
            EXECUTE format('CREATE FUNCTION gear.%I(%s) RETURNS %s LANGUAGE sql %s SECURITY INVOKER SET search_path='''' AS %L',
                item.proname,item.arguments,item.result,volatility,format('SELECT gear_2026.%I(%s)',item.proname,arguments));
            wrapper:=format('gear.%I(%s)',item.proname,pg_get_function_identity_arguments(item.oid));
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',wrapper);
            FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
                IF has_function_privilege(role_name,item.oid,'EXECUTE') THEN
                    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',wrapper,role_name); END IF;
            END LOOP;
            EXECUTE format('COMMENT ON FUNCTION %s IS %L',wrapper,'Gear schema-year compatibility alias');
        END LOOP;
        CREATE SCHEMA gear_private;
        COMMENT ON SCHEMA gear_private IS 'Gear schema-year compatibility aliases; retire after rollout';
        REVOKE ALL ON SCHEMA gear_private FROM PUBLIC,anon,authenticated,service_role;
        IF to_regprocedure('gear_private_2026.invoke_account_notifications()') IS NOT NULL THEN
            EXECUTE 'CREATE FUNCTION gear_private.invoke_account_notifications() RETURNS bigint LANGUAGE sql SET search_path='''' AS ''SELECT gear_private_2026.invoke_account_notifications()''';
            REVOKE ALL ON FUNCTION gear_private.invoke_account_notifications() FROM PUBLIC,anon,authenticated,service_role;
            COMMENT ON FUNCTION gear_private.invoke_account_notifications() IS 'Gear schema-year compatibility alias';
        END IF;
    END IF;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
