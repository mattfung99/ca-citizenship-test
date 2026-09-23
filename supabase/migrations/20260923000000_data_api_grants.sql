-- migration: 20260923000000_data_api_grants
-- description: explicit service_role grants on attempts + keep_alive.
--
-- From 2026-10-30 Supabase no longer auto-grants Data API access to newly
-- created tables in `public`. Existing tables keep the grants they already
-- have, so this migration is a no-op against the current production database.
-- It matters for any database built fresh from these migrations — a new
-- project, a preview branch, or a local `supabase db reset` — where
-- service_role would otherwise have no privileges on these tables at all.
--
-- Why service_role specifically: BYPASSRLS skips row-level policies, but the
-- role still needs ordinary table privileges. Without them PostgREST returns
-- 42501 "permission denied for table ...".
--
-- What depends on it:
--   * scripts/migrate.py export  — read by the weekly supabase-backup workflow
--   * scripts/migrate.py import  — the documented restore-into-a-new-project
--                                  path, which is precisely the case where the
--                                  table is newly created and unreachable
--
-- anon/authenticated grants stay as the earlier migrations set them: anon has
-- no business reading attempts, and keep_alive already grants anon what the
-- ping workflow needs.

grant select, insert, update, delete on attempts   to service_role;
grant select, update                 on keep_alive to service_role;
