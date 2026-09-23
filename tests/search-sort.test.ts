import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_CWD = process.cwd();
let tmp = "";
let store: typeof import("../lib/store");
let articlesRoute: typeof import("../app/api/articles/route");

const article = (url: string, over: Record<string, unknown> = {}) => ({
  url,
  title: "Sample Title",
  byline: null as string | null,
  excerpt: null as string | null,
  html: "<p>hello world</p>",
  text: "hello world foo bar",
  ...over,
});

function getReq(query = ""): Request {
  return new Request(`http://localhost/api/articles${query}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  // lib/store.ts resolves data/articles.json from process.cwd() at import
  // time, so chdir into a temp dir BEFORE (re-)importing it.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-search-sort-"));
  process.chdir(tmp);
  vi.resetModules();
  store = await import("../lib/store");
  articlesRoute = await import("../app/api/articles/route");
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("listArticles q (substring search)", () => {
  it("matches the title case-insensitively", async () => {
    await store.createArticle(
      article("https://example.com/search/a", { title: "Quantum Banana Bread" })
    );
    await store.createArticle(article("https://example.com/search/b", { title: "Unrelated" }));
    const list = await store.listArticles({ q: "bAnAnA" });
    expect(list.map((a) => a.title)).toEqual(["Quantum Banana Bread"]);
  });

  it("matches body text, excerpt, byline, and url", async () => {
    await store.createArticle(
      article("https://example.com/search/body", { text: "the lighthouse keeper sings" })
    );
    await store.createArticle(
      article("https://example.com/search/excerpt", { excerpt: "a quiet estuary at dawn" })
    );
    await store.createArticle(
      article("https://example.com/search/byline", { byline: "Marina Solano" })
    );
    await store.createArticle(article("https://example.com/search/zanzibar-trip"));
    expect((await store.listArticles({ q: "lighthouse" })).map((a) => a.url)).toEqual([
      "https://example.com/search/body",
    ]);
    expect((await store.listArticles({ q: "ESTUARY" })).map((a) => a.url)).toEqual([
      "https://example.com/search/excerpt",
    ]);
    expect((await store.listArticles({ q: "solano" })).map((a) => a.url)).toEqual([
      "https://example.com/search/byline",
    ]);
    expect((await store.listArticles({ q: "zanzibar" })).map((a) => a.url)).toEqual([
      "https://example.com/search/zanzibar-trip",
    ]);
  });

  it("returns [] when nothing matches", async () => {
    await store.createArticle(article("https://example.com/search/only"));
    await expect(store.listArticles({ q: "no-such-phrase-anywhere" })).resolves.toEqual([]);
  });

  it("treats blank q as no filter", async () => {
    await store.createArticle(article("https://example.com/search/c"));
    await store.createArticle(article("https://example.com/search/d"));
    expect(await store.listArticles({ q: "   " })).toHaveLength(2);
  });
});

describe("listArticles sort", () => {
  it("defaults to newest first and supports oldest", async () => {
    const a = await store.createArticle(article("https://example.com/sort/old"));
    await sleep(15);
    const b = await store.createArticle(article("https://example.com/sort/new"));
    expect((await store.listArticles()).map((x) => x.id)).toEqual([b.article.id, a.article.id]);
    expect((await store.listArticles({ sort: "newest" })).map((x) => x.id)).toEqual([
      b.article.id,
      a.article.id,
    ]);
    expect((await store.listArticles({ sort: "oldest" })).map((x) => x.id)).toEqual([
      a.article.id,
      b.article.id,
    ]);
  });

  it("orders longest/shortest by wordCount", async () => {
    const tiny = await store.createArticle(
      article("https://example.com/sort/tiny", { text: "one two three" })
    );
    const mid = await store.createArticle(
      article("https://example.com/sort/mid", { text: "word ".repeat(10) })
    );
    const big = await store.createArticle(
      article("https://example.com/sort/big", { text: "word ".repeat(30) })
    );
    expect((await store.listArticles({ sort: "longest" })).map((x) => x.id)).toEqual([
      big.article.id,
      mid.article.id,
      tiny.article.id,
    ]);
    expect((await store.listArticles({ sort: "shortest" })).map((x) => x.id)).toEqual([
      tiny.article.id,
      mid.article.id,
      big.article.id,
    ]);
  });

  it("orders progress descending", async () => {
    const low = await store.createArticle(article("https://example.com/prog/low"));
    const mid = await store.createArticle(article("https://example.com/prog/mid"));
    const high = await store.createArticle(article("https://example.com/prog/high"));
    await store.updateProgress(low.article.id, 0.1);
    await store.updateProgress(mid.article.id, 0.5);
    await store.updateProgress(high.article.id, 0.9);
    expect((await store.listArticles({ sort: "progress" })).map((x) => x.id)).toEqual([
      high.article.id,
      mid.article.id,
      low.article.id,
    ]);
  });

  it("combines archived + q + sort", async () => {
    const keep = await store.createArticle(
      article("https://example.com/combo/keep", {
        title: "Rust notes",
        text: "word ".repeat(20),
      })
    );
    await sleep(15);
    const other = await store.createArticle(
      article("https://example.com/combo/other", {
        title: "Rust notes",
        text: "word ".repeat(5),
      })
    );
    await store.setArchived(other.article.id, true);
    // Archived match is excluded from the active view…
    expect(
      (await store.listArticles({ archived: false, q: "rust", sort: "longest" })).map((x) => x.id)
    ).toEqual([keep.article.id]);
    // …but visible (and sortable) in the archived view alongside non-matches excluded.
    const long = await store.createArticle(
      article("https://example.com/combo/archived-long", {
        title: "Rust notes deep dive",
        text: "word ".repeat(40),
      })
    );
    await store.setArchived(long.article.id, true);
    const archived = await store.listArticles({ archived: true, q: "rust", sort: "shortest" });
    expect(archived.map((x) => x.id)).toEqual([other.article.id, long.article.id]);
    expect(archived[0]!.wordCount).toBeLessThan(archived[1]!.wordCount);
  });
});

describe("GET /api/articles q + sort", () => {
  it("filters by ?q= (trimmed, case-insensitive) and returns summaries", async () => {
    await store.createArticle(
      article("https://example.com/route/match", { title: "Sourdough Secrets" })
    );
    await store.createArticle(article("https://example.com/route/plain", { title: "Plain" }));
    const res = await articlesRoute.GET(getReq("?q=%20%20SOURdough%20"));
    expect(res.status).toBe(200);
    const list = (await res.json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toHaveProperty("title", "Sourdough Secrets");
    expect(list[0]).not.toHaveProperty("html");
    expect(list[0]).not.toHaveProperty("text");
  });

  it("orders by ?sort= and defaults to newest when missing", async () => {
    const a = await store.createArticle(article("https://example.com/route/first"));
    await sleep(15);
    const b = await store.createArticle(article("https://example.com/route/second"));
    const def = (await (await articlesRoute.GET(getReq())).json()) as { id: string }[];
    expect(def.map((x) => x.id)).toEqual([b.article.id, a.article.id]);
    const oldest = (await (await articlesRoute.GET(getReq("?sort=oldest"))).json()) as {
      id: string;
    }[];
    expect(oldest.map((x) => x.id)).toEqual([a.article.id, b.article.id]);
  });

  it("combines ?archived= with ?q= and ?sort=", async () => {
    const active = await store.createArticle(
      article("https://example.com/route/combo-active", { title: "Pickle Ledger" })
    );
    const archived = await store.createArticle(
      article("https://example.com/route/combo-archived", { title: "Pickle Ledger" })
    );
    await store.setArchived(archived.article.id, true);
    const one = (await (
      await articlesRoute.GET(getReq("?archived=1&q=pickle&sort=oldest"))
    ).json()) as { id: string }[];
    expect(one.map((x) => x.id)).toEqual([archived.article.id]);
    const zero = (await (
      await articlesRoute.GET(getReq("?archived=0&q=pickle&sort=oldest"))
    ).json()) as { id: string }[];
    expect(zero.map((x) => x.id)).toEqual([active.article.id]);
  });

  it("400s on unknown ?sort=", async () => {
    const res = await articlesRoute.GET(getReq("?sort=bogus"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid sort, expected one of: newest, oldest, longest, shortest, progress",
    });
  });

  it("400s when ?q= exceeds 200 chars", async () => {
    const res = await articlesRoute.GET(getReq(`?q=${"x".repeat(201)}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Query too long (max 200 chars)" });
  });
});
