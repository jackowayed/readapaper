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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-archive-"));
  process.chdir(tmp);
  vi.resetModules();
  store = await import("../lib/store");
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("archive store", () => {
  it("creates articles unarchived with null stamp, visible in summaries", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    expect(article.archived).toBe(false);
    expect(article.archivedAt).toBeNull();
    const summary = store.toSummary(article);
    expect(summary.archived).toBe(false);
    expect(summary.archivedAt).toBeNull();
  });

  it("setArchived flips + stamps, unarchive clears; null for unknown", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    const archived = await store.setArchived(article.id, true);
    expect(archived).not.toBeNull();
    expect(archived!.archived).toBe(true);
    expect(typeof archived!.archivedAt).toBe("string");
    expect(Number.isFinite(Date.parse(archived!.archivedAt as string))).toBe(true);

    const unarchived = await store.setArchived(article.id, false);
    expect(unarchived!.archived).toBe(false);
    expect(unarchived!.archivedAt).toBeNull();

    await expect(store.setArchived("nope", true)).resolves.toBeNull();
  });

  it("re-archive refreshes the stamp", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    const first = (await store.setArchived(article.id, true))!;
    await new Promise((r) => setTimeout(r, 10));
    const second = (await store.setArchived(article.id, true))!;
    expect(second.archived).toBe(true);
    expect(Date.parse(second.archivedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(first.archivedAt as string)
    );
  });

  it("migrates legacy rows missing archived fields to false/null", async () => {
    const file = path.join(tmp, "data", "articles.json");
    await fs.mkdir(path.join(tmp, "data"), { recursive: true });
    const now = new Date().toISOString();
    const legacy = {
      id: "legacy-1",
      url: "https://example.com/legacy",
      title: "Legacy",
      byline: null,
      excerpt: null,
      html: "<p>hello</p>",
      text: "hello",
      wordCount: 1,
      progress: 0,
      createdAt: now,
    };
    await fs.writeFile(file, JSON.stringify([legacy]), "utf8");
    const got = (await store.getArticle("legacy-1"))!;
    expect(got.archived).toBe(false);
    expect(got.archivedAt).toBeNull();
    expect(store.toSummary(got).archived).toBe(false);
    expect(store.toSummary(got).archivedAt).toBeNull();
  });

  it("migration preserves progressOffset/progressUpdatedAt (round-trip)", async () => {
    const file = path.join(tmp, "data", "articles.json");
    await fs.mkdir(path.join(tmp, "data"), { recursive: true });
    const now = new Date().toISOString();
    const stamp = "2026-01-02T03:04:05.000Z";
    const legacy = {
      id: "legacy-2",
      url: "https://example.com/legacy2",
      title: "Legacy 2",
      byline: null,
      excerpt: null,
      html: "<p>0123456789</p>",
      text: "0123456789",
      wordCount: 1,
      progress: 0.5,
      progressOffset: 5,
      progressUpdatedAt: stamp,
      createdAt: now,
    };
    await fs.writeFile(file, JSON.stringify([legacy]), "utf8");
    const got = (await store.getArticle("legacy-2"))!;
    expect(got.progressOffset).toBe(5);
    expect(got.progressUpdatedAt).toBe(stamp);
    expect(got.progress).toBe(0.5);
    expect(got.archived).toBe(false);
    expect(got.archivedAt).toBeNull();
  });

  it("listArticles filter: no-filter returns all desc, true/false partition", async () => {
    const a = await store.createArticle(sample("https://example.com/a"));
    await new Promise((r) => setTimeout(r, 15));
    const b = await store.createArticle(sample("https://example.com/b"));
    await store.setArchived(a.article.id, true);

    const all = await store.listArticles();
    expect(all.map((x) => x.id).sort()).toEqual([a.article.id, b.article.id].sort());
    // Newest first still holds with no filter.
    expect(all.map((x) => x.id)).toEqual([b.article.id, a.article.id]);

    expect((await store.listArticles({ archived: true })).map((x) => x.id)).toEqual([a.article.id]);
    expect((await store.listArticles({ archived: false })).map((x) => x.id)).toEqual([
      b.article.id,
    ]);
  });

  it("progress writes to archived articles keep working", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    await store.setArchived(article.id, true);
    const res = await store.updateProgressOffset(article.id, 5);
    expect(res).not.toBeNull();
    const got = (await store.getArticle(article.id))!;
    expect(got.progressOffset).toBe(5);
    expect(got.archived).toBe(true);
    expect(typeof got.archivedAt).toBe("string");
  });
});
