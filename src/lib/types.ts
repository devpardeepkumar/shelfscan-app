export type ScrapeStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type ScrapeRun = {
  id: string;
  browser_use_task_id: string | null;
  browser_use_session_id: string | null;
  status: ScrapeStatus;
  error: string | null;
  books_count: number;
  created_at: string;
  updated_at: string;
};

export type ScrapeResult = {
  id: string;
  run_id: string;
  title: string;
  price: string;
  link: string;
  created_at: string;
};
