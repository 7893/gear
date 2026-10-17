-- Explicit owner-authorized installation only; not part of normal migrations/CD.
-- Required extensions must already exist. Never enables or alters shared ones.
\set ON_ERROR_STOP on
\getenv gear_notification_url GEAR_NOTIFICATION_FUNCTION_URL
\getenv gear_notification_token GEAR_NOTIFICATION_TOKEN
\if :{?gear_notification_url}
\else
  DO $$ BEGIN RAISE EXCEPTION 'GEAR_NOTIFICATION_FUNCTION_URL is required'; END $$;
\endif
\if :{?gear_notification_token}
\else
  DO $$ BEGIN RAISE EXCEPTION 'GEAR_NOTIFICATION_TOKEN is required'; END $$;
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE gear_notification_install (url text, token text) ON COMMIT DROP;
INSERT INTO gear_notification_install VALUES (:'gear_notification_url',:'gear_notification_token');
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
        OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
        OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
        RAISE EXCEPTION 'Required scheduler extensions must be inspected and separately authorized first'; END IF;
    IF EXISTS (SELECT 1 FROM gear_notification_install WHERE
        url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/gear-notification-mail$'
        OR token !~ '^[A-Za-z0-9_-]{32,128}$') THEN
        RAISE EXCEPTION 'Invalid private notification configuration'; END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gear-account-notifications')
        OR EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name IN ('gear_notification_url','gear_notification_token')) THEN
        RAISE EXCEPTION 'Gear scheduler or Vault names already exist; inspect ownership before changing'; END IF;
END $$;
SELECT vault.create_secret(url,'gear_notification_url') AS gear_vault_url FROM gear_notification_install \gset
SELECT vault.create_secret(token,'gear_notification_token') AS gear_vault_token FROM gear_notification_install \gset

CREATE FUNCTION gear_private.invoke_account_notifications() RETURNS bigint
LANGUAGE plpgsql SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE endpoint text; credential text; request_id bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM gear.app_settings WHERE id = 1
        AND outbound_mail_enabled AND notifications_enabled_at IS NOT NULL) THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM gear.notification_outbox WHERE notification_type IN ('application_pending','application_result') AND
        ((status = 'pending' AND available_at <= clock_timestamp())
         OR (status = 'failed' AND attempt_count < 5 AND available_at <= clock_timestamp()
            AND error_code IN ('oauth_temporary','provider_rate_limit','provider_unauthorized'))
         OR (status = 'processing' AND lease_until <= clock_timestamp()))) THEN RETURN NULL; END IF;
    SELECT decrypted_secret INTO STRICT endpoint FROM vault.decrypted_secrets WHERE name = 'gear_notification_url';
    SELECT decrypted_secret INTO STRICT credential FROM vault.decrypted_secrets WHERE name = 'gear_notification_token';
    IF endpoint !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/gear-notification-mail$'
        OR credential !~ '^[A-Za-z0-9_-]{32,128}$' THEN RAISE EXCEPTION 'Invalid notification scheduler configuration'; END IF;
    SELECT net.http_post(url := endpoint,
        headers := jsonb_build_object('Authorization','Bearer ' || credential,'Content-Type','application/json'),
        body := '{}'::jsonb,timeout_milliseconds := 45000) INTO request_id;
    RETURN request_id;
END;
$$;
REVOKE ALL ON FUNCTION gear_private.invoke_account_notifications() FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('gear-account-notifications','* * * * *',
    'SELECT gear_private.invoke_account_notifications();') AS gear_cron_id \gset
COMMIT;
-- Sending remains OFF. A separate authorized owner transaction calls:
-- SELECT gear_private.configure_account_notifications(true);
