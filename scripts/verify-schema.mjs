#!/usr/bin/env node
/**
 * Read-only schema verification.
 * Uses the publishable/anon key ONLY to probe whether tables are exposed via PostgREST.
 * Does NOT create tables, run DDL, or use the service role.
 *
 * Exit codes:
 *   0 = scrape_runs + scrape_results both exist
 *   2 = one or both missing (apply migration via SQL Editor / db push / service-role admin)
 *   1 = config / unexpected error
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv(envPath);

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env (read-only check only).",
  );
  process.exit(1);
}

const required = ["scrape_runs", "scrape_results"];
const legacy = ["books"];

async function probe(table) {
  const res = await fetch(`${url}/rest/v1/${table}?select=id&limit=1`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  const body = await res.text();
  if (res.ok) return { table, status: "exists" };
  if (
    res.status === 404 ||
    /PGRST205|Could not find the table/i.test(body)
  ) {
    return { table, status: "missing", detail: body.slice(0, 200) };
  }
  // Table may exist but RLS/policy blocks — still treat as present for migration check
  if (res.status === 401 || res.status === 403) {
    return { table, status: "exists_rls_blocked", detail: body.slice(0, 200) };
  }
  return { table, status: "error", http: res.status, detail: body.slice(0, 300) };
}

console.log("Schema verification (read-only; no DDL)\n");

const requiredResults = [];
for (const t of required) {
  const r = await probe(t);
  requiredResults.push(r);
  console.log(`- ${t}: ${r.status}${r.http ? ` (${r.http})` : ""}`);
}

for (const t of legacy) {
  const r = await probe(t);
  console.log(
    `- ${t} (legacy, should be absent): ${r.status === "missing" ? "absent ✓" : r.status}`,
  );
}

const missing = requiredResults.filter((r) => r.status === "missing");
const errors = requiredResults.filter((r) => r.status === "error");

if (errors.length) {
  console.error("\nUnexpected errors while probing. Fix API URL/key, then retry.");
  process.exit(1);
}

if (missing.length) {
  console.log(`
RESULT: migration NOT applied (missing: ${missing.map((m) => m.table).join(", ")})

Apply schema using one of:
  1) Supabase SQL Editor → run supabase/migrations/20260330120000_init.sql
  2) npx supabase db push   (after supabase link)
  3) Server-side admin with Service Role (never in the browser)

Do NOT use the anon/publishable key to create tables.
Next work: APPLY MIGRATION, then re-run this script.
`);
  process.exit(2);
}

console.log(`
RESULT: required tables present (scrape_runs, scrape_results).

Next work (skip migration):
  1) Configure Edge Function secrets
  2) Deploy start-scrape + browser-use-webhook
  3) Configure Browser Use webhook
  4) Test Scrape now in the dashboard
`);
process.exit(0);
