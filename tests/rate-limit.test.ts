import { readFileSync } from "fs";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit, getClientIp, resetRateLimits } from "../lib/rate-limit";

const ORIG_CWD = process.cwd();
let tmp = "";

let articlesRoute: typeof import("../app/api/articles/route");
let extractRoute: typeof import("../app/api/extract/route");
let rl: typeof import("../lib/rate-limit");

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
}

function articlesReq(body: unknown, ip?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request("http://localhost/api/articles", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function extractReq(body: unknown, ip?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request("http://localhost/api/extract", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the limit, then blocks with a positive retryAfter", () => {
    expect(checkRateLimit("rl-allow", 2, 60_000)).toEqual({ ok: true, retryAfterSec: 0 });
    expect(checkRateLimit("rl-allow", 2, 60_000)).toEqual({ ok: true, retryAfterSec: 0 });
    const blocked = checkRateLimit("rl-allow", 2, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("derives retryAfter from the oldest hit in the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(checkRateLimit("rl-math", 2, 60_000).ok).toBe(true);
    expect(checkRateLimit("rl-math", 2, 60_000).ok).toBe(true);
    expect(checkRateLimit("rl-math", 2, 60_000)).toEqual({ ok: false, retryAfterSec: 60 });
    vi.advanceTimersByTime(10_000);
    expect(checkRateLimit("rl-math", 2, 60_000)).toEqual({ ok: false, retryAfterSec: 50 });
  });

  it("allows again once the window slides past old hits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    expect(checkRateLimit("rl-window", 1, 1_000).ok).toBe(true);
    expect(checkRateLimit("rl-window", 1, 1_000).ok).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(checkRateLimit("rl-window", 1, 1_000)).toEqual({ ok: true, retryAfterSec: 0 });
  });

  it("tracks keys independently", () => {
    expect(checkRateLimit("rl-a", 1, 60_000).ok).toBe(true);
    expect(checkRateLimit("rl-a", 1, 60_000).ok).toBe(false);
    expect(checkRateLimit("rl-b", 1, 60_000)).toEqual({ ok: true, retryAfterSec: 0 });
  });

  it("resetRateLimits clears all buckets", () => {
    expect(checkRateLimit("rl-reset", 1, 60_000).ok).toBe(true);
    expect(checkRateLimit("rl-reset", 1, 60_000).ok).toBe(false);
    resetRateLimits();
    expect(checkRateLimit("rl-reset", 1, 60_000)).toEqual({ ok: true, retryAfterSec: 0 });
  });
});

describe("getClientIp", () => {
  function reqWith(headers: Record<string, string>): Request {
    return new Request("http://localhost/api/articles", { headers });
  }

  it("prefers the first x-forwarded-for entry", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
    expect(getClientIp(reqWith({ "x-forwarded-for": "  9.9.9.9  " }))).toBe("9.9.9.9");
  });

  it("falls back to x-real-ip, then to local", () => {
    expect(getClientIp(reqWith({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(getClientIp(reqWith({}))).toBe("local");
    expect(getClientIp(reqWith({ "x-forwarded-for": "" }))).toBe("local");
  });
});

describe("POST /api/articles rate limit", () => {
  beforeEach(async () => {
    // Same isolation as tests/store.test.ts: route modules (via lib/store.ts)
    // resolve data/articles.json from process.cwd() at import time.
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-ratelimit-"));
    process.chdir(tmp);
    vi.resetModules();
    articlesRoute = await import("../app/api/articles/route");
    extractRoute = await import("../app/api/extract/route");
    // Same module instance the routes use (imported after resetModules),
    // so the override hook below affects the routes under test.
    rl = await import("../lib/rate-limit");
  });

  afterEach(async () => {
    process.chdir(ORIG_CWD);
    await fs.rm(tmp, { recursive: true, force: true });
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("429s after the limit is exceeded, with Retry-After + CORS headers", async () => {
    rl.setRateLimitOverride("articles:1.2.3.4", 2, 60_000);
    const payload = { url: "https://example.com/rl/a", html: fixture("simple") };
    const first = await articlesRoute.POST(articlesReq(payload, "1.2.3.4"));
    expect(first.status).toBe(201);
    const second = await articlesRoute.POST(articlesReq(payload, "1.2.3.4"));
    expect(second.status).toBe(200);

    const limited = await articlesRoute.POST(articlesReq(payload, "1.2.3.4"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limited, retry soon" });
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("limits IPs independently", async () => {
    rl.setRateLimitOverride("articles:10.0.0.1", 1, 60_000);
    rl.setRateLimitOverride("articles:10.0.0.2", 1, 60_000);
    const ok = await articlesRoute.POST(
      articlesReq({ url: "https://example.com/rl/ip-a", html: fixture("simple") }, "10.0.0.1")
    );
    expect(ok.status).toBe(201);
    const blocked = await articlesRoute.POST(
      articlesReq({ url: "https://example.com/rl/ip-a", html: fixture("simple") }, "10.0.0.1")
    );
    expect(blocked.status).toBe(429);
    const other = await articlesRoute.POST(
      articlesReq({ url: "https://example.com/rl/ip-b", html: fixture("simple") }, "10.0.0.2")
    );
    expect(other.status).toBe(201);
  });

  it("uses production defaults of 30 req/min", () => {
    expect(rl.DEFAULT_RATE_LIMIT).toBe(30);
    expect(rl.DEFAULT_RATE_WINDOW_MS).toBe(60_000);
  });

  it("429s on POST /api/extract with a Retry-After header (no fetch attempted)", async () => {
    // Both requests use bodies that fail validation, so no network fetch
    // happens — the limiter runs before validation.
    rl.setRateLimitOverride("extract:3.3.3.3", 1, 60_000);
    const first = await extractRoute.POST(extractReq({}, "3.3.3.3"));
    expect(first.status).toBe(400);
    const limited = await extractRoute.POST(extractReq({}, "3.3.3.3"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limited, retry soon" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("logs host-only console.error on the articles 422 path", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await articlesRoute.POST(
        articlesReq({ url: "https://example.com/too-big", html: "x".repeat(10_000_001) })
      );
      expect(res.status).toBe(422);
      expect(errSpy).toHaveBeenCalledTimes(1);
      const line = String(errSpy.mock.calls[0]?.[0]);
      expect(line).toContain("[POST /api/articles]");
      expect(line).toContain("host=example.com");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("logs host-only console.error on the extract 422 path", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x", { status: 200, headers: { "content-type": "application/pdf" } })
      )
    );
    try {
      const res = await extractRoute.POST(extractReq({ url: "https://example.com/file.pdf" }));
      expect(res.status).toBe(422);
      expect(errSpy).toHaveBeenCalledTimes(1);
      const line = String(errSpy.mock.calls[0]?.[0]);
      expect(line).toContain("[POST /api/extract]");
      expect(line).toContain("host=example.com");
    } finally {
      errSpy.mockRestore();
    }
  });
});
