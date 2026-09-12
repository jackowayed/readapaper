import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import type { Article, ArticleSummary } from "./types";
import { countWords } from "./text";
import { clampOffset, fractionToOffset, offsetToFraction } from "./progress-sync";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "articles.json");

async function readAll(): Promise<Article[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Lazy migration: backfill canonical offset fields for rows written
    // before unified progress (in-memory only, no rewrite on load).
    return (parsed as Article[]).map((a) => {
      const textLength = typeof a.text === "string" ? a.text.length : 0;
      const progress = typeof a.progress === "number" ? a.progress : 0;
      const progressOffset =
        typeof a.progressOffset === "number" && Number.isFinite(a.progressOffset)
          ? a.progressOffset
          : clampOffset(Math.round(progress * textLength), textLength);
      const progressUpdatedAt =
        typeof a.progressUpdatedAt === "string" || a.progressUpdatedAt === null
          ? a.progressUpdatedAt
          : null;
      const archived = typeof a.archived === "boolean" ? a.archived : false;
      const archivedAt =
        typeof a.archivedAt === "string" || a.archivedAt === null ? a.archivedAt : null;
      return { ...a, progress, progressOffset, progressUpdatedAt, archived, archivedAt };
    });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
}

async function writeAll(articles: Article[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(articles, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

export function toSummary(a: Article): ArticleSummary {
  const {
    id,
    url,
    title,
    byline,
    excerpt,
    wordCount,
    progress,
    progressOffset,
    archived,
    archivedAt,
    createdAt,
  } = a;
  return {
    id,
    url,
    title,
    byline,
    excerpt,
    wordCount,
    progress,
    progressOffset,
    archived,
    archivedAt,
    createdAt,
  };
}

export async function listArticles(filter?: { archived?: boolean }): Promise<Article[]> {
  const all = await readAll();
  const filtered =
    filter && typeof filter.archived === "boolean"
      ? all.filter((a) => a.archived === filter.archived)
      : all;
  return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getArticle(id: string): Promise<Article | null> {
  const all = await readAll();
  return all.find((a) => a.id === id) ?? null;
}

/** Canonical key for dedup: host lowercased, fragment stripped, trailing slash dropped. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

export async function findArticleByUrl(url: string): Promise<Article | null> {
  const key = normalizeUrl(url);
  const all = await readAll();
  return all.find((a) => normalizeUrl(a.url) === key) ?? null;
}

/**
 * Create an article unless one with the same URL already exists. Returns
 * `{ article, created }` so callers can report duplicates.
 */
export async function createArticle(input: {
  url: string;
  title: string;
  byline: string | null;
  excerpt: string | null;
  html: string;
  text: string;
}): Promise<{ article: Article; created: boolean }> {
  const existing = await findArticleByUrl(input.url);
  if (existing) return { article: existing, created: false };
  const all = await readAll();
  const now = new Date().toISOString();
  const article: Article = {
    id: nanoid(12),
    url: input.url,
    title: input.title || "Untitled",
    byline: input.byline,
    excerpt: input.excerpt,
    html: input.html,
    text: input.text,
    wordCount: countWords(input.text),
    progress: 0,
    progressOffset: 0,
    progressUpdatedAt: null,
    archived: false,
    archivedAt: null,
    createdAt: now,
  };
  all.push(article);
  await writeAll(all);
  return { article, created: true };
}

export async function deleteArticle(id: string): Promise<boolean> {
  const all = await readAll();
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  await writeAll(next);
  return true;
}

/**
 * Set the canonical char-offset position. Recomputes the derived `progress`
 * fraction mirror and stamps `progressUpdatedAt`. Returns the updated
 * `{ offset, progress }`, or `null` when the id is unknown.
 */
export async function updateProgressOffset(
  id: string,
  offset: number
): Promise<{ offset: number; progress: number } | null> {
  const all = await readAll();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  const textLength = typeof found.text === "string" ? found.text.length : 0;
  const clamped = clampOffset(offset, textLength);
  found.progressOffset = clamped;
  found.progress = offsetToFraction(clamped, textLength);
  found.progressUpdatedAt = new Date().toISOString();
  await writeAll(all);
  return { offset: found.progressOffset, progress: found.progress };
}

export async function updateProgress(id: string, progress: number): Promise<boolean> {
  const existing = await getArticle(id);
  if (!existing) return false;
  const textLength = typeof existing.text === "string" ? existing.text.length : 0;
  const offset = fractionToOffset(progress, textLength);
  const res = await updateProgressOffset(id, offset);
  return res !== null;
}

/**
 * Flip the archived flag, stamping `archivedAt` on archive and clearing it
 * on unarchive. Returns the updated article, or `null` when unknown.
 */
export async function setArchived(id: string, archived: boolean): Promise<Article | null> {
  const all = await readAll();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  found.archived = archived;
  found.archivedAt = archived ? new Date().toISOString() : null;
  await writeAll(all);
  return found;
}
