"use client";
import { useEffect, useRef } from "react";

export default function ThemeControl() {
  useEffect(() => {
    const saved = localStorage.getItem("theme") || "light";
    document.documentElement.dataset.theme = saved;
  }, []);

  function setTheme(t: string) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("theme", t);
    const size = localStorage.getItem("fontScale") || "100";
    document.documentElement.style.fontSize = `${(16 * Number(size)) / 100}px`;
  }

  function adjustFont(delta: number) {
    const cur = Number(localStorage.getItem("fontScale") || "100");
    const next = Math.min(150, Math.max(80, cur + delta));
    localStorage.setItem("fontScale", String(next));
    document.documentElement.style.fontSize = `${(16 * next) / 100}px`;
  }

  useEffect(() => {
    const size = localStorage.getItem("fontScale") || "100";
    document.documentElement.style.fontSize = `${(16 * Number(size)) / 100}px`;
  }, []);

  return (
    <div style={{ display: "flex", gap: "0.4rem" }}>
      <button onClick={() => setTheme("light")} title="Light">
        ☀
      </button>
      <button onClick={() => setTheme("sepia")} title="Sepia">
        📜
      </button>
      <button onClick={() => setTheme("dark")} title="Dark">
        🌙
      </button>
      <button onClick={() => adjustFont(-10)} title="Smaller">
        A-
      </button>
      <button onClick={() => adjustFont(10)} title="Larger">
        A+
      </button>
    </div>
  );
}

// Hook: persist + restore reading progress for an article.
export function useReadingProgress(articleId: string, initial: number) {
  const saved = useRef(false);
  useEffect(() => {
    if (!saved.current && initial > 0 && initial < 0.95) {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, h * initial);
      saved.current = true;
    }
  }, [initial]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    function onScroll() {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        const h = document.documentElement.scrollHeight - window.innerHeight;
        if (h <= 0) return;
        const p = Math.min(1, Math.max(0, window.scrollY / h));
        fetch(`/api/articles/${articleId}/progress`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ progress: p }),
        }).catch(() => {});
      }, 600);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [articleId]);
}
