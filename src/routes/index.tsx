import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "ShelfScan" },
      { name: "description", content: "ShelfScan — a blank starting point, ready to build on." },
      { property: "og:title", content: "ShelfScan" },
      {
        property: "og:description",
        content: "ShelfScan — a blank starting point, ready to build on.",
      },
    ],
  }),
});

function Index() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">ShelfScan</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Blank app ready — tell me what to build next.
        </p>
      </div>
    </main>
  );
}
