-- Server-only eligibility lookup for the signed Auth Send Email Hook.
BEGIN;
CREATE FUNCTION gear.can_recover_password(identity_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
    SELECT EXISTS (
        SELECT 1 FROM gear.members m JOIN auth.users u ON u.id = m.auth_user_id
        WHERE m.auth_user_id = identity_id AND m.status = 'active'
          AND m.role IN ('admin','operator','viewer')
          AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL
    );
$$;
REVOKE ALL ON FUNCTION gear.can_recover_password(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA gear TO service_role;
GRANT EXECUTE ON FUNCTION gear.can_recover_password(uuid) TO service_role;
COMMIT;
