-- migration: 20260708000000_keep_alive
-- description: singleton liveness table pinged (written) by the keep-alive workflow.
--
-- Why a write, not a read: a SELECT as the anon role returns 0 rows once RLS is
-- applied, and Supabase's free-plan pause detection does not reliably count that
-- as activity — the project paused right after a "successful" read-ping. A write
-- (UPDATE) is an unambiguous activity signal. This mirrors travisvn/supabase-inactive-fix.

create table keep_alive (
  id         smallint primary key default 1,
  pinged_at  timestamptz not null default now(),
  constraint singleton check (id = 1)
);

-- Seed the single row the workflow updates. The singleton check caps the table
-- at one row forever, so there is no bloat and nothing to clean up.
insert into keep_alive (id) values (1);

alter table keep_alive enable row level security;

-- Anyone (anon) may bump the timestamp. There is nothing sensitive here and the
-- singleton constraint means the only possible "abuse" is overwriting one date.
-- No SELECT grant/policy: the workflow PATCHes with `Prefer: return=minimal`.
create policy "anon may ping" on keep_alive
  for update using (true) with check (true);

grant update on keep_alive to anon;
