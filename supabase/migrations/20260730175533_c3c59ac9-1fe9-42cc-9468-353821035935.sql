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

grant select on public.scrape_runs to anon, authenticated;
grant all on public.scrape_runs to service_role;

create table if not exists public.scrape_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.scrape_runs(id) on delete cascade,
  title text not null,
  price text not null,
  link text not null,
  created_at timestamptz not null default now()
);

grant select on public.scrape_results to anon, authenticated;
grant all on public.scrape_results to service_role;

create index if not exists scrape_results_run_id_idx on public.scrape_results(run_id);
create index if not exists scrape_runs_created_at_idx on public.scrape_runs(created_at desc);
create index if not exists scrape_runs_task_id_idx on public.scrape_runs(browser_use_task_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
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