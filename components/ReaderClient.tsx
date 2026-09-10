"use client";
import { useState } from "react";
import type { Article } from "@/lib/types";
import SyncedReader from "./SyncedReader";
import { useReadingProgress } from "./ThemeControl";

export default function ReaderClient({ article }: { article: Article }) {
  const [mode, setMode] = useState<"read" | "listen">("read");
  useReadingProgress(article.id, article.progress);

  return (
    <div>
      <div className="mode-toggle" role="tablist" aria-label="Read or listen">
        <button className={mode === "read" ? "primary" : ""} onClick={() => setMode("read")}>
          📖 Read
        </button>
        <button className={mode === "listen" ? "primary" : ""} onClick={() => setMode("listen")}>
          🎧 Listen in sync
        </button>
      </div>

      {mode === "read" ? (
        <article
          className="article-body"
          // Sanitized server-side with DOMPurify allowlist (see lib/extract.ts)
          dangerouslySetInnerHTML={{ __html: article.html }}
        />
      ) : (
        <SyncedReader text={article.text} />
      )}
    </div>
  );
}
