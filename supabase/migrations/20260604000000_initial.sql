-- migration: 20260604000000_initial
-- description: attempts table, RLS policy, 100 KB size constraint
-- deployed: automatically via Supabase GitHub integration on push to master

create table attempts (
  id            text primary key,
  user_id       uuid not null references auth.users on delete cascade,
  data          jsonb not null,
  finished_at   timestamptz not null,
  constraint data_size_limit check (octet_length(data::text) < 102400)
);

create index attempts_user_finished_idx on attempts (user_id, finished_at desc);

alter table attempts enable row level security;

create policy "own attempts only" on attempts
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
