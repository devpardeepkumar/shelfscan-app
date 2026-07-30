# Lovable setup prompt (paste into Lovable chat)

Build / wire this ShelfScan dashboard exactly:

## Product
- Brand name: ShelfScan
- Dashboard with "Scrape now" button
- Live scrape status + scraped results table (title, price, link)

## Flow (must match)
Button click → Supabase Edge Function `start-scrape` → Browser Use Cloud API `POST https://api.browser-use.com/api/v2/tasks` → Browser Use webhook → Supabase Edge Function `browser-use-webhook` → write to Supabase → dashboard shows live status + results

## Target scrape
- URL: https://books.toscrape.com
- Fields: title, price, link
- Minimum 10 rows
- Use Browser Use structuredOutput JSON schema for books[]

## Supabase schema (do NOT create at runtime)
Tables must already exist from migration `supabase/migrations/20260330120000_init.sql`:
- scrape_runs: id, browser_use_task_id, browser_use_session_id, status (queued|running|completed|failed|stopped), error, books_count, created_at, updated_at
- scrape_results: id, run_id, title, price, link, created_at

There is NO `books` table — use only `scrape_runs` and `scrape_results`.

Apply migration only via:
1. Supabase SQL Editor, or
2. `supabase db push`, or
3. Service Role / server admin (never anon/publishable key, never from the browser)

RLS: public SELECT for anon/authenticated; writes only via service role in Edge Functions.
Realtime: both tables in `supabase_realtime`.

## Edge Functions
1. start-scrape (JWT on): insert scrape_runs row, call Browser Use with metadata.scrape_run_id, save task id, return run_id
2. browser-use-webhook (JWT off): verify X-Browser-Use-Signature HMAC, on completion GET task output, insert scrape_results, mark run completed

## Secrets (Edge Functions)
BROWSER_USE_API_KEY, BROWSER_USE_WEBHOOK_SECRET, BROWSER_USE_BASE_URL=https://api.browser-use.com/api/v2, SUPABASE_SERVICE_ROLE_KEY

## UI
Use the existing React code in this repo (Syne + Instrument Sans, teal ops dashboard). Keep Scrape now as primary action and show live status while running.
