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

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  // Route modules (via lib/store.ts) resolve data/articles.json from
  // process.cwd() at import time, so chdir into a temp dir first.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-progress-route-"));
  process.chdir(tmp);
  vi.resetModules();
  articlesRoute = await import("../app/api/articles/route");
  idRoute = await import("../app/api/articles/[id]/route");
  progressRoute = await import("../app/api/articles/[id]/progress/route");
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("PUT /api/articles/[id]/progress (offset)", () => {
  async function savedId(url = "https://example.com/a"): Promise<string> {
    const res = await articlesRoute.POST(postReq({ url, html: fixture("simple") }));
    return ((await res.json()) as { id: string }).id;
  }

  async function textLength(id: string): Promise<number> {
    const res = await idRoute.GET(new Request("http://localhost/"), ctx(id));
    return ((await res.json()) as { text: string }).text.length;
  }

  it("400 on invalid JSON", async () => {
    const res = await progressRoute.PUT(putReq("{oops"), ctx("x"));
    expect(res.status).toBe(400);
  });

  it("400 when neither offset nor progress is numeric", async () => {
    const id = await savedId();
    for (const body of [
      {},
      { offset: "half" },
      { offset: null },
      { progress: "half" },
      { progress: null },
      { offset: true, progress: "x" },
    ]) {
      const res = await progressRoute.PUT(putReq(body), ctx(id));
      expect(res.status).toBe(400);
    }
  });

  it("404 for a missing id (offset + legacy shapes)", async () => {
    expect((await progressRoute.PUT(putReq({ offset: 5 }), ctx("nope"))).status).toBe(404);
    expect((await progressRoute.PUT(putReq({ progress: 0.5 }), ctx("nope"))).status).toBe(404);
  });

  it("writes { offset } and returns { ok, offset, progress }", async () => {
    const id = await savedId();
    const len = await textLength(id);
    const res = await progressRoute.PUT(putReq({ offset: 10 }), ctx(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, offset: 10, progress: 10 / len });
    const got = (await (await idRoute.GET(new Request("http://localhost/"), ctx(id))).json()) as {
      progressOffset: number;
      progress: number;
    };
    expect(got.progressOffset).toBe(10);
    expect(got.progress).toBe(10 / len);
  });

  it("prefers offset when both offset and progress are present", async () => {
    const id = await savedId();
    const len = await textLength(id);
    const res = await progressRoute.PUT(putReq({ offset: 5, progress: 0.9 }), ctx(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, offset: 5, progress: 5 / len });
  });

  it("still accepts legacy { progress } and returns both", async () => {
    const id = await savedId("https://example.com/b");
    const len = await textLength(id);
    const res = await progressRoute.PUT(putReq({ progress: 0.5 }), ctx(id));
    expect(res.status).toBe(200);
    const expectedOffset = Math.round(0.5 * len);
    expect(await res.json()).toEqual({
      ok: true,
      offset: expectedOffset,
      progress: expectedOffset / len,
    });
  });

  it("clamps offsets above text.length (and below 0)", async () => {
    const id = await savedId("https://example.com/c");
    const len = await textLength(id);
    const high = await progressRoute.PUT(putReq({ offset: 10 ** 9 }), ctx(id));
    expect(high.status).toBe(200);
    expect(await high.json()).toEqual({ ok: true, offset: len, progress: 1 });
    const low = await progressRoute.PUT(putReq({ offset: -20 }), ctx(id));
    expect(low.status).toBe(200);
    expect(await low.json()).toEqual({ ok: true, offset: 0, progress: 0 });
  });
});
