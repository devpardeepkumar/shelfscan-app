import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type BookRow = { title: string; price: string; link: string };

/**
 * Pulls Browser Use task status for a scrape_run and writes results when finished.
 * Used as a reliable fallback when webhooks fail signature verification.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const browserUseKey = Deno.env.get("BROWSER_USE_API_KEY");
    const browserUseBaseUrl = (
      Deno.env.get("BROWSER_USE_BASE_URL") ??
      "https://api.browser-use.com/api/v2"
    ).replace(/\/$/, "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      (() => {
        const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
        if (!raw) return undefined;
        try {
          const parsed = JSON.parse(raw) as Record<string, string>;
          return parsed.default ?? Object.values(parsed)[0];
        } catch {
          return undefined;
        }
      })();

    if (!browserUseKey || !supabaseUrl || !serviceRoleKey) {
      return json({ error: "Missing secrets" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const runId = body.run_id as string | undefined;
    if (!runId) return json({ error: "run_id is required" }, 400);

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: run, error: runError } = await supabase
      .from("scrape_runs")
      .select("*")
      .eq("id", runId)
      .maybeSingle();

    if (runError || !run) {
      return json({ error: "scrape run not found" }, 404);
    }

    if (!run.browser_use_task_id) {
      return json({
        run_id: runId,
        status: run.status,
        books_count: run.books_count ?? 0,
        message: "No Browser Use task id yet",
      });
    }

    if (run.status === "completed" || run.status === "failed" || run.status === "stopped") {
      const { count } = await supabase
        .from("scrape_results")
        .select("*", { count: "exact", head: true })
        .eq("run_id", runId);
      return json({
        run_id: runId,
        status: run.status,
        books_count: run.books_count ?? count ?? 0,
      });
    }

    const taskRes = await fetch(
      `${browserUseBaseUrl}/tasks/${run.browser_use_task_id}`,
      { headers: { "X-Browser-Use-API-Key": browserUseKey } },
    );

    if (!taskRes.ok) {
      const detail = await taskRes.text();
      return json({ error: "Failed to fetch Browser Use task", detail }, 502);
    }

    const task = await taskRes.json();
    const taskStatus = String(task.status ?? "");

    if (taskStatus === "created" || taskStatus === "started") {
      await supabase
        .from("scrape_runs")
        .update({ status: "running" })
        .eq("id", runId);
      return json({ run_id: runId, status: "running", browser_use_status: taskStatus });
    }

    if (taskStatus === "failed" || taskStatus === "stopped") {
      await supabase
        .from("scrape_runs")
        .update({
          status: taskStatus === "failed" ? "failed" : "stopped",
          error: task.output
            ? String(task.output).slice(0, 2000)
            : `Task ${taskStatus}`,
        })
        .eq("id", runId);
      return json({ run_id: runId, status: taskStatus === "failed" ? "failed" : "stopped" });
    }

    if (taskStatus !== "finished") {
      return json({
        run_id: runId,
        status: "running",
        browser_use_status: taskStatus,
      });
    }

    const books = parseBooks(task.output);
    if (books.length === 0) {
      await supabase
        .from("scrape_runs")
        .update({
          status: "failed",
          error: "Task finished but no books could be parsed from output",
        })
        .eq("id", runId);
      return json({ run_id: runId, status: "failed", books_count: 0 });
    }

    await supabase.from("scrape_results").delete().eq("run_id", runId);
    const rows = books.slice(0, 50).map((b) => ({
      run_id: runId,
      title: b.title,
      price: b.price,
      link: normalizeLink(b.link),
    }));

    const { error: insertError } = await supabase.from("scrape_results").insert(rows);
    if (insertError) {
      await supabase
        .from("scrape_runs")
        .update({ status: "failed", error: insertError.message })
        .eq("id", runId);
      return json({ error: insertError.message, run_id: runId }, 500);
    }

    await supabase
      .from("scrape_runs")
      .update({
        status: "completed",
        books_count: rows.length,
        error: null,
      })
      .eq("id", runId);

    return json({
      run_id: runId,
      status: "completed",
      books_count: rows.length,
    });
  } catch (err) {
    console.error(err);
    return json(
      { error: err instanceof Error ? err.message : "Unexpected error" },
      500,
    );
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseBooks(output: unknown): BookRow[] {
  if (!output) return [];
  let data: unknown = output;
  if (typeof output === "string") {
    const trimmed = output.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    try {
      data = JSON.parse(candidate);
    } catch {
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
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as { books?: unknown[]; results?: unknown[]; items?: unknown[] })
          .books ??
        (data as { results?: unknown[] }).results ??
        (data as { items?: unknown[] }).items ??
        [])
      : [];
  return (list as unknown[])
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

function normalizeLink(link: string): string {
  try {
    if (link.startsWith("http://") || link.startsWith("https://")) return link;
    return new URL(link, "https://books.toscrape.com/").toString();
  } catch {
    return link;
  }
}
