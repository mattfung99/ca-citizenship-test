-- migration: 20260708120000_keep_alive_grant_select
-- description: allow the anon keep-alive PATCH to succeed.
--
-- PostgREST turns `PATCH /rest/v1/keep_alive?id=eq.1` into
--   UPDATE keep_alive SET pinged_at = $1 WHERE id = 1
-- and Postgres requires SELECT privilege (and, under RLS, a SELECT policy) to
-- read the `id` column in that WHERE clause. Without it the write fails with
-- 42501 "permission denied for table keep_alive". The table holds only a
-- liveness timestamp, so granting read access exposes nothing sensitive.
--
-- Idempotent so it is safe whether applied by the Supabase GitHub integration
-- on push or re-run against a database that already has it.

grant select on keep_alive to anon;

drop policy if exists "anon may read ping" on keep_alive;
create policy "anon may read ping" on keep_alive
  for select using (true);
