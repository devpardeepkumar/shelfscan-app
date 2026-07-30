import { useLiveScrape } from "./hooks/useLiveScrape";
import type { ScrapeResult, ScrapeRun, ScrapeStatus } from "./lib/types";

export default function App() {
  const {
    runs,
    activeRun,
    activeRunId,
    setActiveRunId,
    results,
    loading,
    starting,
    error,
    startScrape,
    configured,
    live,
  } = useLiveScrape();

  const isLive = live || starting;

  return (
    <div className="page">
      <div className="atmosphere" aria-hidden="true" />

      <header className="topbar">
        <div className="brand-block">
          <p className="brand">ShelfScan</p>
          <p className="brand-sub">Live scrape console for books.toscrape.com</p>
        </div>
        <button
          className="scrape-btn"
          type="button"
          onClick={() => void startScrape()}
          disabled={starting || isLive || !configured}
        >
          {starting || isLive ? (
            <>
              <span className="pulse" />
              {starting ? "Starting…" : "Scraping…"}
            </>
          ) : (
            "Scrape now"
          )}
        </button>
      </header>

      <main className="layout">
        <section className="status-panel">
          <div className="section-head">
            <h1>Run status</h1>
            <p>Button → Edge Function → Browser Use → webhook → Supabase</p>
          </div>

          {!configured && (
            <div className="banner warn">
              Connect Supabase env vars (`VITE_SUPABASE_URL`,
              `VITE_SUPABASE_ANON_KEY`) to enable live scraping.
            </div>
          )}

          {error && <div className="banner error">{error}</div>}

          <div className={`live-card ${isLive ? "is-live" : ""}`}>
            <div className="live-row">
              <StatusBadge status={activeRun?.status ?? null} live={isLive} />
              <span className="meta">
                {activeRun
                  ? `Updated ${formatTime(activeRun.updated_at)}`
                  : loading
                    ? "Loading…"
                    : "No runs yet"}
              </span>
            </div>

            {activeRun && (
              <dl className="meta-grid">
                <div>
                  <dt>Run ID</dt>
                  <dd className="mono">{shortId(activeRun.id)}</dd>
                </div>
                <div>
                  <dt>Browser Use task</dt>
                  <dd className="mono">
                    {activeRun.browser_use_task_id
                      ? shortId(activeRun.browser_use_task_id)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Books saved</dt>
                  <dd>{activeRun.books_count}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{formatTime(activeRun.created_at)}</dd>
                </div>
              </dl>
            )}

            {activeRun?.error && (
              <p className="run-error">{activeRun.error}</p>
            )}

            {isLive && (
              <div className="progress-track" aria-hidden="true">
                <div className="progress-bar" />
              </div>
            )}
          </div>

          {runs.length > 0 && (
            <div className="run-list">
              <h2>Recent runs</h2>
              <ul>
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      className={run.id === activeRunId ? "active" : ""}
                      onClick={() => setActiveRunId(run.id)}
                    >
                      <StatusBadge status={run.status} live={false} compact />
                      <span className="mono">{shortId(run.id)}</span>
                      <span className="muted">{formatTime(run.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="results-panel">
          <div className="section-head">
            <h1>Scraped books</h1>
            <p>title · price · link — minimum 10 rows from Browser Use</p>
          </div>

          <ResultsTable results={results} run={activeRun} loading={loading} />
        </section>
      </main>
    </div>
  );
}

function ResultsTable({
  results,
  run,
  loading,
}: {
  results: ScrapeResult[];
  run: ScrapeRun | null;
  loading: boolean;
}) {
  if (loading && !run) {
    return <div className="empty">Loading dashboard…</div>;
  }

  if (!results.length) {
    return (
      <div className="empty">
        {run?.status === "running" || run?.status === "queued"
          ? "Scrape in progress — results will appear here when the webhook writes to Supabase."
          : "No results yet. Click Scrape now to start a Browser Use cloud run."}
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Price</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row, i) => (
            <tr key={row.id} style={{ animationDelay: `${i * 40}ms` }}>
              <td>{i + 1}</td>
              <td>{row.title}</td>
              <td className="price">{row.price}</td>
              <td>
                <a href={row.link} target="_blank" rel="noreferrer">
                  Open
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({
  status,
  live,
  compact = false,
}: {
  status: ScrapeStatus | null;
  live: boolean;
  compact?: boolean;
}) {
  const label = status ?? "idle";
  return (
    <span className={`badge status-${label} ${live ? "live" : ""} ${compact ? "compact" : ""}`}>
      {live && <span className="dot" />}
      {label}
    </span>
  );
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatTime(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
