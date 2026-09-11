import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import type { Article, ArticleSummary } from "./types";
import { countWords } from "./text";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "articles.json");

async function readAll(): Promise<Article[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
  const { id, url, title, byline, excerpt, wordCount, progress, createdAt } = a;
  return { id, url, title, byline, excerpt, wordCount, progress, createdAt };
}

export async function listArticles(): Promise<Article[]> {
  const all = await readAll();
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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

export async function updateProgress(id: string, progress: number): Promise<boolean> {
  const all = await readAll();
  const found = all.find((a) => a.id === id);
  if (!found) return false;
  found.progress = Math.min(1, Math.max(0, progress));
  await writeAll(all);
  return true;
}
