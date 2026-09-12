import type { Article } from "./types";

/** Hard-cap for the compiled Send-to-Kindle document (~40MB, under Amazon's 50MB mail limit). */
export const KINDLE_MAX_BYTES = 40 * 1024 * 1024;

/** Default batch size: latest N active articles in one document. */
export const DEFAULT_KINDLE_LIMIT = 50;

export type KindleBatch = {
  articles: Article[];
  totalActive: number;
};

export type CompiledKindleDoc = {
  html: string;
  bytes: number;
  count: number;
};

export type KindleConfig = {
  kindleEmail: string;
  fromEmail: string;
  subject?: string;
};

export type KindleAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type KindleMailMessage = {
  to: string;
  from: string;
  subject: string;
  attachments: KindleAttachment[];
};

export type KindleSender = (message: KindleMailMessage) => Promise<unknown>;

// TODO(archive): "active" is a fallback until docs/archive.md lands —
// currently `archived !== true` so all unarchived/legacy articles qualify.
// Once archiving exists, align this predicate with the archive spec
// instead of reimplementing it here.
function isActive(article: Article): boolean {
  return (article as Article & { archived?: unknown }).archived !== true;
}

function compareNewestFirst(a: Article, b: Article): number {
  if (a.createdAt < b.createdAt) return 1;
  if (a.createdAt > b.createdAt) return -1;
  return 0;
}

/**
 * Select the latest `limit` active articles, newest (`createdAt` desc) first.
 * Returns the batch plus `totalActive` so callers can say "50 of 132".
 */
export function getKindleBatch(articles: Article[], limit = DEFAULT_KINDLE_LIMIT): KindleBatch {
  const active = articles.filter(isActive).sort(compareNewestFirst);
  return {
    articles: active.slice(0, Math.max(0, limit)),
    totalActive: active.length,
  };
}

/** Escape text for insertion into HTML text nodes / attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Anchor id for an article chapter. Sanitized so arbitrary ids stay valid fragment targets. */
export function kindleAnchorId(article: Article, index: number): string {
  const safe = article.id.replace(/[^A-Za-z0-9_-]/g, "-") || `index-${index}`;
  return `kindle-article-${safe}`;
}

/**
 * Compile articles into one HTML document: title page, TOC with anchors,
 * one chapter per article (title/byline/URL escaped at the boundary,
 * sanitized `html` reused as-is). Refuses over `maxBytes` with a clear error.
 */
export function compileKindleHtml(
  articles: Article[],
  opts?: { maxBytes?: number }
): CompiledKindleDoc {
  const maxBytes = opts?.maxBytes ?? KINDLE_MAX_BYTES;
  const today = new Date().toISOString().slice(0, 10);

  const toc = articles
    .map((a, i) => {
      const anchor = kindleAnchorId(a, i);
      return `<li><a href="#${escapeHtml(anchor)}">${escapeHtml(a.title)}</a></li>`;
    })
    .join("\n");

  const chapters = articles
    .map((a, i) => {
      const anchor = kindleAnchorId(a, i);
      const byline = a.byline ? `<p class="byline">${escapeHtml(a.byline)}</p>` : "";
      return [
        `<section id="${escapeHtml(anchor)}" class="chapter">`,
        `<h2>${escapeHtml(a.title)}</h2>`,
        byline,
        `<p class="source"><a href="${escapeHtml(a.url)}">${escapeHtml(a.url)}</a></p>`,
        `<div class="content">${a.html}</div>`,
        `</section>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n<hr />\n");

  const html = [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head><meta charset="utf-8" /><title>${escapeHtml(`Readapaper Kindle Export — ${articles.length} articles`)}</title></head>`,
    `<body>`,
    `<header class="title-page"><h1>Readapaper Kindle Export</h1>`,
    `<p>${escapeHtml(today)} — ${articles.length} article${articles.length === 1 ? "" : "s"}</p></header>`,
    `<nav class="toc"><h2>Contents</h2><ul>`,
    toc,
    `</ul></nav>`,
    `<hr />`,
    chapters,
    `</body>`,
    `</html>`,
  ].join("\n");

  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBytes) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const capMb = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new Error(
      `Kindle document is ${mb}MB, over the ${capMb}MB limit. ` +
        `Send fewer or more recent articles (the batch holds ${articles.length}).`
    );
  }

  return { html, bytes, count: articles.length };
}

/**
 * Deliver a compiled document via an injected sender so tests never touch
 * SMTP. The `send` implementation defaults to a nodemailer transport in the
 * route (Phase 1) — this module must NOT import nodemailer.
 */
export async function sendToKindle(
  send: KindleSender,
  compiled: CompiledKindleDoc,
  config: KindleConfig
): Promise<{ to: string; count: number; bytes: number }> {
  const subject = config.subject ?? `Readapaper Kindle Export — ${compiled.count} articles`;
  await send({
    to: config.kindleEmail,
    from: config.fromEmail,
    subject,
    attachments: [
      {
        filename: "readapaper-kindle.html",
        content: compiled.html,
        contentType: "text/html",
      },
    ],
  });
  return { to: config.kindleEmail, count: compiled.count, bytes: compiled.bytes };
}
