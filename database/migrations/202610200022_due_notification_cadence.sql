-- One advance reminder, on the due date, then every third overdue day.
-- The shared selector serves both enqueue and the final pre-send recheck.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
    PERFORM 1 FROM gear_2026.app_settings WHERE id=1 FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM pg_proc
        WHERE oid=to_regprocedure('gear_private_2026.due_notification_counts(uuid)')
        AND md5(prosrc)='f784ac9854cf80d482fec0836cc09d76') THEN
        RAISE EXCEPTION 'due_cadence_source_mismatch';
    END IF;
END; $$;

CREATE OR REPLACE FUNCTION gear_private_2026.due_notification_counts(member_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path='' SET timezone='UTC' AS $$
    WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS d), eligible AS (
        SELECT x.due_on FROM gear_2026.assignments x JOIN gear_2026.assets a ON a.id=x.asset_id
        CROSS JOIN today CROSS JOIN gear_2026.app_settings s
        WHERE s.id=1 AND x.closed_at IS NULL AND x.usage_kind='temporary' AND a.management_status='managed'
            AND a.invalidated_at IS NULL AND (x.due_on=today.d+s.reminder_lead_days OR x.due_on=today.d
                OR (x.due_on<today.d AND (today.d-x.due_on)%3=0))
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
NOTIFY pgrst,'reload schema';
COMMIT;
