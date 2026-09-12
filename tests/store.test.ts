import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_CWD = process.cwd();
let tmp = "";
let store: typeof import("../lib/store");

const sample = (url: string) => ({
  url,
  title: "Sample Title",
  byline: null as string | null,
  excerpt: null as string | null,
  html: "<p>hello world</p>",
  text: "hello world foo bar",
});

async function dataFile(): Promise<string> {
  const dir = path.join(tmp, "data");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "articles.json");
}

beforeEach(async () => {
  // lib/store.ts resolves data/articles.json from process.cwd() at import
  // time, so chdir into a temp dir BEFORE (re-)importing it.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-store-"));
  process.chdir(tmp);
  vi.resetModules();
  store = await import("../lib/store");
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("normalizeUrl", () => {
  it("strips the hash fragment", () => {
    expect(store.normalizeUrl("https://example.com/a#section")).toBe("https://example.com/a");
  });

  it("drops a trailing slash on non-root paths", () => {
    expect(store.normalizeUrl("https://example.com/a/")).toBe("https://example.com/a");
    expect(store.normalizeUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
  });

  it("keeps the root slash and preserves query strings", () => {
    expect(store.normalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(store.normalizeUrl("https://example.com/a?x=1")).toBe("https://example.com/a?x=1");
  });

  it("returns invalid URLs unchanged", () => {
    expect(store.normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("createArticle / dedup", () => {
  it("creates with wordCount, progress 0, and created:true", async () => {
    const { article, created } = await store.createArticle(sample("https://example.com/a"));
    expect(created).toBe(true);
    expect(article.id).toBeTruthy();
    expect(article.wordCount).toBe(4);
    expect(article.progress).toBe(0);
    expect(article.createdAt).toBeTruthy();
  });

  it("returns created:false for duplicates (hash/trailing-slash variants)", async () => {
    const first = await store.createArticle(sample("https://example.com/a"));
    expect(first.created).toBe(true);
    for (const variant of [
      "https://example.com/a",
      "https://example.com/a#section",
      "https://example.com/a/",
    ]) {
      const dup = await store.createArticle(sample(variant));
      expect(dup.created).toBe(false);
      expect(dup.article.id).toBe(first.article.id);
    }
    expect(await store.listArticles()).toHaveLength(1);
  });
});

describe("listArticles", () => {
  it("sorts newest first", async () => {
    const a = await store.createArticle(sample("https://example.com/a"));
    await new Promise((r) => setTimeout(r, 15));
    const b = await store.createArticle(sample("https://example.com/b"));
    const list = await store.listArticles();
    expect(list.map((x) => x.id)).toEqual([b.article.id, a.article.id]);
  });

  it("returns [] when the JSON holds a non-array", async () => {
    const file = await dataFile();
    await fs.writeFile(file, JSON.stringify({ not: "an array" }), "utf8");
    await expect(store.listArticles()).resolves.toEqual([]);
  });

  it("throws on corrupt JSON", async () => {
    const file = await dataFile();
    await fs.writeFile(file, "not-json{{{", "utf8");
    await expect(store.listArticles()).rejects.toThrow();
  });
});

describe("updateProgress", () => {
  it("sets in-range values (derived mirror of the canonical offset)", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    expect(await store.updateProgress(article.id, 0.5)).toBe(true);
    // Canonical storage: offset = round(0.5 * len), fraction re-derived.
    const expected = Math.round(0.5 * article.text.length) / article.text.length;
    expect((await store.getArticle(article.id))!.progress).toBe(expected);
  });

  it("clamps to 0..1", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    expect(await store.updateProgress(article.id, 2)).toBe(true);
    expect((await store.getArticle(article.id))!.progress).toBe(1);
    expect(await store.updateProgress(article.id, -5)).toBe(true);
    expect((await store.getArticle(article.id))!.progress).toBe(0);
  });

  it("returns false for a missing id", async () => {
    await expect(store.updateProgress("nope", 0.5)).resolves.toBe(false);
  });
});

describe("deleteArticle", () => {
  it("returns false for a missing id", async () => {
    await expect(store.deleteArticle("nope")).resolves.toBe(false);
  });

  it("deletes an existing article", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    expect(await store.deleteArticle(article.id)).toBe(true);
    expect(await store.getArticle(article.id)).toBeNull();
  });
});
