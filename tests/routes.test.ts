import { readFileSync } from "fs";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_CWD = process.cwd();
let tmp = "";

let articlesRoute: typeof import("../app/api/articles/route");
let idRoute: typeof import("../app/api/articles/[id]/route");
let progressRoute: typeof import("../app/api/articles/[id]/progress/route");
let archiveRoute: typeof import("../app/api/articles/[id]/archive/route");

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

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  // Route modules (via lib/store.ts) resolve data/articles.json from
  // process.cwd() at import time, so chdir into a temp dir first.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-routes-"));
  process.chdir(tmp);
  vi.resetModules();
  articlesRoute = await import("../app/api/articles/route");
  idRoute = await import("../app/api/articles/[id]/route");
  progressRoute = await import("../app/api/articles/[id]/progress/route");
  archiveRoute = await import("../app/api/articles/[id]/archive/route");
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("POST /api/articles", () => {
  it("400 on invalid JSON", async () => {
    const res = await articlesRoute.POST(postReq("{oops"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("400 when neither url nor html is provided", async () => {
    const res = await articlesRoute.POST(postReq({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Provide url or html" });
  });

  it("422 when posted HTML exceeds 10MB", async () => {
    const res = await articlesRoute.POST(postReq({ html: "x".repeat(10_000_001) }));
    expect(res.status).toBe(422);
  });

  it("201 on first save via {url, html}, 200 on duplicate", async () => {
    const payload = { url: "https://example.com/articles/hello", html: fixture("simple") };
    const first = await articlesRoute.POST(postReq(payload));
    expect(first.status).toBe(201);
    const saved = (await first.json()) as { id: string; title: string };
    expect(saved.id).toBeTruthy();
    expect(saved.title).toBe("The Quiet Science of Reading on Screens");

    const second = await articlesRoute.POST(postReq(payload));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(saved.id);
  });

  it("400 for blocked/non-http URLs (no fetch attempted)", async () => {
    for (const url of [
      "ftp://example.com/file",
      "http://localhost:3000/x",
      "http://127.0.0.1/",
      "not a url",
    ]) {
      const res = await articlesRoute.POST(postReq({ url }));
      expect(res.status).toBe(400);
    }
  });

  it("400 when the html path carries an invalid/blocked base url", async () => {
    for (const url of [
      "ftp://example.com/file",
      "http://localhost:3000/x",
      "http://127.0.0.1/",
      "not a url",
    ]) {
      const res = await articlesRoute.POST(postReq({ url, html: fixture("simple") }));
      expect(res.status).toBe(400);
    }
  });

  it("201 for html-only posts (localhost parse fallback preserved)", async () => {
    const res = await articlesRoute.POST(postReq({ html: fixture("simple") }));
    expect(res.status).toBe(201);
    const saved = (await res.json()) as { id: string; title: string };
    expect(saved.id).toBeTruthy();
    expect(saved.title).toBe("The Quiet Science of Reading on Screens");
  });

  it("sends CORS headers for the bookmarklet cross-origin POST", async () => {
    const res = await articlesRoute.POST(
      postReq({ url: "https://example.com/a", html: fixture("simple") })
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("OPTIONS answers the CORS preflight", async () => {
    const res = await articlesRoute.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("extract+store integration: scripts stripped from saved HTML", async () => {
    const res = await articlesRoute.POST(
      postReq({ url: "https://example.com/s", html: fixture("script") })
    );
    expect(res.status).toBe(201);
    const saved = (await res.json()) as { html: string; text: string };
    expect(saved.html).not.toMatch(/<script/i);
    expect(saved.text.length).toBeGreaterThan(100);
  });
});

describe("GET /api/articles", () => {
  function getReq(query = ""): Request {
    return new Request(`http://localhost/api/articles${query}`);
  }

  it("lists article summaries without body fields", async () => {
    await articlesRoute.POST(postReq({ url: "https://example.com/a", html: fixture("simple") }));
    const res = await articlesRoute.GET(getReq());
    expect(res.status).toBe(200);
    const list = (await res.json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toHaveProperty("id");
    expect(list[0]).toHaveProperty("title");
    expect(list[0]).toHaveProperty("archived", false);
    expect(list[0]).toHaveProperty("archivedAt", null);
    expect(list[0]).not.toHaveProperty("html");
    expect(list[0]).not.toHaveProperty("text");
  });

  it("defaults to active-only (archived hidden unless requested)", async () => {
    const saved = (await (
      await articlesRoute.POST(postReq({ url: "https://example.com/a", html: fixture("simple") }))
    ).json()) as { id: string };
    await archiveRoute.PUT(
      new Request("http://localhost/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }),
      ctx(saved.id)
    );
    const def = (await (await articlesRoute.GET(getReq())).json()) as { id: string }[];
    expect(def).toHaveLength(0);
    const zero = (await (await articlesRoute.GET(getReq("?archived=0"))).json()) as {
      id: string;
    }[];
    expect(zero).toHaveLength(0);
    const one = (await (await articlesRoute.GET(getReq("?archived=1"))).json()) as {
      id: string;
    }[];
    expect(one.map((a) => a.id)).toEqual([saved.id]);
    const all = (await (await articlesRoute.GET(getReq("?archived=all"))).json()) as {
      id: string;
    }[];
    expect(all.map((a) => a.id)).toEqual([saved.id]);
  });

  it("400 on invalid ?archived= values", async () => {
    for (const query of [
      "?archived=yes",
      "?archived=2",
      "?archived=true",
      "?archived=TRUE",
      "?archived=",
    ]) {
      const res = await articlesRoute.GET(getReq(query));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Invalid archived param (expected 0, 1, or all)",
      });
    }
  });
});

describe("PUT /api/articles/[id]/archive", () => {
  async function savedId(url = "https://example.com/a"): Promise<string> {
    const res = await articlesRoute.POST(postReq({ url, html: fixture("simple") }));
    return ((await res.json()) as { id: string }).id;
  }

  function putReq(body: unknown): Request {
    return new Request("http://localhost/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("400 on invalid JSON", async () => {
    const res = await archiveRoute.PUT(putReq("{oops"), ctx("x"));
    expect(res.status).toBe(400);
  });

  it("400 when archived is missing or not a boolean", async () => {
    const id = await savedId();
    for (const body of [{}, { archived: "yes" }, { archived: 1 }, { archived: null }]) {
      const res = await archiveRoute.PUT(putReq(body), ctx(id));
      expect(res.status).toBe(400);
    }
  });

  it("404 for a missing id", async () => {
    const res = await archiveRoute.PUT(putReq({ archived: true }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("archives then unarchives, returning {ok:true,archived}", async () => {
    const id = await savedId();
    const archived = await archiveRoute.PUT(putReq({ archived: true }), ctx(id));
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ ok: true, archived: true });
    const unarchived = await archiveRoute.PUT(putReq({ archived: false }), ctx(id));
    expect(unarchived.status).toBe(200);
    expect(await unarchived.json()).toEqual({ ok: true, archived: false });
  });
});

describe("GET / DELETE /api/articles/[id]", () => {
  it("GET returns 404 for a missing id", async () => {
    const res = await idRoute.GET(new Request("http://localhost/"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("GET returns the saved article", async () => {
    const saved = (await (
      await articlesRoute.POST(postReq({ url: "https://example.com/a", html: fixture("simple") }))
    ).json()) as { id: string };
    const res = await idRoute.GET(new Request("http://localhost/"), ctx(saved.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(saved.id);
  });

  it("DELETE returns 404 for a missing id", async () => {
    const res = await idRoute.DELETE(new Request("http://localhost/"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("DELETE soft-deletes to trash (204, GET still 200, hidden from list)", async () => {
    const saved = (await (
      await articlesRoute.POST(postReq({ url: "https://example.com/a", html: fixture("simple") }))
    ).json()) as { id: string };
    const del = await idRoute.DELETE(new Request("http://localhost/"), ctx(saved.id));
    expect(del.status).toBe(204);
    expect((await idRoute.GET(new Request("http://localhost/"), ctx(saved.id))).status).toBe(200);
    const list = (await (
      await articlesRoute.GET(new Request("http://localhost/api/articles"))
    ).json()) as { id: string }[];
    expect(list).toHaveLength(0);
  });

  it("DELETE ?permanent=1 hard-deletes (204) and GET then 404s", async () => {
    const saved = (await (
      await articlesRoute.POST(postReq({ url: "https://example.com/a", html: fixture("simple") }))
    ).json()) as { id: string };
    const del = await idRoute.DELETE(new Request("http://localhost/?permanent=1"), ctx(saved.id));
    expect(del.status).toBe(204);
    expect((await idRoute.GET(new Request("http://localhost/"), ctx(saved.id))).status).toBe(404);
  });
});

describe("PUT /api/articles/[id]/progress", () => {
  async function savedId(): Promise<string> {
    const res = await articlesRoute.POST(
      postReq({ url: "https://example.com/a", html: fixture("simple") })
    );
    return ((await res.json()) as { id: string }).id;
  }

  function putReq(body: unknown): Request {
    return new Request("http://localhost/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("400 on invalid JSON", async () => {
    const res = await progressRoute.PUT(putReq("{oops"), ctx("x"));
    expect(res.status).toBe(400);
  });

  it("400 when progress is missing or not a number", async () => {
    const id = await savedId();
    for (const body of [{}, { progress: "half" }, { progress: null }]) {
      const res = await progressRoute.PUT(putReq(body), ctx(id));
      expect(res.status).toBe(400);
    }
  });

  it("404 for a missing id", async () => {
    const res = await progressRoute.PUT(putReq({ progress: 0.5 }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("stores progress and clamps to 0..1", async () => {
    const id = await savedId();
    expect((await progressRoute.PUT(putReq({ progress: 0.5 }), ctx(id))).status).toBe(200);
    let got = (await (await idRoute.GET(new Request("http://localhost/"), ctx(id))).json()) as {
      progress: number;
    };
    expect(got.progress).toBe(0.5);

    await progressRoute.PUT(putReq({ progress: 5 }), ctx(id));
    got = (await (await idRoute.GET(new Request("http://localhost/"), ctx(id))).json()) as {
      progress: number;
    };
    expect(got.progress).toBe(1);
  });
});
