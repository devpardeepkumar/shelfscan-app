import { useCallback, useEffect, useRef, useState } from "react";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import type { ScrapeResult, ScrapeRun } from "../lib/types";

const QUEUED_MAX_MS = 45_000;
const RUNNING_MAX_MS = 8 * 60_000;
/** Sync Browser Use → Supabase while running (not empty scrape_results spam). */
const SYNC_INTERVAL_MS = 10_000;

export function useLiveScrape() {
  const [runs, setRuns] = useState<ScrapeRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [results, setResults] = useState<ScrapeResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const syncInFlight = useRef(false);

  const activeRunIdRef = useRef<string | null>(null);
  activeRunIdRef.current = activeRunId;

  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null;
  const live = isActivelyScraping(activeRun);

  const loadRuns = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    const { data, error: qErr } = await supabase
      .from("scrape_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(12);

    if (qErr) {
      setError(formatSchemaError(qErr.message));
      setLoading(false);
      return;
    }

    const list = (data ?? []) as ScrapeRun[];
    setRuns(list);
    setActiveRunId((prev) => {
      if (prev && list.some((r) => r.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
    setLoading(false);
  }, []);

  const loadResults = useCallback(async (runId: string) => {
    if (!supabase) return;

    const { data, error: qErr } = await supabase
      .from("scrape_results")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: true });

    if (qErr) {
      setError(formatSchemaError(qErr.message));
      return;
    }

    setResults((data ?? []) as ScrapeResult[]);
  }, []);

  const syncActiveRun = useCallback(async (runId: string) => {
    if (!supabase || syncInFlight.current) return;
    syncInFlight.current = true;
    try {
      const { data, error: syncError } = await supabase.functions.invoke(
        "sync-scrape",
        { method: "POST", body: { run_id: runId } },
      );
      if (syncError) {
        console.warn("sync-scrape failed", syncError.message);
        return;
      }
      if (data?.error) {
        console.warn("sync-scrape error", data.error);
        return;
      }
      await loadRuns();
      if (data?.status === "completed" || (data?.books_count ?? 0) > 0) {
        await loadResults(runId);
      }
    } finally {
      syncInFlight.current = false;
    }
  }, [loadRuns, loadResults]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setClock((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, [live]);

  useEffect(() => {
    if (!activeRunId || !activeRun) {
      setResults([]);
      return;
    }
    if (activeRun.status === "queued" || activeRun.status === "running") {
      // Don't hammer empty scrape_results while waiting — sync-scrape fills them.
      if (activeRun.status === "queued") setResults([]);
      return;
    }
    void loadResults(activeRunId);
  }, [activeRunId, activeRun?.status, activeRun, loadResults]);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;

    const channel = client
      .channel("shelfscan-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scrape_runs" },
        (payload) => {
          const row = payload.new as ScrapeRun | undefined;
          if (!row?.id) return;

          setRuns((prev) => {
            const without = prev.filter((r) => r.id !== row.id);
            return [row, ...without].sort(
              (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime(),
            );
          });

          const current = activeRunIdRef.current;
          if (!current || current === row.id || isActivelyScraping(row)) {
            setActiveRunId(row.id);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scrape_results" },
        (payload) => {
          const row = payload.new as ScrapeResult | undefined;
          if (!row?.run_id || row.run_id !== activeRunIdRef.current) return;
          void loadResults(row.run_id);
        },
      )
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, [loadResults]);

  // While live: sync from Browser Use (writes results) + refresh runs list.
  // Do NOT poll empty scrape_results in a tight loop.
  useEffect(() => {
    if (!supabase || !activeRun || !live || !activeRunId) return;

    void syncActiveRun(activeRunId);
    void loadRuns();

    const id = window.setInterval(() => {
      void syncActiveRun(activeRunId);
      void loadRuns();
    }, SYNC_INTERVAL_MS);

    return () => window.clearInterval(id);
  }, [activeRun, activeRunId, live, loadRuns, syncActiveRun]);

  const startScrape = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) {
      setError(
        "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
      );
      return;
    }

    setStarting(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke(
        "start-scrape",
        { method: "POST", body: {} },
      );

      if (fnError) throw new Error(fnError.message);
      if (data?.error) {
        throw new Error(
          typeof data.detail === "string"
            ? `${data.error}: ${data.detail}`
            : String(data.error),
        );
      }

      const runId = data?.run_id as string | undefined;
      if (runId) {
        setActiveRunId(runId);
        setResults([]);
      }

      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start scrape");
    } finally {
      setStarting(false);
    }
  }, [loadRuns]);

  return {
    runs,
    activeRun,
    activeRunId,
    setActiveRunId,
    results,
    loading,
    starting,
    error,
    startScrape,
    configured: isSupabaseConfigured,
    live,
  };
}

function isActivelyScraping(run: ScrapeRun | null | undefined): boolean {
  if (!run) return false;
  const started = new Date(run.updated_at || run.created_at).getTime();
  if (!Number.isFinite(started)) return false;
  const age = Date.now() - started;
  if (run.status === "running") return age < RUNNING_MAX_MS;
  if (run.status === "queued") return age < QUEUED_MAX_MS;
  return false;
}

function formatSchemaError(message: string): string {
  if (
    /PGRST205/i.test(message) ||
    /Could not find the table/i.test(message) ||
    (/schema cache/i.test(message) && /not find|does not exist/i.test(message))
  ) {
    return (
      "Required tables are missing (scrape_runs / scrape_results). " +
      "Apply the SQL migrations in supabase/migrations via Supabase SQL Editor."
    );
  }
  return message;
}
