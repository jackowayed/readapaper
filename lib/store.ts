import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import type { Article, ArticleSummary } from "./types";
import { countWords } from "./text";
import { clampOffset, fractionToOffset, offsetToFraction } from "./progress-sync";
import { ArticleSchema } from "./schemas";

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
    // Non-object rows (null, strings, …) can never migrate — drop them with
    // a count instead of crashing every route on first property access.
    const rows = (parsed as unknown[]).filter(
      (row): row is Article => typeof row === "object" && row !== null
    );
    if (rows.length !== parsed.length) {
      console.error(`[store] ignoring ${parsed.length - rows.length} non-object rows`);
    }
    // Lazy migration: backfill canonical offset fields for rows written
    // before unified progress (in-memory only, no rewrite on load).
    const migrated = rows.map((a) => {
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
      const liked = typeof a.liked === "boolean" ? a.liked : false;
      const likedAt = typeof a.likedAt === "string" || a.likedAt === null ? a.likedAt : null;
      const deleted = typeof a.deleted === "boolean" ? a.deleted : false;
      const deletedAt =
        typeof a.deletedAt === "string" || a.deletedAt === null ? a.deletedAt : null;
      return {
        ...a,
        progress,
        progressOffset,
        progressUpdatedAt,
        archived,
        archivedAt,
        liked,
        likedAt,
        deleted,
        deletedAt,
      };
    });
    // Schema gate: rows that still don't validate (hand-edited damage beyond
    // what migration repairs) are quarantined with their id logged — serving
    // a malformed row crashes renderers downstream, so fail safe, not loud.
    // Note: the next write rewrites the file without quarantined rows.
    const valid = migrated.filter((a) => {
      if (ArticleSchema.safeParse(a).success) return true;
      console.error(
        `[store] quarantining invalid article row id=${typeof a.id === "string" ? a.id : "unknown"}`
      );
      return false;
    });
    if (valid.length !== migrated.length) {
      console.error(`[store] quarantined ${migrated.length - valid.length} invalid article rows`);
    }
    return valid;
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
    liked,
    likedAt,
    deleted,
    deletedAt,
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
    liked,
    likedAt,
    deleted,
    deletedAt,
    createdAt,
  };
}

export type SortKey = "newest" | "oldest" | "longest" | "shortest" | "progress";

export async function listArticles(filter?: {
  archived?: boolean;
  liked?: boolean;
  deleted?: boolean;
  q?: string;
  sort?: SortKey;
}): Promise<Article[]> {
  const all = await readAll();
  // Soft-deleted rows are hidden by default in every scope; pass
  // { deleted: true } for the trash scope or { deleted: false } explicitly.
  const visible =
    filter && typeof filter.deleted === "boolean"
      ? all.filter((a) => a.deleted === filter.deleted)
      : all.filter((a) => !a.deleted);
  const filtered =
    filter && typeof filter.archived === "boolean"
      ? visible.filter((a) => a.archived === filter.archived)
      : visible;
  const liked =
    filter && typeof filter.liked === "boolean"
      ? filtered.filter((a) => a.liked === filter.liked)
      : filtered;
  const needle = typeof filter?.q === "string" ? filter.q.trim().toLowerCase() : "";
  const searched =
    needle === ""
      ? liked
      : liked.filter((a) =>
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

/**
 * Query params that never identify page content — marketing, analytics, and
 * ad-click IDs. Anything NOT on this list (or matching a prefix below) is
 * preserved, so site params like `?page=2`, `?id=123`, or `?story=slug`
 * keep distinguishing pages.
 */
const TRACKING_PARAM_NAMES = new Set([
  // Google / generic ads
  "gclid",
  "gclsrc",
  "dclid",
  "wbraid",
  "gbraid",
  "gad_source",
  "srsltid",
  // Meta
  "fbclid",
  "fb_action_ids",
  "fb_action_types",
  "fb_source",
  "fb_ref",
  // Microsoft / TikTok / Twitter / Yahoo / LinkedIn
  "msclkid",
  "ttclid",
  "twclid",
  "yclid",
  "li_fat_id",
  // Instagram / Mailchimp / Marketo / HubSpot / Vero / misc
  "igshid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "hscam",
  "hsctatracking",
  "vero_conv",
  "vero_id",
  "dm_i",
  "oly_anon_id",
  "oly_enc_id",
  "rb_clickid",
  "c_id",
  "_ga",
  "_gl",
  "_ke",
  // Bare "ref" variants (share-tracking); namespaced or page-scoped
  // ref-* params from specific sites are preserved.
  "ref",
  "ref_src",
  "ref_source",
  // Matomo / Piwik / Adobe Analytics campaign params
  "pk_campaign",
  "pk_kwd",
  "pk_source",
  "pk_medium",
  "pk_content",
  "piwik_campaign",
  "piwik_kwd",
  "piwik_source",
  "piwik_medium",
  "sc_campaign",
  "sc_channel",
  "sc_content",
  "sc_medium",
  "sc_outcome",
  "sc_regionid",
  "sc_trk",
  "s_cid",
]);

/** Prefixes whose whole family is tracking (`utm_source`, `hsa_kw`, …). */
const TRACKING_PARAM_PREFIXES = ["utm_", "hsa_"];

function isTrackingParam(name: string): boolean {
  const k = name.toLowerCase();
  return TRACKING_PARAM_NAMES.has(k) || TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Canonical key for dedup: scheme unified to https, host lowercased with
 * leading `www.` dropped, fragment stripped, tracking params removed,
 * remaining params sorted (order-insensitive), trailing slash dropped.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    // http and https serve the same page for dedup purposes.
    if (u.protocol === "http:" || u.protocol === "https:") u.protocol = "https:";
    const host = u.hostname.toLowerCase();
    u.hostname = host.startsWith("www.") ? host.slice(4) : host;
    for (const key of [...u.searchParams.keys()]) {
      if (isTrackingParam(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
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
  // Dedup matches non-deleted rows only: re-saving a trashed URL
  // creates a fresh article instead of resurrecting the trashed one.
  return all.find((a) => !a.deleted && normalizeUrl(a.url) === key) ?? null;
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
    liked: false,
    likedAt: null,
    deleted: false,
    deletedAt: null,
    createdAt: now,
  };
  all.push(article);
  // Defensive: constructed rows must satisfy the stored-row schema. A failure
  // here is a server bug (not client input), so throwing to 500 is correct.
  ArticleSchema.parse(article);
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

/**
 * Flip the liked flag, stamping `likedAt` on like and clearing it on
 * unlike. Returns the updated article, or `null` when unknown.
 */
async function setLikedUnsafe(id: string, liked: boolean): Promise<Article | null> {
  const all = await readAll();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  found.liked = liked;
  found.likedAt = liked ? new Date().toISOString() : null;
  await writeAll(all);
  return found;
}

export async function setLiked(id: string, liked: boolean): Promise<Article | null> {
  return withLock(() => setLikedUnsafe(id, liked));
}

/**
 * Soft-delete (trash) or restore an article, stamping `deletedAt` on trash
 * and clearing it on restore. Returns the updated article, or `null` when
 * unknown.
 */
async function setDeletedUnsafe(id: string, deleted: boolean): Promise<Article | null> {
  const all = await readAll();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  found.deleted = deleted;
  found.deletedAt = deleted ? new Date().toISOString() : null;
  await writeAll(all);
  return found;
}

export async function setDeleted(id: string, deleted: boolean): Promise<Article | null> {
  return withLock(() => setDeletedUnsafe(id, deleted));
}
