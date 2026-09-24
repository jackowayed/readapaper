"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ArticleSummary } from "@/lib/types";
import { readingMinutes } from "@/lib/text";
import { enqueue, QUEUE_CHANGE_EVENT, readQueue } from "@/lib/listen-queue";

export default function ArticleList({
  articles,
  emptyLabel = "Nothing saved yet. Paste a URL above.",
}: {
  articles: ArticleSummary[];
  emptyLabel?: string;
}) {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Queued ids for the per-article "Add to queue" labels (idempotent:
  // re-adding is a no-op in lib). Same-tab mutations broadcast, so this
  // stays fresh when the queue changes elsewhere.
  const [queuedIds, setQueuedIds] = useState<string[]>([]);
  useEffect(() => {
    const refresh = () => setQueuedIds(readQueue());
    refresh();
    window.addEventListener(QUEUE_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(QUEUE_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  function onQueue(id: string) {
    setQueuedIds(enqueue(id));
  }

  function clearError(id: string) {
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function fail(id: string, action: string, status: number | null) {
    setErrors((prev) => ({
      ...prev,
      [id]:
        status === null
          ? `${action} failed: network error. Try again.`
          : `${action} failed (${status}). Try again.`,
    }));
  }

  async function onLike(id: string, liked: boolean) {
    clearError(id);
    const action = liked ? "Like" : "Unlike";
    let res: Response;
    try {
      res = await fetch(`/api/articles/${id}/like`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liked }),
      });
    } catch {
      fail(id, action, null);
      return;
    }
    if (!res.ok) {
      fail(id, action, res.status);
      return;
    }
    router.refresh();
  }

  async function onTrash(id: string, deleted: boolean) {
    clearError(id);
    const action = deleted ? "Trash" : "Restore";
    let res: Response;
    try {
      res = await fetch(`/api/articles/${id}/trash`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleted }),
      });
    } catch {
      fail(id, action, null);
      return;
    }
    if (!res.ok) {
      fail(id, action, res.status);
      return;
    }
    router.refresh();
  }

  async function onDeleteForever(id: string) {
    if (!confirm("Permanently delete this article? This cannot be undone.")) return;
    clearError(id);
    let res: Response;
    try {
      res = await fetch(`/api/articles/${id}?permanent=1`, { method: "DELETE" });
    } catch {
      fail(id, "Delete forever", null);
      return;
    }
    if (!res.ok) {
      fail(id, "Delete forever", res.status);
      return;
    }
    router.refresh();
  }
  async function onArchive(id: string, archived: boolean) {
    clearError(id);
    const action = archived ? "Archive" : "Unarchive";
    let res: Response;
    try {
      res = await fetch(`/api/articles/${id}/archive`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
    } catch {
      fail(id, action, null);
      return;
    }
    if (!res.ok) {
      fail(id, action, res.status);
      return;
    }
    router.refresh();
  }

  if (!articles.length) {
    return <p className="muted">{emptyLabel}</p>;
  }

  return (
    <ul className="list">
      {articles.map((a) => (
        <li key={a.id} className="card">
          <a className="title" href={`/a/${a.id}`}>
            {a.title}
          </a>
          {a.excerpt && <p>{a.excerpt}</p>}
          <div className="row">
            <span className="muted">
              {a.wordCount.toLocaleString()} words · {readingMinutes(a.wordCount)} min
              {a.progress > 0 ? ` · ${Math.round(a.progress * 100)}% read` : ""}
            </span>
            {a.archived ? (
              <button onClick={() => onArchive(a.id, false)} aria-label={`Unarchive ${a.title}`}>
                Unarchive
              </button>
            ) : (
              <button onClick={() => onArchive(a.id, true)} aria-label={`Archive ${a.title}`}>
                Archive
              </button>
            )}
            {a.liked ? (
              <button onClick={() => onLike(a.id, false)} aria-label={`Unlike ${a.title}`}>
                Unlike
              </button>
            ) : (
              <button onClick={() => onLike(a.id, true)} aria-label={`Like ${a.title}`}>
                Like
              </button>
            )}
            {a.deleted ? (
              <button onClick={() => onTrash(a.id, false)} aria-label={`Restore ${a.title}`}>
                Restore
              </button>
            ) : (
              <button onClick={() => onTrash(a.id, true)} aria-label={`Trash ${a.title}`}>
                Trash
              </button>
            )}
            {a.deleted && (
              <button
                onClick={() => onDeleteForever(a.id)}
                aria-label={`Delete forever ${a.title}`}
              >
                Delete forever
              </button>
            )}
            <button onClick={() => onQueue(a.id)} aria-label={`Add to queue ${a.title}`}>
              {queuedIds.includes(a.id) ? "✓ Queued" : "+ Queue"}
            </button>
          </div>
          {errors[a.id] && (
            <p className="error" role="alert">
              {errors[a.id]}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
