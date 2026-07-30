# ShelfScan — Lovable + Supabase + Browser Use

Live book scraper dashboard.

**Flow:** `Scrape now` → Supabase Edge Function `start-scrape` → Browser Use Cloud `POST /api/v2/tasks` → webhook → Edge Function `browser-use-webhook` → Supabase tables → dashboard (Realtime + polling).

## What you get

- Lovable-ready React dashboard with live run status
- Scrapes `https://books.toscrape.com` for `title`, `price`, `link` (min 10 rows)
- Results stored in existing Supabase tables `scrape_runs` and `scrape_results`

---

## Important: how database migrations work

**Never apply SQL migrations with the anon / publishable key.**
That key is for client read/invoke only. It cannot create tables or run DDL.

Apply `supabase/migrations/20260330120000_init.sql` using **one** of these:

| Method | Who / when |
|---|---|
| **Supabase SQL Editor** | Paste & Run the migration file in the dashboard |
| **Supabase CLI** | `npx supabase db push` after `supabase link` (uses DB credentials, not anon key) |
| **Service Role (server only)** | Admin/server tooling only — never ship this key to the browser |

The app **does not** create tables at runtime. It only reads/writes the existing schema.

### Verify migration before any other DB work

In SQL Editor:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('scrape_runs', 'scrape_results')
order by table_name;
```

Expected: both `scrape_results` and `scrape_runs`.

Optional RLS / Realtime checks:

```sql
-- RLS enabled?
select relname, relrowsecurity
from pg_class
where relname in ('scrape_runs', 'scrape_results');

-- Policies present?
select tablename, policyname, cmd, roles
from pg_policies
where tablename in ('scrape_runs', 'scrape_results');

-- Realtime publication?
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and tablename in ('scrape_runs', 'scrape_results');
```

Or from this repo (read-only PostgREST probe — does **not** create tables):

```bash
node scripts/verify-schema.mjs
```

- If tables are **missing** → apply the migration (stop here; do not deploy app logic against a missing schema).
- If tables **exist** → skip migration and continue with secrets / Edge Functions / webhook / test.

### Schema contract (no `books` table)

| Table | Purpose |
|---|---|
| `scrape_runs` | One row per scrape job + live status |
| `scrape_results` | Scraped rows (`title`, `price`, `link`) per run |

There is **no** `books` table. All app + Edge Function code uses `scrape_runs` / `scrape_results` only.

Migration also configures:

- RLS enabled on both tables
- `SELECT` policies for `anon` + `authenticated`
- Writes via **service role** inside Edge Functions only (no anon insert/update/delete policies)
- Both tables added to `supabase_realtime`

---

## Setup checklist (in order)

### 1) Confirm or apply schema

1. Run the verification SQL (or `node scripts/verify-schema.mjs`).
2. If missing → apply `supabase/migrations/20260330120000_init.sql` via SQL Editor or `npx supabase db push`.
3. Re-verify both tables exist, then continue.

### 2) Frontend env (client keys only)

```bash
cp .env.example .env
```

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your_publishable_or_anon_key
```

Browser Use secrets do **not** belong in Vite client env for production; set them as Edge Function secrets.

### 3) Edge Function secrets (server)

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF

npx supabase secrets set \
  BROWSER_USE_API_KEY=bu_xxx \
  BROWSER_USE_WEBHOOK_SECRET=whsec_xxx \
  BROWSER_USE_BASE_URL=https://api.browser-use.com/api/v2 \
  SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

`BROWSER_USE_BASE_URL` must be the **v2** root (`…/api/v2`), not v4.

### 4) Deploy Edge Functions

```bash
npx supabase functions deploy start-scrape
npx supabase functions deploy browser-use-webhook --no-verify-jwt
```

### 5) Browser Use webhook

1. Open [Browser Use webhooks](https://cloud.browser-use.com/settings?tab=webhooks).
2. Endpoint:

```text
https://YOUR_PROJECT.supabase.co/functions/v1/browser-use-webhook
```

3. Put the webhook secret into `BROWSER_USE_WEBHOOK_SECRET`.
4. Send a test ping → expect `OK`.

### 6) Test

```bash
npm install
npm run dev
```

Click **Scrape now** → live status → ≥10 rows in `scrape_results`.

### 7) Publish Lovable URL

Connect the same Supabase project in Lovable, deploy/publish the app, share the public URL.

---

## API notes

- Create task: `POST ${BROWSER_USE_BASE_URL}/tasks`
- Auth header: `X-Browser-Use-API-Key`
- Webhook: `agent.task.status_update` + HMAC signature verification
- On completion: `GET ${BROWSER_USE_BASE_URL}/tasks/{id}` → insert into `scrape_results`

## Project map

```text
src/App.tsx                              Dashboard UI + Scrape now
src/hooks/useLiveScrape.ts               Uses scrape_runs / scrape_results only
scripts/verify-schema.mjs                Read-only schema presence check
supabase/migrations/20260330120000_init.sql   Tables + RLS + Realtime
supabase/functions/start-scrape          Starts Browser Use task
supabase/functions/browser-use-webhook   Webhook → scrape_results
```
