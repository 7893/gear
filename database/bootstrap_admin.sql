-- Run manually as the database owner, after the designated user verifies email.
-- psql reads private values from the environment; no identity is hardcoded here.
\set ON_ERROR_STOP on
\getenv gear_admin_email GEAR_ADMIN_EMAIL
\getenv gear_admin_name GEAR_ADMIN_DISPLAY_NAME
\if :{?gear_admin_email}
\else
  DO $$ BEGIN RAISE EXCEPTION 'GEAR_ADMIN_EMAIL is required'; END $$;
\endif
\if :{?gear_admin_name}
\else
  DO $$ BEGIN RAISE EXCEPTION 'GEAR_ADMIN_DISPLAY_NAME is required'; END $$;
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT gear_private_2026.bootstrap_admin(
    (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(btrim(:'gear_admin_email'))),
    :'gear_admin_name'
);
COMMIT;
