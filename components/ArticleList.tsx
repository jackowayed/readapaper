"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ArticleSummary } from "@/lib/types";
import { readingMinutes } from "@/lib/text";

export default function ArticleList({ articles }: { articles: ArticleSummary[] }) {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  async function onDelete(id: string) {
    if (!confirm("Delete this article?")) return;
    clearError(id);
    let res: Response;
    try {
      res = await fetch(`/api/articles/${id}`, { method: "DELETE" });
    } catch {
      fail(id, "Delete", null);
      return;
    }
    if (!res.ok) {
      fail(id, "Delete", res.status);
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
    return <p className="muted">Nothing saved yet. Paste a URL above.</p>;
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
            <button onClick={() => onDelete(a.id)} aria-label={`Delete ${a.title}`}>
              Delete
            </button>
            {a.archived ? (
              <button onClick={() => onArchive(a.id, false)} aria-label={`Unarchive ${a.title}`}>
                Unarchive
              </button>
            ) : (
              <button onClick={() => onArchive(a.id, true)} aria-label={`Archive ${a.title}`}>
                Archive
              </button>
            )}
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
