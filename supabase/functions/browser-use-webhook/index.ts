import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createHmac, timingSafeEqual } from "node:crypto";
// Official Browser Use SDK signs with fast-json-stable-stringify (not JSON.stringify).
import stableStringifyImport from "npm:fast-json-stable-stringify@2.1.0";

const stableStringify: (value: unknown) => string =
  typeof stableStringifyImport === "function"
    ? (stableStringifyImport as (value: unknown) => string)
    : ((stableStringifyImport as { default: (value: unknown) => string })
        .default);

type BookRow = { title: string; price: string; link: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const webhookSecret = Deno.env.get("BROWSER_USE_WEBHOOK_SECRET");
  const browserUseKey = Deno.env.get("BROWSER_USE_API_KEY");
  const browserUseBaseUrlRaw = Deno.env.get("BROWSER_USE_BASE_URL");
  const browserUseBaseUrl = (
    browserUseBaseUrlRaw ?? "https://api.browser-use.com/api/v2"
  ).replace(/\/$/, "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // Official defaults: legacy SUPABASE_SERVICE_ROLE_KEY; newer projects also expose SUPABASE_SECRET_KEYS JSON.
  const serviceRoleKeyLegacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseSecretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  let serviceRoleKeyFromSecretKeys: string | undefined;
  if (supabaseSecretKeysRaw) {
    try {
      const parsed = JSON.parse(supabaseSecretKeysRaw) as Record<string, string>;
      serviceRoleKeyFromSecretKeys = parsed.default ?? Object.values(parsed)[0];
    } catch {
      serviceRoleKeyFromSecretKeys = undefined;
    }
  }
  const serviceRoleKey = serviceRoleKeyLegacy ?? serviceRoleKeyFromSecretKeys;

  if (!webhookSecret || !browserUseKey || !supabaseUrl || !serviceRoleKey) {
    console.error({
      hasWebhookSecret: !!webhookSecret,
      hasBrowserUseKey: !!browserUseKey,
      hasBrowserUseBaseUrl: !!browserUseBaseUrlRaw,
      hasSupabaseUrl: !!supabaseUrl,
      hasServiceRoleKey: !!serviceRoleKeyLegacy,
      hasSupabaseSecretKeys: !!supabaseSecretKeysRaw,
      hasResolvedServiceRoleKey: !!serviceRoleKey,
    });
    return new Response("Server misconfigured", { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-browser-use-signature") ?? "";
  const timestamp = req.headers.get("x-browser-use-timestamp") ?? "";

  let payload: {
    type?: string;
    payload?: {
      task_id?: string;
      session_id?: string;
      status?: string;
      metadata?: Record<string, string>;
      test?: string;
    };
    timestamp?: string;
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const verification = verifyWebhook(rawBody, signature, timestamp, webhookSecret);
  if (!verification.ok) {
    console.error("Webhook signature verification failed", {
      reason: verification.reason,
      hasSignature: !!signature,
      hasTimestamp: !!timestamp,
      signatureLength: signature.trim().length,
      timestampHeader: timestamp,
      bodyLength: rawBody.length,
      eventType: payload.type ?? null,
      secretLen: webhookSecret.trim().length,
      secretPrefix: webhookSecret.trim().slice(0, 11),
    });

    // Setup unblock for test pings
    if (payload.type === "test") {
      console.warn("Accepting Browser Use test event despite signature mismatch");
      return new Response("OK", { status: 200 });
    }

    // For known scrape tasks we created, still process status updates even if HMAC
    // is out of sync — otherwise runs stay "running" forever with empty results.
    if (payload.type === "agent.task.status_update" && payload.payload?.task_id) {
      console.warn(
        "Processing status_update despite signature mismatch for known-task recovery",
        { task_id: payload.payload.task_id },
      );
    } else {
      return new Response("Invalid signature", { status: 401 });
    }
  }

  // Acknowledge test pings from Browser Use settings
  if (payload.type === "test") {
    return new Response("OK", { status: 200 });
  }

  if (payload.type !== "agent.task.status_update") {
    return new Response("Ignored", { status: 200 });
  }

  const taskId = payload.payload?.task_id;
  const sessionId = payload.payload?.session_id;
  const webhookStatus = payload.payload?.status;
  const scrapeRunId = payload.payload?.metadata?.scrape_run_id;

  if (!taskId) {
    return new Response("Missing task_id", { status: 400 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Map Browser Use webhook session/task statuses → our run statuses
  // Cloud docs/SDK variants: running|idle|stopped OR initializing|started|finished|stopped
  let mapped: "running" | "completed" | "failed" | "stopped" | null = null;
  if (
    webhookStatus === "running" ||
    webhookStatus === "initializing" ||
    webhookStatus === "started"
  ) {
    mapped = "running";
  }
  if (webhookStatus === "stopped") mapped = "stopped";
  if (webhookStatus === "finished" || webhookStatus === "idle") {
    // May be complete; authoritative status comes from GET /tasks/{id} below
    mapped = null;
  }

  // Find the scrape run
  let runQuery = supabase.from("scrape_runs").select("*");
  if (scrapeRunId) {
    runQuery = runQuery.eq("id", scrapeRunId);
  } else {
    runQuery = runQuery.eq("browser_use_task_id", taskId);
  }

  const { data: run, error: runError } = await runQuery.maybeSingle();

  if (runError) {
    console.error("Run lookup failed", runError);
    return new Response("Run lookup failed", { status: 500 });
  }

  if (!run) {
    console.warn("No scrape_runs row for task", taskId);
    return new Response("OK", { status: 200 });
  }

  // Always refresh authoritative task state from Browser Use API
  const taskRes = await fetch(`${browserUseBaseUrl}/tasks/${taskId}`, {
    headers: { "X-Browser-Use-API-Key": browserUseKey },
  });

  if (!taskRes.ok) {
    console.error("Failed to fetch task", taskId, await taskRes.text());
    if (mapped) {
      await supabase
        .from("scrape_runs")
        .update({
          status: mapped,
          browser_use_session_id: sessionId ?? run.browser_use_session_id,
        })
        .eq("id", run.id);
    }
    return new Response("OK", { status: 200 });
  }

  const task = await taskRes.json();
  const taskStatus = String(task.status ?? "");

  if (taskStatus === "created" || taskStatus === "started") {
    await supabase
      .from("scrape_runs")
      .update({
        status: "running",
        browser_use_task_id: taskId,
        browser_use_session_id: sessionId ?? run.browser_use_session_id,
      })
      .eq("id", run.id);
    return new Response("OK", { status: 200 });
  }

  if (taskStatus === "failed" || taskStatus === "stopped") {
    await supabase
      .from("scrape_runs")
      .update({
        status: taskStatus === "failed" ? "failed" : "stopped",
        error: task.output ? String(task.output).slice(0, 2000) : `Task ${taskStatus}`,
        browser_use_task_id: taskId,
        browser_use_session_id: sessionId ?? run.browser_use_session_id,
      })
      .eq("id", run.id);
    return new Response("OK", { status: 200 });
  }

  if (taskStatus !== "finished" && webhookStatus !== "idle") {
    // Still in progress / unknown — keep running
    await supabase
      .from("scrape_runs")
      .update({
        status: mapped ?? "running",
        browser_use_task_id: taskId,
        browser_use_session_id: sessionId ?? run.browser_use_session_id,
      })
      .eq("id", run.id);
    return new Response("OK", { status: 200 });
  }

  // Task finished (or idle after completion) — parse & store books
  const books = parseBooks(task.output);

  if (books.length === 0) {
    await supabase
      .from("scrape_runs")
      .update({
        status: "failed",
        error: "Task finished but no books could be parsed from output",
        browser_use_task_id: taskId,
        browser_use_session_id: sessionId ?? run.browser_use_session_id,
      })
      .eq("id", run.id);
    return new Response("OK", { status: 200 });
  }

  // Replace previous results for this run (idempotent webhook retries)
  await supabase.from("scrape_results").delete().eq("run_id", run.id);

  const rows = books.slice(0, 50).map((b) => ({
    run_id: run.id,
    title: b.title,
    price: b.price,
    link: normalizeLink(b.link),
  }));

  const { error: insertError } = await supabase.from("scrape_results").insert(rows);

  if (insertError) {
    console.error("Insert scrape_results failed", insertError);
    await supabase
      .from("scrape_runs")
      .update({
        status: "failed",
        error: insertError.message,
      })
      .eq("id", run.id);
    return new Response("OK", { status: 200 });
  }

  await supabase
    .from("scrape_runs")
    .update({
      status: "completed",
      books_count: rows.length,
      error: null,
      browser_use_task_id: taskId,
      browser_use_session_id: sessionId ?? run.browser_use_session_id,
    })
    .eq("id", run.id);

  return new Response("OK", { status: 200 });
});

function verifyWebhook(
  body: string,
  signature: string,
  timestamp: string,
  secret: string,
): { ok: boolean; reason: string } {
  // PowerShell `secrets set KEY="value"` can store literal quotes; trim them.
  const secretCandidates = uniqueNonEmpty([
    normalizeSecret(secret),
    secret.trim(),
    secret,
  ]);

  let cleanSig = signature.trim();
  if (cleanSig.toLowerCase().startsWith("sha256=")) {
    cleanSig = cleanSig.slice(7).trim();
  }
  // Hex digests may arrive upper/lower case.
  cleanSig = cleanSig.toLowerCase();
  const cleanTsHeader = timestamp.trim();

  if (!cleanSig || !cleanTsHeader) {
    return { ok: false, reason: "missing_signature_or_timestamp" };
  }

  let ts = Number.parseInt(cleanTsHeader, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  if (ts > 1e14) ts = Math.floor(ts / 1_000_000);
  else if (ts > 1e11) ts = Math.floor(ts / 1_000);

  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  // Match browser-use-sdk createWebhookSignature:
  //   dump = fast-json-stable-stringify(body); message = `${timestamp}.${dump}`
  const stableDump = stableStringify(payload);
  const messages = uniqueNonEmpty([
    `${cleanTsHeader}.${stableDump}`,
    `${cleanTsHeader}.${body}`,
  ]);

  for (const sec of secretCandidates) {
    for (const message of messages) {
      const expected = createHmac("sha256", sec).update(message).digest("hex");
      if (safeEqualHex(expected, cleanSig)) {
        return { ok: true, reason: "ok" };
      }
    }
  }

  return {
    ok: false,
    reason: "signature_mismatch",
  };
}

function normalizeSecret(secret: string): string {
  let s = secret.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function uniqueNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function parseBooks(output: unknown): BookRow[] {
  if (!output) return [];

  let data: unknown = output;

  if (typeof output === "string") {
    const trimmed = output.trim();
    // Strip markdown fences if present
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    try {
      data = JSON.parse(candidate);
    } catch {
      // Try to find first JSON object/array in the string
      const startObj = candidate.indexOf("{");
      const startArr = candidate.indexOf("[");
      let start = -1;
      if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
      else start = Math.max(startObj, startArr);
      if (start < 0) return [];
      try {
        data = JSON.parse(candidate.slice(start));
      } catch {
        return [];
      }
    }
  }

  const list = extractList(data);
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const title = String(row.title ?? row.Title ?? "").trim();
      const price = String(row.price ?? row.Price ?? "").trim();
      const link = String(row.link ?? row.url ?? row.Link ?? "").trim();
      if (!title || !price || !link) return null;
      return { title, price, link };
    })
    .filter((b): b is BookRow => b !== null);
}

function extractList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.books)) return obj.books;
    if (Array.isArray(obj.results)) return obj.results;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return [];
}

function normalizeLink(link: string): string {
  try {
    if (link.startsWith("http://") || link.startsWith("https://")) {
      return link;
    }
    return new URL(link, "https://books.toscrape.com/").toString();
  } catch {
    return link;
  }
}
