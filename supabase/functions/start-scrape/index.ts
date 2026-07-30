import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SCRAPE_TASK = `Go to https://books.toscrape.com and scrape book listings from the homepage catalogue.

Extract at least 10 books. For each book collect:
- title (full book title)
- price (as shown, e.g. £51.77)
- link (absolute URL to the book detail page, starting with https://books.toscrape.com)

Return ONLY valid JSON matching the structured output schema. Do not include markdown.`;

const STRUCTURED_OUTPUT = JSON.stringify({
  type: "object",
  properties: {
    books: {
      type: "array",
      minItems: 10,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          price: { type: "string" },
          link: { type: "string" },
        },
        required: ["title", "price", "link"],
      },
    },
  },
  required: ["books"],
});

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
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!browserUseKey || !supabaseUrl || !serviceRoleKey) {
      return json(
        {
          error:
            "Missing secrets. Set BROWSER_USE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.",
        },
        500,
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: run, error: insertError } = await supabase
      .from("scrape_runs")
      .insert({ status: "queued" })
      .select("*")
      .single();

    if (insertError || !run) {
      console.error("Failed to create scrape_runs row", insertError);
      return json({ error: "Failed to create scrape run" }, 500);
    }

    const buResponse = await fetch(`${browserUseBaseUrl}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Browser-Use-API-Key": browserUseKey,
      },
      body: JSON.stringify({
        task: SCRAPE_TASK,
        startUrl: "https://books.toscrape.com",
        maxSteps: 40,
        structuredOutput: STRUCTURED_OUTPUT,
        metadata: {
          scrape_run_id: run.id,
          source: "shelfscan",
        },
      }),
    });

    const buBody = await buResponse.json().catch(() => ({}));

    if (!buResponse.ok) {
      const message =
        typeof buBody?.detail === "string"
          ? buBody.detail
          : JSON.stringify(buBody) || `Browser Use error ${buResponse.status}`;

      const failUpdate = await supabase
        .from("scrape_runs")
        .update({ status: "failed", error: message })
        .eq("id", run.id);

      if (failUpdate.error) {
        // Fallback if optional columns (e.g. error) are missing on older schemas
        await supabase
          .from("scrape_runs")
          .update({ status: "failed" })
          .eq("id", run.id);
      }

      return json({ error: "Browser Use task failed to start", detail: message, run_id: run.id }, 502);
    }

    const taskId = buBody.id as string | undefined;
    const sessionId = buBody.sessionId as string | undefined;

    const { data: updated, error: updateError } = await supabase
      .from("scrape_runs")
      .update({
        status: "running",
        browser_use_task_id: taskId ?? null,
        browser_use_session_id: sessionId ?? null,
      })
      .eq("id", run.id)
      .select("*")
      .single();

    if (updateError) {
      console.error("Failed to update scrape run", updateError);
      // Retry status-only so the run does not stay stuck in queued
      const retry = await supabase
        .from("scrape_runs")
        .update({ status: "running" })
        .eq("id", run.id)
        .select("*")
        .single();

      if (retry.error) {
        await supabase
          .from("scrape_runs")
          .update({ status: "failed", error: retry.error.message })
          .eq("id", run.id);
        return json(
          {
            error: "Failed to update scrape run after Browser Use start",
            detail: updateError.message,
            run_id: run.id,
          },
          500,
        );
      }

      return json({
        run_id: run.id,
        status: "running",
        browser_use_task_id: taskId,
        browser_use_session_id: sessionId,
        run: retry.data ?? run,
      });
    }

    return json({
      run_id: run.id,
      status: "running",
      browser_use_task_id: taskId,
      browser_use_session_id: sessionId,
      run: updated ?? run,
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
