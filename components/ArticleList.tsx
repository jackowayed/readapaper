"use client";
import { useRouter } from "next/navigation";
import type { ArticleSummary } from "@/lib/types";
import { readingMinutes } from "@/lib/text";

export default function ArticleList({ articles }: { articles: ArticleSummary[] }) {
  const router = useRouter();

  async function onDelete(id: string) {
    if (!confirm("Delete this article?")) return;
    await fetch(`/api/articles/${id}`, { method: "DELETE" });
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
          </div>
        </li>
      ))}
    </ul>
  );
}
