import { readFileSync } from "fs";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_CWD = process.cwd();
let tmp = "";
let store: typeof import("../lib/store");

let articlesRoute: typeof import("../app/api/articles/route");
let idRoute: typeof import("../app/api/articles/[id]/route");
let likeRoute: typeof import("../app/api/articles/[id]/like/route");
let trashRoute: typeof import("../app/api/articles/[id]/trash/route");
let archiveRoute: typeof import("../app/api/articles/[id]/archive/route");

const sample = (url: string, text = "hello world foo bar") => ({
  url,
  title: "Sample Title",
  byline: null as string | null,
  excerpt: null as string | null,
  html: `<p>${text}</p>`,
  text,
});

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
}

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/articles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function putReq(body: unknown): Request {
  return new Request("http://localhost/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function getReq(query = ""): Request {
  return new Request(`http://localhost/api/articles${query}`);
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  // Same temp-dir isolation as tests/archive.test.ts: lib/store.ts resolves
  // data/articles.json from process.cwd() at import time. vi.resetModules
  // also gives each test a fresh rate-limit bucket, so the handful of POSTs
  // below never approach the 30 req/min default (no override needed).
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-starred-trash-"));
  process.chdir(tmp);
  vi.resetModules();
  store = await import("../lib/store");
  articlesRoute = await import("../app/api/articles/route");
  idRoute = await import("../app/api/articles/[id]/route");
  likeRoute = await import("../app/api/articles/[id]/like/route");
  trashRoute = await import("../app/api/articles/[id]/trash/route");
  archiveRoute = await import("../app/api/articles/[id]/archive/route");
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("liked/deleted store", () => {
  it("creates articles unliked + untrashed with null stamps, visible in summaries", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    expect(article.liked).toBe(false);
    expect(article.likedAt).toBeNull();
    expect(article.deleted).toBe(false);
    expect(article.deletedAt).toBeNull();
    const summary = store.toSummary(article);
    expect(summary.liked).toBe(false);
    expect(summary.likedAt).toBeNull();
    expect(summary.deleted).toBe(false);
    expect(summary.deletedAt).toBeNull();
  });

  it("migrates legacy rows missing liked/deleted fields to false/null", async () => {
    const file = path.join(tmp, "data", "articles.json");
    await fs.mkdir(path.join(tmp, "data"), { recursive: true });
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
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(file, JSON.stringify([legacy]), "utf8");
    const got = (await store.getArticle("legacy-1"))!;
    expect(got.liked).toBe(false);
    expect(got.likedAt).toBeNull();
    expect(got.deleted).toBe(false);
    expect(got.deletedAt).toBeNull();
    const summary = store.toSummary(got);
    expect(summary.liked).toBe(false);
    expect(summary.deleted).toBe(false);
  });

  it("setLiked flips + stamps, unlike clears; null for unknown", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    const liked = (await store.setLiked(article.id, true))!;
    expect(liked.liked).toBe(true);
    expect(typeof liked.likedAt).toBe("string");
    expect(Number.isFinite(Date.parse(liked.likedAt as string))).toBe(true);

    const unliked = (await store.setLiked(article.id, false))!;
    expect(unliked.liked).toBe(false);
    expect(unliked.likedAt).toBeNull();

    await expect(store.setLiked("nope", true)).resolves.toBeNull();
  });

  it("setDeleted trashes + stamps, restore clears; null for unknown", async () => {
    const { article } = await store.createArticle(sample("https://example.com/a"));
    const trashed = (await store.setDeleted(article.id, true))!;
    expect(trashed.deleted).toBe(true);
    expect(typeof trashed.deletedAt).toBe("string");

    const restored = (await store.setDeleted(article.id, false))!;
    expect(restored.deleted).toBe(false);
    expect(restored.deletedAt).toBeNull();

    await expect(store.setDeleted("nope", true)).resolves.toBeNull();
  });

  it("listArticles default excludes deleted; {deleted} selects the scope", async () => {
    const a = await store.createArticle(sample("https://example.com/a"));
    const b = await store.createArticle(sample("https://example.com/b"));
    await store.setDeleted(a.article.id, true);

    expect((await store.listArticles()).map((x) => x.id)).toEqual([b.article.id]);
    expect((await store.listArticles({ deleted: true })).map((x) => x.id)).toEqual([a.article.id]);
    expect((await store.listArticles({ deleted: false })).map((x) => x.id)).toEqual([b.article.id]);
    // Archived scopes also hide trash by default.
    expect(await store.listArticles({ archived: false })).toHaveLength(1);
    expect(await store.listArticles({ archived: true })).toHaveLength(0);
  });

  it("liked filter composes with the archived scope", async () => {
    const a = await store.createArticle(sample("https://example.com/a"));
    const b = await store.createArticle(sample("https://example.com/b"));
    await store.setLiked(a.article.id, true);
    await store.setLiked(b.article.id, true);
    await store.setArchived(b.article.id, true);

    expect((await store.listArticles({ liked: true })).map((x) => x.id).sort()).toEqual(
      [a.article.id, b.article.id].sort()
    );
    expect((await store.listArticles({ archived: false, liked: true })).map((x) => x.id)).toEqual([
      a.article.id,
    ]);
    expect((await store.listArticles({ archived: true, liked: true })).map((x) => x.id)).toEqual([
      b.article.id,
    ]);
  });

  it("dedup matches non-deleted only: trashed URL re-saves fresh", async () => {
    const first = await store.createArticle(sample("https://example.com/a"));
    await store.setDeleted(first.article.id, true);
    expect(await store.findArticleByUrl("https://example.com/a")).toBeNull();
    const second = await store.createArticle(sample("https://example.com/a"));
    expect(second.created).toBe(true);
    expect(second.article.id).not.toBe(first.article.id);
  });
});

describe("PUT /api/articles/[id]/like", () => {
  async function savedId(url = "https://example.com/a"): Promise<string> {
    const res = await articlesRoute.POST(postReq({ url, html: fixture("simple") }));
    return ((await res.json()) as { id: string }).id;
  }

  it("400 on invalid JSON", async () => {
    const res = await likeRoute.PUT(putReq("{oops"), ctx("x"));
    expect(res.status).toBe(400);
  });

  it("400 when liked is missing or not a boolean", async () => {
    const id = await savedId();
    for (const body of [{}, { liked: "yes" }, { liked: 1 }, { liked: null }, null]) {
      const res = await likeRoute.PUT(putReq(body), ctx(id));
      expect(res.status).toBe(400);
    }
  });

  it("404 for a missing id", async () => {
    const res = await likeRoute.PUT(putReq({ liked: true }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("likes then unlikes, returning {ok:true,liked}", async () => {
    const id = await savedId();
    const liked = await likeRoute.PUT(putReq({ liked: true }), ctx(id));
    expect(liked.status).toBe(200);
    expect(await liked.json()).toEqual({ ok: true, liked: true });
    const unliked = await likeRoute.PUT(putReq({ liked: false }), ctx(id));
    expect(unliked.status).toBe(200);
    expect(await unliked.json()).toEqual({ ok: true, liked: false });
  });
});

describe("trash routes (soft-delete, restore, purge)", () => {
  async function savedId(url = "https://example.com/a"): Promise<string> {
    const res = await articlesRoute.POST(postReq({ url, html: fixture("simple") }));
    return ((await res.json()) as { id: string }).id;
  }

  it("PUT /trash 400 on invalid JSON / non-boolean, 404 for missing id", async () => {
    expect((await trashRoute.PUT(putReq("{oops"), ctx("x"))).status).toBe(400);
    const id = await savedId();
    for (const body of [{}, { deleted: "yes" }, { deleted: 1 }, { deleted: null }, null]) {
      expect((await trashRoute.PUT(putReq(body), ctx(id))).status).toBe(400);
    }
    expect((await trashRoute.PUT(putReq({ deleted: true }), ctx("nope"))).status).toBe(404);
  });

  it("PUT /trash trashes then restores, returning {ok:true,deleted}", async () => {
    const id = await savedId();
    const trashed = await trashRoute.PUT(putReq({ deleted: true }), ctx(id));
    expect(trashed.status).toBe(200);
    expect(await trashed.json()).toEqual({ ok: true, deleted: true });
    const restored = await trashRoute.PUT(putReq({ deleted: false }), ctx(id));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ ok: true, deleted: false });
  });

  it("DELETE soft-deletes (204, hidden by default, visible via ?deleted=1)", async () => {
    const id = await savedId();
    const del = await idRoute.DELETE(new Request("http://localhost/"), ctx(id));
    expect(del.status).toBe(204);

    const def = (await (await articlesRoute.GET(getReq())).json()) as { id: string }[];
    expect(def).toHaveLength(0);
    const trash = (await (await articlesRoute.GET(getReq("?deleted=1"))).json()) as {
      id: string;
      deleted: boolean;
    }[];
    expect(trash.map((a) => a.id)).toEqual([id]);
    expect(trash[0]!.deleted).toBe(true);
    // The trashed row itself is still fetchable (article page shows restore).
    expect((await idRoute.GET(new Request("http://localhost/"), ctx(id))).status).toBe(200);
  });

  it("restore via PUT /trash makes the article visible again", async () => {
    const id = await savedId();
    await idRoute.DELETE(new Request("http://localhost/"), ctx(id));
    const restored = await trashRoute.PUT(putReq({ deleted: false }), ctx(id));
    expect(restored.status).toBe(200);
    const def = (await (await articlesRoute.GET(getReq())).json()) as { id: string }[];
    expect(def.map((a) => a.id)).toEqual([id]);
  });

  it("DELETE ?permanent=1 hard-deletes (204, then GET 404s, 404 on unknown)", async () => {
    expect(
      (await idRoute.DELETE(new Request("http://localhost/?permanent=1"), ctx("nope"))).status
    ).toBe(404);
    const id = await savedId();
    const del = await idRoute.DELETE(new Request("http://localhost/?permanent=1"), ctx(id));
    expect(del.status).toBe(204);
    expect((await idRoute.GET(new Request("http://localhost/"), ctx(id))).status).toBe(404);
  });

  it("DELETE soft path 404s for a missing id", async () => {
    const res = await idRoute.DELETE(new Request("http://localhost/"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("re-saving a trashed URL creates a fresh article (201)", async () => {
    const url = "https://example.com/resave";
    const first = (await (
      await articlesRoute.POST(postReq({ url, html: fixture("simple") }))
    ).json()) as { id: string };
    await idRoute.DELETE(new Request("http://localhost/"), ctx(first.id));
    const secondRes = await articlesRoute.POST(postReq({ url, html: fixture("simple") }));
    expect(secondRes.status).toBe(201);
    const second = (await secondRes.json()) as { id: string };
    expect(second.id).not.toBe(first.id);
  });
});

describe("GET /api/articles ?liked", () => {
  it("?liked=1 narrows within the archived scope; trash needs ?deleted=1", async () => {
    const mk = async (url: string) => {
      // Settle so createdAt (ms resolution) keeps newest-first order stable.
      await new Promise((r) => setTimeout(r, 15));
      return (
        (await (await articlesRoute.POST(postReq({ url, html: fixture("simple") }))).json()) as {
          id: string;
        }
      ).id;
    };
    const active = await mk("https://example.com/active");
    const archived = await mk("https://example.com/archived");
    await mk("https://example.com/plain");
    const trashed = await mk("https://example.com/trashed");
    for (const id of [active, archived, trashed]) {
      await likeRoute.PUT(putReq({ liked: true }), ctx(id));
    }
    await archiveRoute.PUT(putReq({ archived: true }), ctx(archived));
    await trashRoute.PUT(putReq({ deleted: true }), ctx(trashed));

    const ids = async (q: string) =>
      ((await (await articlesRoute.GET(getReq(q))).json()) as { id: string }[]).map((a) => a.id);
    // Default scope is active-only.
    expect(await ids("?liked=1")).toEqual([active]);
    expect(await ids("?archived=1&liked=1")).toEqual([archived]);
    // ?archived=all spans scopes (newest first), still excluding trash.
    expect(await ids("?archived=all&liked=1")).toEqual([archived, active]);
    expect(await ids("?deleted=1&liked=1")).toEqual([trashed]);
    expect(await ids("?deleted=1")).toEqual([trashed]);
  });
});
