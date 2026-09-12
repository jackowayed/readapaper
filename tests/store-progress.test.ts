import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_CWD = process.cwd();
let tmp = "";
let store: typeof import("../lib/store");

const sample = (url: string, text = "hello world foo bar") => ({
  url,
  title: "Sample Title",
  byline: null as string | null,
  excerpt: null as string | null,
  html: `<p>${text}</p>`,
  text,
});

beforeEach(async () => {
  // lib/store.ts resolves data/articles.json from process.cwd() at import
  // time, so chdir into a temp dir BEFORE (re-)importing it.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-store-progress-"));
  process.chdir(tmp);
  vi.resetModules();
  store = await import("../lib/store");
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("unified progress store", () => {
  it("creates articles with offset 0 + null stamp, visible in summaries", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    expect(article.progressOffset).toBe(0);
    expect(article.progressUpdatedAt).toBeNull();
    const summary = store.toSummary(article);
    expect(summary.progressOffset).toBe(0);
  });

  it("updateProgressOffset sets canonical offset, recomputes fraction, stamps now", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    const len = article.text.length;
    const res = await store.updateProgressOffset(article.id, 5);
    expect(res).toEqual({ offset: 5, progress: 5 / len });
    const got = (await store.getArticle(article.id))!;
    expect(got.progressOffset).toBe(5);
    expect(got.progress).toBe(5 / len);
    expect(typeof got.progressUpdatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(got.progressUpdatedAt as string))).toBe(true);
  });

  it("clamps offsets at both ends and rounds", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    const len = article.text.length;
    expect(await store.updateProgressOffset(article.id, -5)).toEqual({
      offset: 0,
      progress: 0,
    });
    expect(await store.updateProgressOffset(article.id, 10 ** 9)).toEqual({
      offset: len,
      progress: 1,
    });
    expect(await store.updateProgressOffset(article.id, 4.6)).toEqual({
      offset: 5,
      progress: 5 / len,
    });
  });

  it("empty text pins offset and fraction to 0", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a", ""));
    expect(await store.updateProgressOffset(article.id, 50)).toEqual({
      offset: 0,
      progress: 0,
    });
  });

  it("returns null for a missing id", async () => {
    await expect(store.updateProgressOffset("nope", 5)).resolves.toBeNull();
  });

  it("legacy updateProgress delegates via fractionToOffset", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    const len = article.text.length;
    expect(await store.updateProgress(article.id, 0.5)).toBe(true);
    const got = (await store.getArticle(article.id))!;
    expect(got.progressOffset).toBe(Math.round(0.5 * len));
    expect(got.progress).toBe(Math.round(0.5 * len) / len);
    expect(typeof got.progressUpdatedAt).toBe("string");
  });

  it("legacy updateProgress clamps fractions and misses like before", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    const len = article.text.length;
    expect(await store.updateProgress(article.id, 2)).toBe(true);
    expect((await store.getArticle(article.id))!.progressOffset).toBe(len);
    expect((await store.getArticle(article.id))!.progress).toBe(1);
    expect(await store.updateProgress(article.id, -5)).toBe(true);
    expect((await store.getArticle(article.id))!.progressOffset).toBe(0);
    await expect(store.updateProgress("nope", 0.5)).resolves.toBe(false);
  });

  it("lazily backfills rows missing the new fields", async () => {
    const file = path.join(tmp, "data", "articles.json");
    await fs.mkdir(path.join(tmp, "data"), { recursive: true });
    const now = new Date().toISOString();
    const legacy = {
      id: "legacy-1",
      url: "https://example.com/legacy",
      title: "Legacy",
      byline: null,
      excerpt: null,
      html: "<p>0123456789</p>",
      text: "0123456789",
      wordCount: 1,
      progress: 0.5,
      createdAt: now,
    };
    await fs.writeFile(file, JSON.stringify([legacy]), "utf8");
    const got = (await store.getArticle("legacy-1"))!;
    expect(got.progressOffset).toBe(5);
    expect(got.progressUpdatedAt).toBeNull();
    // progress mirror itself is preserved.
    expect(got.progress).toBe(0.5);
    expect(store.toSummary(got).progressOffset).toBe(5);
  });
});
