-- Account notifications only. Does not enable sending, scheduling or shared Auth.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE gear.app_settings ADD COLUMN notifications_enabled_at timestamptz;
ALTER TABLE gear.notification_outbox ADD COLUMN lease_token uuid;
ALTER TABLE gear.notification_outbox ADD COLUMN delivery_started_at timestamptz;

-- Resolve current identities and source events; never trust a queued address or
-- template in payload. This helper is not exposed through the Data API.
CREATE FUNCTION gear_private.account_notification_message(job gear.notification_outbox) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE recipient gear.members%ROWTYPE; applicant gear.members%ROWTYPE;
    source gear.events%ROWTYPE; recipient_email text; content jsonb;
BEGIN
    SELECT m.* INTO recipient FROM gear.members m WHERE m.id = job.recipient_member_id;
    SELECT u.email INTO recipient_email FROM auth.users u
        WHERE u.id = recipient.auth_user_id AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL;
    IF recipient_email IS NULL THEN RETURN NULL; END IF;
    SELECT e.* INTO source FROM gear.events e WHERE e.id = job.source_event_id AND e.scope = 'member';
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT m.* INTO applicant FROM gear.members m WHERE m.id = source.target_member_id;
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

CREATE FUNCTION gear.claim_account_notification() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE settings gear.app_settings%ROWTYPE; job gear.notification_outbox%ROWTYPE;
    day_start timestamptz := date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
BEGIN
    SELECT s.* INTO settings FROM gear.app_settings s WHERE s.id = 1 FOR UPDATE;
    IF NOT settings.outbound_mail_enabled OR settings.notifications_enabled_at IS NULL THEN RETURN NULL; END IF;
    -- A crashed sender might have reached Gmail. Never silently reclaim its job.
    UPDATE gear.notification_outbox SET status = 'unknown', lease_until = NULL, error_code = 'lease_expired'
        WHERE status = 'processing' AND lease_until <= clock_timestamp()
          AND notification_type IN ('application_pending','application_result');
    IF EXISTS (SELECT 1 FROM gear.notification_outbox WHERE status = 'processing'
        AND notification_type IN ('application_pending','application_result')) THEN RETURN NULL; END IF;
    -- Conservative protection: retries count, including earlier attempts of a
    -- job retried today. This is not the mailbox provider's daily quota.
    IF (SELECT coalesce(sum(attempt_count),0) FROM gear.notification_outbox
        WHERE last_attempt_at >= day_start AND notification_type IN ('application_pending','application_result')) >= 50
        THEN RETURN NULL; END IF;
    FOR job IN SELECT n.* FROM gear.notification_outbox n
        WHERE n.notification_type IN ('application_pending','application_result')
          AND (n.status = 'pending' OR (n.status = 'failed' AND n.attempt_count < 5
            AND n.error_code IN ('oauth_temporary','provider_rate_limit','provider_unauthorized')))
          AND n.available_at <= clock_timestamp()
        ORDER BY n.created_at,n.id LIMIT 20 FOR UPDATE SKIP LOCKED
    LOOP
        IF job.created_at < settings.notifications_enabled_at
            OR gear_private.account_notification_message(job) IS NULL THEN
            UPDATE gear.notification_outbox SET status = 'cancelled', lease_until = NULL,
                error_code = CASE WHEN job.created_at < settings.notifications_enabled_at THEN 'before_enablement' ELSE 'obsolete' END
                WHERE id = job.id;
            CONTINUE;
        END IF;
        UPDATE gear.notification_outbox SET status = 'processing', lease_token = gen_random_uuid(),
            lease_until = clock_timestamp() + interval '2 minutes', last_attempt_at = clock_timestamp(),
            attempt_count = attempt_count + 1, delivery_started_at = NULL, error_code = NULL
            WHERE id = job.id RETURNING * INTO job;
        RETURN jsonb_build_object('id',job.id,'lease_token',job.lease_token);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE FUNCTION gear.prepare_account_notification(job_id uuid, token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE settings gear.app_settings%ROWTYPE; job gear.notification_outbox%ROWTYPE; message jsonb;
BEGIN
    -- Same lock order as account changes and claim, then recheck immediately
    -- before submission. A later membership change cannot undo accepted mail.
    SELECT s.* INTO settings FROM gear.app_settings s WHERE s.id = 1 FOR UPDATE;
    SELECT n.* INTO job FROM gear.notification_outbox n WHERE n.id = job_id FOR UPDATE;
    IF NOT FOUND OR job.status <> 'processing' OR job.lease_token IS DISTINCT FROM token
        OR job.lease_until <= clock_timestamp() OR job.delivery_started_at IS NOT NULL THEN RETURN NULL; END IF;
    message := gear_private.account_notification_message(job);
    IF NOT settings.outbound_mail_enabled OR settings.notifications_enabled_at IS NULL
        OR job.created_at < settings.notifications_enabled_at OR message IS NULL THEN
        UPDATE gear.notification_outbox SET status = 'cancelled', lease_until = NULL, error_code = 'obsolete' WHERE id = job.id;
        RETURN NULL;
    END IF;
    UPDATE gear.notification_outbox SET delivery_started_at = clock_timestamp() WHERE id = job.id;
    RETURN message;
END;
$$;

CREATE FUNCTION gear.finish_account_notification(job_id uuid, token uuid, outcome text,
    message_id text DEFAULT NULL, failure_code text DEFAULT NULL, retry_seconds integer DEFAULT 60) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE job gear.notification_outbox%ROWTYPE;
BEGIN
    IF outcome NOT IN ('submitted','failed','unknown') OR outcome IS NULL
        OR (outcome = 'submitted' AND (message_id IS NULL OR message_id !~ '^[A-Za-z0-9_-]{1,255}$' OR failure_code IS NOT NULL))
        OR (outcome <> 'submitted' AND (message_id IS NOT NULL OR failure_code IS NULL OR failure_code NOT IN
            ('oauth_temporary','mail_authorization','provider_rate_limit','provider_unauthorized','provider_rejected','submission_unknown','invalid_message')))
        THEN RAISE EXCEPTION 'invalid_notification_result' USING ERRCODE = '22023'; END IF;
    SELECT n.* INTO job FROM gear.notification_outbox n WHERE n.id = job_id FOR UPDATE;
    IF NOT FOUND OR job.lease_token IS DISTINCT FROM token THEN RETURN false; END IF;
    IF job.status <> 'processing' THEN
        RETURN job.status = outcome AND job.provider_message_id IS NOT DISTINCT FROM message_id
            AND job.error_code IS NOT DISTINCT FROM failure_code;
    END IF;
    IF job.lease_until <= clock_timestamp() THEN RETURN false; END IF;
    IF outcome IN ('submitted','unknown') AND job.delivery_started_at IS NULL THEN
        RAISE EXCEPTION 'notification_not_prepared' USING ERRCODE = '22023'; END IF;
    UPDATE gear.notification_outbox SET status = outcome, lease_until = NULL,
        submitted_at = CASE WHEN outcome = 'submitted' THEN clock_timestamp() END,
        provider_message_id = message_id, error_code = failure_code,
        available_at = clock_timestamp() + make_interval(secs => greatest(60,
            least(86400,coalesce(retry_seconds,60)),(60 * power(2,least(job.attempt_count - 1,10)))::integer))
        WHERE id = job.id;
    RETURN true;
END;
$$;

CREATE FUNCTION gear_private.notification_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
BEGIN
    IF gear_private.current_role() IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501'; END IF;
    RETURN jsonb_build_object('enabled',(SELECT outbound_mail_enabled AND notifications_enabled_at IS NOT NULL FROM gear.app_settings WHERE id = 1),
        'counts',(SELECT coalesce(jsonb_object_agg(status,total),'{}'::jsonb) FROM
            (SELECT status,count(*) AS total FROM gear.notification_outbox
                WHERE notification_type IN ('application_pending','application_result') GROUP BY status) counts),
        'recent',(SELECT coalesce(jsonb_agg(to_jsonb(recent)),'[]'::jsonb) FROM
            (SELECT id,notification_type,status,attempt_count,error_code,updated_at FROM gear.notification_outbox
                WHERE notification_type IN ('application_pending','application_result') ORDER BY updated_at DESC,id LIMIT 20) recent));
END;
$$;
CREATE FUNCTION gear.notification_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT gear_private.notification_status(); $$;

-- Owner-only enable/disable, with an auditable boundary for historical mail.
CREATE FUNCTION gear_private.configure_account_notifications(enabled boolean) RETURNS void
LANGUAGE plpgsql SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE settings gear.app_settings%ROWTYPE; boundary timestamptz;
BEGIN
    IF enabled IS NULL THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
    SELECT s.* INTO settings FROM gear.app_settings s WHERE s.id = 1 FOR UPDATE;
    IF settings.outbound_mail_enabled = enabled AND (NOT enabled OR settings.notifications_enabled_at IS NOT NULL) THEN RETURN; END IF;
    boundary := CASE WHEN enabled THEN clock_timestamp() ELSE settings.notifications_enabled_at END;
    UPDATE gear.app_settings SET outbound_mail_enabled = enabled, notifications_enabled_at = boundary WHERE id = 1;
    INSERT INTO gear.events(scope,event_type,actor_label,actor_source,before_data,after_data,reason)
        VALUES ('settings','settings_updated','部署维护者','system',
            jsonb_build_object('outbound_mail_enabled',settings.outbound_mail_enabled,'notifications_enabled_at',settings.notifications_enabled_at),
            jsonb_build_object('outbound_mail_enabled',enabled,'notifications_enabled_at',boundary),
            CASE WHEN enabled THEN '开启审核邮件通知，从当前时间起发送新任务' ELSE '关闭审核邮件通知' END);
END;
$$;

REVOKE ALL ON FUNCTION gear_private.account_notification_message(gear.notification_outbox),
    gear_private.notification_status(),gear.notification_status(),gear.claim_account_notification(),
    gear.prepare_account_notification(uuid,uuid),gear.finish_account_notification(uuid,uuid,text,text,text,integer),
    gear_private.configure_account_notifications(boolean)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION gear_private.notification_status(),gear.notification_status() TO authenticated;
GRANT EXECUTE ON FUNCTION gear.claim_account_notification(),gear.prepare_account_notification(uuid,uuid),
    gear.finish_account_notification(uuid,uuid,text,text,text,integer) TO service_role;
COMMIT;
