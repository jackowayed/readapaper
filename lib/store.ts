import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import type { Article, ArticleSummary } from "./types";
import { countWords } from "./text";
import { clampOffset, fractionToOffset, offsetToFraction } from "./progress-sync";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "articles.json");

// In-process promise-queue mutex serializing read-modify-write ops.
// Read-only ops (readAll, listArticles, getArticle, findArticleByUrl,
// toSummary, normalizeUrl) stay unlocked.
let queue: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(() => fn());
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

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
    if (e instanceof SyntaxError) {
      // Corrupt JSON: back up the bad file (best-effort) and start empty
      // so a single bad write doesn't 500 every route.
      try {
        await fs.rename(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`);
      } catch {
        // ignore rename errors (e.g. already moved by a concurrent reader)
      }
      console.error("[store] articles.json is corrupt; moved to backup and starting empty");
      return [];
    }
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

export type SortKey = "newest" | "oldest" | "longest" | "shortest" | "progress";

export async function listArticles(filter?: {
  archived?: boolean;
  q?: string;
  sort?: SortKey;
}): Promise<Article[]> {
  const all = await readAll();
  const filtered =
    filter && typeof filter.archived === "boolean"
      ? all.filter((a) => a.archived === filter.archived)
      : all;
  const needle = typeof filter?.q === "string" ? filter.q.trim().toLowerCase() : "";
  const searched =
    needle === ""
      ? filtered
      : filtered.filter((a) =>
          [a.title, a.byline, a.excerpt, a.text, a.url].some(
            (field) => typeof field === "string" && field.toLowerCase().includes(needle)
          )
        );
  const sort: SortKey = filter?.sort ?? "newest";
  const newestFirst = (a: Article, b: Article) => (a.createdAt < b.createdAt ? 1 : -1);
  const sorted = [...searched];
  switch (sort) {
    case "oldest":
      sorted.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      break;
    case "longest":
      sorted.sort((a, b) => b.wordCount - a.wordCount || newestFirst(a, b));
      break;
    case "shortest":
      sorted.sort((a, b) => a.wordCount - b.wordCount || newestFirst(a, b));
      break;
    case "progress":
      sorted.sort((a, b) => b.progress - a.progress || newestFirst(a, b));
      break;
    case "newest":
    default:
      sorted.sort(newestFirst);
      break;
  }
  return sorted;
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
async function createArticleUnsafe(input: {
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

export async function createArticle(input: {
  url: string;
  title: string;
  byline: string | null;
  excerpt: string | null;
  html: string;
  text: string;
}): Promise<{ article: Article; created: boolean }> {
  return withLock(() => createArticleUnsafe(input));
}

async function deleteArticleUnsafe(id: string): Promise<boolean> {
  const all = await readAll();
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  await writeAll(next);
  return true;
}

export async function deleteArticle(id: string): Promise<boolean> {
  return withLock(() => deleteArticleUnsafe(id));
}

/**
 * Set the canonical char-offset position. Recomputes the derived `progress`
 * fraction mirror and stamps `progressUpdatedAt`. Returns the updated
 * `{ offset, progress }`, or `null` when the id is unknown.
 */
async function updateProgressOffsetUnsafe(
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

export async function updateProgressOffset(
  id: string,
  offset: number
): Promise<{ offset: number; progress: number } | null> {
  return withLock(() => updateProgressOffsetUnsafe(id, offset));
}

async function updateProgressUnsafe(id: string, progress: number): Promise<boolean> {
  const all = await readAll();
  const found = all.find((a) => a.id === id);
  if (!found) return false;
  const textLength = typeof found.text === "string" ? found.text.length : 0;
  const offset = fractionToOffset(progress, textLength);
  const clamped = clampOffset(offset, textLength);
  found.progressOffset = clamped;
  found.progress = offsetToFraction(clamped, textLength);
  found.progressUpdatedAt = new Date().toISOString();
  await writeAll(all);
  return true;
}

export async function updateProgress(id: string, progress: number): Promise<boolean> {
  return withLock(() => updateProgressUnsafe(id, progress));
}

/**
 * Flip the archived flag, stamping `archivedAt` on archive and clearing it
 * on unarchive. Returns the updated article, or `null` when unknown.
 */
async function setArchivedUnsafe(id: string, archived: boolean): Promise<Article | null> {
  const all = await readAll();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  found.archived = archived;
  found.archivedAt = archived ? new Date().toISOString() : null;
  await writeAll(all);
  return found;
}

export async function setArchived(id: string, archived: boolean): Promise<Article | null> {
  return withLock(() => setArchivedUnsafe(id, archived));
}
