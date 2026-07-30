-- ShelfScan schema: scrape_runs + scrape_results
--
-- HOW TO APPLY (pick one — never use the anon/publishable key for DDL):
--   1) Supabase Dashboard → SQL Editor → paste this file → Run
--   2) CLI: npx supabase db push   (after: npx supabase link --project-ref <ref>)
--   3) Server-side admin connection / Service Role tooling only
--
-- The app does NOT create these tables at runtime.
-- Verify after apply:
--   select table_name from information_schema.tables
--   where table_schema='public' and table_name in ('scrape_runs','scrape_results');

create extension if not exists "pgcrypto";

create table if not exists public.scrape_runs (
  id uuid primary key default gen_random_uuid(),
  browser_use_task_id text,
  browser_use_session_id text,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'stopped')),
  error text,
  books_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scrape_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.scrape_runs(id) on delete cascade,
  title text not null,
  price text not null,
  link text not null,
  created_at timestamptz not null default now()
);

create index if not exists scrape_results_run_id_idx on public.scrape_results(run_id);
create index if not exists scrape_runs_created_at_idx on public.scrape_runs(created_at desc);
create index if not exists scrape_runs_task_id_idx on public.scrape_runs(browser_use_task_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scrape_runs_set_updated_at on public.scrape_runs;
create trigger scrape_runs_set_updated_at
before update on public.scrape_runs
for each row execute function public.set_updated_at();

alter table public.scrape_runs enable row level security;
alter table public.scrape_results enable row level security;

-- Public read for demo dashboard (anon / publishable key: SELECT only)
-- DDL is never performed with the anon key; this policy only allows reading.
drop policy if exists "Public read scrape_runs" on public.scrape_runs;
create policy "Public read scrape_runs"
  on public.scrape_runs for select
  to anon, authenticated
  using (true);

drop policy if exists "Public read scrape_results" on public.scrape_results;
create policy "Public read scrape_results"
  on public.scrape_results for select
  to anon, authenticated
  using (true);

-- Writes only via service role (Edge Functions). No insert/update policies for anon.

-- Realtime for live status (safe if already added)
do $$
begin
  alter publication supabase_realtime add table public.scrape_runs;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.scrape_results;
exception when duplicate_object then null;
end $$;
