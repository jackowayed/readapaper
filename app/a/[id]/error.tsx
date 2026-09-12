"use client";

/**
 * Reader error boundary (listen-reliability Phase 1): a dead server or a
 * failed article load must never look like a silent listen failure — show
 * an audible error with retry instead of the generic Next error.
 */
export default function ArticleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="narrow">
      <h1>Couldn&apos;t load this article</h1>
      <p role="alert" className="muted">
        {error?.message ? `Something went wrong: ${error.message}` : "Something went wrong."} Your
        listening position was kept — retry to continue.
      </p>
      <div className="controls">
        <button className="primary" onClick={() => reset()}>
          ↻ Retry
        </button>
      </div>
    </main>
  );
}
