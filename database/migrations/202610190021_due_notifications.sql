-- Reuse the account notification lease, quota, scheduler and Gmail channel.
-- Merely installing this migration never enables daily email.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.account_notification_message(gear_2026.notification_outbox)') AND md5(prosrc)='46250a2ff91cf0cb65b23ffc2ea2bb47') THEN RAISE EXCEPTION 'completion_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_2026.claim_account_notification()') AND md5(prosrc)='566e36225e47e90a1090318d1c22ce3a') THEN RAISE EXCEPTION 'completion_source_mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('gear_private_2026.notification_status()') AND md5(prosrc)='49a50253baab3664769c3365e938a13b') THEN RAISE EXCEPTION 'completion_source_mismatch'; END IF;
END; $$;

ALTER TABLE gear_2026.app_settings ADD COLUMN due_mail_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE gear_2026.app_settings ADD COLUMN due_mail_enabled_at timestamptz;
CREATE FUNCTION gear_private_2026.due_notification_counts(member_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path='' SET timezone='UTC' AS $$
    WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS d), eligible AS (
        SELECT x.due_on FROM gear_2026.assignments x JOIN gear_2026.assets a ON a.id=x.asset_id
        CROSS JOIN today CROSS JOIN gear_2026.app_settings s
        WHERE s.id=1 AND x.closed_at IS NULL AND x.usage_kind='temporary' AND a.management_status='managed'
            AND a.invalidated_at IS NULL AND x.due_on<=today.d+s.reminder_lead_days
            AND EXISTS(SELECT 1 FROM gear_2026.members m JOIN auth.users u ON u.id=m.auth_user_id
                WHERE m.id=member_id AND m.status='active' AND m.role IN ('admin','operator','viewer')
                AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL)
            AND ((x.followup_member_id=member_id AND EXISTS(SELECT 1 FROM gear_2026.members m JOIN auth.users u ON u.id=m.auth_user_id
                WHERE m.id=x.followup_member_id AND m.status='active' AND m.role IN ('admin','operator','viewer')
                    AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL))
                OR (NOT EXISTS(SELECT 1 FROM gear_2026.members m JOIN auth.users u ON u.id=m.auth_user_id
                    WHERE m.id=x.followup_member_id AND m.status='active' AND m.role IN ('admin','operator','viewer')
                        AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL)
                    AND EXISTS(SELECT 1 FROM gear_2026.members m WHERE m.id=member_id AND m.role='admin'))))
    SELECT jsonb_build_object('kind','daily_due','businessDate',(SELECT d::text FROM today),
        'overdue',count(*) FILTER(WHERE due_on<(SELECT d FROM today)),
        'dueToday',count(*) FILTER(WHERE due_on=(SELECT d FROM today)),
        'dueSoon',count(*) FILTER(WHERE due_on>(SELECT d FROM today))) FROM eligible;
$$;
CREATE FUNCTION gear_private_2026.daily_due_message(job gear_2026.notification_outbox) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' SET timezone='UTC' AS $$
DECLARE content jsonb; recipient_email text; settings gear_2026.app_settings%ROWTYPE;
BEGIN
    SELECT * INTO settings FROM gear_2026.app_settings WHERE id=1;
    IF NOT settings.due_mail_enabled OR settings.due_mail_enabled_at IS NULL
        OR job.created_at<settings.due_mail_enabled_at OR job.business_on IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Shanghai')::date
        OR (now() AT TIME ZONE 'Asia/Shanghai')::time<settings.reminder_local_time THEN RETURN NULL; END IF;
    content:=gear_private_2026.due_notification_counts(job.recipient_member_id);
    IF (content->>'overdue')::integer+(content->>'dueToday')::integer+(content->>'dueSoon')::integer=0 THEN RETURN NULL; END IF;
    SELECT u.email INTO recipient_email FROM gear_2026.members m JOIN auth.users u ON u.id=m.auth_user_id
        WHERE m.id=job.recipient_member_id AND m.status='active' AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL;
    IF recipient_email IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('to',recipient_email,'notification',content);
END;
$$;
CREATE FUNCTION gear_private_2026.enqueue_due_notifications() RETURNS integer
LANGUAGE plpgsql SET search_path='' SET timezone='UTC' AS $$
DECLARE settings gear_2026.app_settings%ROWTYPE; recipient record; content jsonb; inserted integer:=0; affected integer;
    business_date date:=(now() AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
    SELECT * INTO settings FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT settings.outbound_mail_enabled OR settings.notifications_enabled_at IS NULL OR NOT settings.due_mail_enabled
        OR settings.due_mail_enabled_at IS NULL OR (now() AT TIME ZONE 'Asia/Shanghai')::time<settings.reminder_local_time THEN RETURN 0; END IF;
    FOR recipient IN SELECT id FROM gear_2026.members WHERE status='active' AND role IN ('admin','operator','viewer') LOOP
        content:=gear_private_2026.due_notification_counts(recipient.id);
        IF (content->>'overdue')::integer+(content->>'dueToday')::integer+(content->>'dueSoon')::integer>0 THEN
            INSERT INTO gear_2026.notification_outbox(dedup_key,notification_type,recipient_member_id,business_on,payload)
                VALUES('daily_due:'||business_date::text||':'||recipient.id::text,'daily_due',recipient.id,business_date,'{}'::jsonb)
                ON CONFLICT(dedup_key) DO NOTHING;
            GET DIAGNOSTICS affected=ROW_COUNT; inserted:=inserted+affected;
        END IF;
    END LOOP;
    RETURN inserted;
END;
$$;
CREATE FUNCTION gear_private_2026.get_due_settings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM gear_private_2026.inventory_actor();
    IF gear_private_2026.current_role()<>'admin' THEN RAISE EXCEPTION 'admin_required' USING ERRCODE='42501'; END IF;
    RETURN (SELECT jsonb_build_object('version',version,'enabled',due_mail_enabled,'lead_days',reminder_lead_days,
        'local_time',to_char(reminder_local_time,'HH24:MI'),'mail_enabled',outbound_mail_enabled AND notifications_enabled_at IS NOT NULL)
        FROM gear_2026.app_settings WHERE id=1);
END;
$$;
CREATE FUNCTION gear_private_2026.update_due_settings(expected_version integer,enabled boolean,lead_days integer,
    local_time text,reason text,request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE actor uuid; settings gear_2026.app_settings%ROWTYPE; prior gear_2026.events%ROWTYPE;
    payload jsonb; before_state jsonb; result jsonb;
BEGIN
    SELECT * INTO settings FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    actor:=gear_private_2026.inventory_actor(true);
    IF gear_private_2026.current_role()<>'admin' THEN RAISE EXCEPTION 'admin_required' USING ERRCODE='42501'; END IF;
    IF request_id IS NULL OR enabled IS NULL OR lead_days IS NULL OR lead_days NOT BETWEEN 0 AND 30
        OR local_time IS NULL OR local_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
        OR length(btrim(coalesce(reason,''))) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'invalid_due_settings' USING ERRCODE='22023'; END IF;
    payload:=jsonb_build_object('action','update_due_settings','expected_version',expected_version,'enabled',enabled,
        'lead_days',lead_days,'local_time',local_time,'reason',btrim(reason));
    SELECT * INTO prior FROM gear_2026.events e WHERE e.request_id=update_due_settings.request_id;
    IF FOUND THEN
        IF prior.actor_member_id IS DISTINCT FROM actor OR prior.request_payload IS DISTINCT FROM payload THEN
            RAISE EXCEPTION 'request_conflict' USING ERRCODE='22023'; END IF;
        RETURN prior.after_data;
    END IF;
    IF settings.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'settings_conflict' USING ERRCODE='40001'; END IF;
    before_state:=gear_private_2026.get_due_settings();
    UPDATE gear_2026.app_settings SET due_mail_enabled=enabled,
        due_mail_enabled_at=CASE WHEN enabled AND NOT settings.due_mail_enabled THEN clock_timestamp() ELSE due_mail_enabled_at END,
        reminder_lead_days=lead_days,reminder_local_time=local_time::time WHERE id=1;
    result:=gear_private_2026.get_due_settings();
    INSERT INTO gear_2026.events(scope,event_type,actor_member_id,actor_label,actor_source,before_data,after_data,reason,request_id,request_payload)
        VALUES('settings','settings_updated',actor,(SELECT display_name FROM gear_2026.members WHERE id=actor),'user',before_state,result,btrim(reason),request_id,payload);
    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION gear_private_2026.account_notification_message(job gear_2026.notification_outbox) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE recipient gear_2026.members%ROWTYPE; applicant gear_2026.members%ROWTYPE;
    source gear_2026.events%ROWTYPE; recipient_email text; content jsonb;
BEGIN
    IF job.notification_type='daily_due' THEN RETURN gear_private_2026.daily_due_message(job); END IF;
    SELECT m.* INTO recipient FROM gear_2026.members m WHERE m.id = job.recipient_member_id;
    SELECT u.email INTO recipient_email FROM auth.users u
        WHERE u.id = recipient.auth_user_id AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL;
    IF recipient_email IS NULL THEN RETURN NULL; END IF;
    SELECT e.* INTO source FROM gear_2026.events e WHERE e.id = job.source_event_id AND e.scope = 'member';
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT m.* INTO applicant FROM gear_2026.members m WHERE m.id = source.target_member_id;
    IF NOT FOUND OR applicant.version::text IS DISTINCT FROM source.after_data->>'version' THEN RETURN NULL; END IF;
    IF job.notification_type = 'application_pending' THEN
        IF recipient.status <> 'active' OR recipient.role IS DISTINCT FROM 'admin'
            OR source.event_type <> 'member_applied' OR applicant.status <> 'pending'
            OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = applicant.auth_user_id
                AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL) THEN RETURN NULL; END IF;
        content := jsonb_build_object('kind','application_pending','applicantName',applicant.display_name);
    ELSIF job.notification_type = 'application_result' THEN
        IF recipient.id <> applicant.id OR source.event_type <> 'member_reviewed'
            OR source.before_data->>'status' IS DISTINCT FROM 'pending'
            OR applicant.status IS DISTINCT FROM source.after_data->>'status'
            OR applicant.status NOT IN ('active','rejected') THEN RETURN NULL; END IF;
        content := CASE WHEN applicant.status = 'active'
            THEN jsonb_build_object('kind','application_approved','role',applicant.role)
            ELSE jsonb_build_object('kind','application_rejected') END;
    ELSE RETURN NULL;
    END IF;
    RETURN jsonb_build_object('to',recipient_email,'notification',content);
END;
$$;
CREATE OR REPLACE FUNCTION gear_2026.claim_account_notification() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE settings gear_2026.app_settings%ROWTYPE; job gear_2026.notification_outbox%ROWTYPE;
    day_start timestamptz := date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
BEGIN
    SELECT s.* INTO settings FROM gear_2026.app_settings s WHERE s.id = 1 FOR UPDATE;
    IF NOT settings.outbound_mail_enabled OR settings.notifications_enabled_at IS NULL THEN RETURN NULL; END IF;
    PERFORM gear_private_2026.enqueue_due_notifications();
    -- A crashed sender might have reached Gmail. Never silently reclaim its job.
    UPDATE gear_2026.notification_outbox SET status = 'unknown', lease_until = NULL, error_code = 'lease_expired'
        WHERE status = 'processing' AND lease_until <= clock_timestamp()
          AND notification_type IN ('application_pending','application_result','daily_due');
    IF EXISTS (SELECT 1 FROM gear_2026.notification_outbox WHERE status = 'processing'
        AND notification_type IN ('application_pending','application_result','daily_due')) THEN RETURN NULL; END IF;
    -- Conservative protection: retries count, including earlier attempts of a
    -- job retried today. This is not the mailbox provider's daily quota.
    IF (SELECT coalesce(sum(attempt_count),0) FROM gear_2026.notification_outbox
        WHERE last_attempt_at >= day_start AND notification_type IN ('application_pending','application_result','daily_due')) >= 50
        THEN RETURN NULL; END IF;
    FOR job IN SELECT n.* FROM gear_2026.notification_outbox n
        WHERE n.notification_type IN ('application_pending','application_result','daily_due')
          AND (n.status = 'pending' OR (n.status = 'failed' AND n.attempt_count < 5
            AND n.error_code IN ('oauth_temporary','provider_rate_limit','provider_unauthorized')))
          AND n.available_at <= clock_timestamp()
        ORDER BY n.created_at,n.id LIMIT 20 FOR UPDATE SKIP LOCKED
    LOOP
        IF job.created_at < settings.notifications_enabled_at
            OR gear_private_2026.account_notification_message(job) IS NULL THEN
            UPDATE gear_2026.notification_outbox SET status = 'cancelled', lease_until = NULL,
                error_code = CASE WHEN job.created_at < settings.notifications_enabled_at THEN 'before_enablement' ELSE 'obsolete' END
                WHERE id = job.id;
            CONTINUE;
        END IF;
        UPDATE gear_2026.notification_outbox SET status = 'processing', lease_token = gen_random_uuid(),
            lease_until = clock_timestamp() + interval '2 minutes', last_attempt_at = clock_timestamp(),
            attempt_count = attempt_count + 1, delivery_started_at = NULL, error_code = NULL
            WHERE id = job.id RETURNING * INTO job;
        RETURN jsonb_build_object('id',job.id,'lease_token',job.lease_token);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION gear_private_2026.notification_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
BEGIN
    IF gear_private_2026.current_role() IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501'; END IF;
    RETURN jsonb_build_object('enabled',(SELECT outbound_mail_enabled AND notifications_enabled_at IS NOT NULL FROM gear_2026.app_settings WHERE id = 1),
        'counts',(SELECT coalesce(jsonb_object_agg(status,total),'{}'::jsonb) FROM
            (SELECT status,count(*) AS total FROM gear_2026.notification_outbox
                WHERE notification_type IN ('application_pending','application_result','daily_due') GROUP BY status) counts),
        'recent',(SELECT coalesce(jsonb_agg(to_jsonb(recent)),'[]'::jsonb) FROM
            (SELECT id,notification_type,status,attempt_count,error_code,updated_at FROM gear_2026.notification_outbox
                WHERE notification_type IN ('application_pending','application_result','daily_due') ORDER BY updated_at DESC,id LIMIT 20) recent));
END;
$$;
CREATE FUNCTION gear_2026.get_due_settings() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT gear_private_2026.get_due_settings(); $$;
REVOKE ALL ON FUNCTION gear_2026.get_due_settings(),gear_private_2026.get_due_settings() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_2026.get_due_settings(),gear_private_2026.get_due_settings() TO authenticated;
CREATE FUNCTION gear_2026.update_due_settings(expected_version integer,enabled boolean,lead_days integer,local_time text,reason text,request_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT gear_private_2026.update_due_settings(expected_version,enabled,lead_days,local_time,reason,request_id); $$;
REVOKE ALL ON FUNCTION gear_2026.update_due_settings(integer,boolean,integer,text,text,uuid),gear_private_2026.update_due_settings(integer,boolean,integer,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_2026.update_due_settings(integer,boolean,integer,text,text,uuid),gear_private_2026.update_due_settings(integer,boolean,integer,text,text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION gear_private_2026.due_notification_counts(uuid),gear_private_2026.daily_due_message(gear_2026.notification_outbox),
    gear_private_2026.enqueue_due_notifications() FROM PUBLIC,anon,authenticated,service_role;
-- Preserve an already installed owner-only scheduler without reading any secret.
DO $$ DECLARE definition text; BEGIN
    IF to_regprocedure('gear_private_2026.invoke_account_notifications()') IS NOT NULL THEN
        SELECT pg_get_functiondef(to_regprocedure('gear_private_2026.invoke_account_notifications()')) INTO definition;
        IF position('enqueue_due_notifications' IN definition)=0 THEN
            definition:=replace(definition,'    IF NOT EXISTS (SELECT 1 FROM gear_2026.notification_outbox',
                '    PERFORM gear_private_2026.enqueue_due_notifications();'||chr(10)||'    IF NOT EXISTS (SELECT 1 FROM gear_2026.notification_outbox');
            IF position('enqueue_due_notifications' IN definition)=0 THEN RAISE EXCEPTION 'due_scheduler_source_mismatch'; END IF;
        END IF;
        definition:=replace(definition,$q$('application_pending','application_result')$q$,$q$('application_pending','application_result','daily_due')$q$);
        EXECUTE definition;
    END IF;
END; $$;
NOTIFY pgrst,'reload schema';
COMMIT;
