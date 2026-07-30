-- Align existing scrape_runs with ShelfScan app/Edge Function schema.
-- Safe to run multiple times. Run in Supabase SQL Editor.
-- (CREATE TABLE IF NOT EXISTS does NOT add columns to an already-existing table.)

alter table public.scrape_runs
  add column if not exists browser_use_task_id text,
  add column if not exists browser_use_session_id text,
  add column if not exists error text,
  add column if not exists books_count integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Backfill created_at from legacy started_at when present
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'scrape_runs'
      and column_name = 'started_at'
  ) then
    execute $sql$
      update public.scrape_runs
      set created_at = coalesce(started_at, created_at),
          updated_at = coalesce(started_at, updated_at)
      where created_at is distinct from coalesce(started_at, created_at)
         or updated_at is distinct from coalesce(started_at, updated_at)
    $sql$;
  end if;
end $$;

-- Ensure status check allows app values (drop old check if it conflicts, then re-add)
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'scrape_runs'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%status%'
  loop
    execute format('alter table public.scrape_runs drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.scrape_runs
  drop constraint if exists scrape_runs_status_check;

alter table public.scrape_runs
  add constraint scrape_runs_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'stopped'));

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

-- Verify
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'scrape_runs'
order by ordinal_position;
