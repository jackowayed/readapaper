import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Article } from "../lib/types";
import type { KindleMailMessage } from "../lib/kindle";

const ORIG_CWD = process.cwd();
const ORIG_ENV = { ...process.env };
let tmp = "";

let statusRoute: typeof import("../app/api/kindle/status/route");
let sendRoute: typeof import("../app/api/kindle/send/route");
let kindle: typeof import("../lib/kindle");
let rl: typeof import("../lib/rate-limit");

const KINDLE_ENV = [
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "KINDLE_EMAIL",
  "FROM_EMAIL",
  "SMTP_PORT",
  "SMTP_SECURE",
];

const TEST_SMTP = {
  SMTP_HOST: "smtp.test.local",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "sender@test.local",
  SMTP_PASS: "test-secret",
  KINDLE_EMAIL: "user@kindle.com",
  FROM_EMAIL: "reader@test.local",
};

function makeArticle(id: string, createdAt: string, archived = false): Article {
  return {
    id,
    url: `https://example.com/kindle/${id}`,
    title: `Kindle Title ${id}`,
    byline: null,
    excerpt: null,
    html: `<p>Body ${id}</p>`,
    text: `Body ${id}`,
    wordCount: 2,
    progress: 0,
    progressOffset: 0,
    progressUpdatedAt: null,
    archived,
    archivedAt: archived ? createdAt : null,
    liked: false,
    likedAt: null,
    deleted: false,
    deletedAt: null,
    createdAt,
  };
}

function day(n: number): string {
  return `2026-02-${String(n).padStart(2, "0")}T12:00:00.000Z`;
}

async function seed(articles: Article[]): Promise<void> {
  const dir = path.join(tmp, "data");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "articles.json"), JSON.stringify(articles), "utf8");
}

function sendReq(ip?: string): Request {
  const headers: Record<string, string> = {};
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request("http://localhost/api/kindle/send", { method: "POST", headers });
}

function clearKindleEnv(): void {
  for (const name of KINDLE_ENV) delete process.env[name];
}

beforeEach(async () => {
  // Same isolation as tests/routes.test.ts: store resolves data/articles.json
  // from process.cwd(), and vi.resetModules gives fresh mail-sender override
  // + rate-limit buckets per test.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readapaper-kindle-"));
  process.chdir(tmp);
  clearKindleEnv();
  vi.resetModules();
  statusRoute = await import("../app/api/kindle/status/route");
  sendRoute = await import("../app/api/kindle/send/route");
  // Same module instance the routes use, so the override hook affects them.
  kindle = await import("../lib/kindle");
  rl = await import("../lib/rate-limit");
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tmp, { recursive: true, force: true });
  for (const name of KINDLE_ENV) delete process.env[name];
  Object.assign(process.env, ORIG_ENV);
  vi.resetModules();
});

describe("GET /api/kindle/status", () => {
  it("reports unconfigured with the active count and no secrets", async () => {
    await seed([makeArticle("a", day(1)), makeArticle("b", day(2), true)]);
    const res = await statusRoute.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, activeCount: 1 });
  });

  it("reports configured once all required env is present", async () => {
    Object.assign(process.env, TEST_SMTP);
    await seed([makeArticle("a", day(1))]);
    const res = await statusRoute.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, activeCount: 1 });
  });

  it("never leaks secrets in the response", async () => {
    Object.assign(process.env, TEST_SMTP);
    await seed([]);
    const body = JSON.stringify(await (await statusRoute.GET()).json());
    expect(body).not.toContain("test-secret");
    expect(body).not.toContain("smtp.test.local");
    expect(body).not.toContain("user@kindle.com");
  });
});

describe("POST /api/kindle/send", () => {
  it("503s with a setup hint (no stack/secrets) when unconfigured", async () => {
    await seed([makeArticle("a", day(1))]);
    const res = await sendRoute.POST(sendReq());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; setup: string };
    expect(body.error).toMatch(/not configured/i);
    expect(body.setup).toMatch(/SMTP_HOST/i);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/Error: |at .*\(.*:\d+:\d+\)/);
  });

  it("400s when configured but no active articles exist", async () => {
    Object.assign(process.env, TEST_SMTP);
    kindle.setMailSenderOverride(async () => undefined);
    await seed([makeArticle("archived-only", day(1), true)]);
    const res = await sendRoute.POST(sendReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No active articles to send" });
  });

  it("sends the latest 50 active articles via the fake sender (archived excluded)", async () => {
    Object.assign(process.env, TEST_SMTP);
    const seen: KindleMailMessage[] = [];
    kindle.setMailSenderOverride(async (msg) => {
      seen.push(msg);
    });

    // 55 active (a00 oldest .. a54 newest, one minute apart) + 3 archived
    // with the newest timestamps to prove the archived filter wins over recency.
    const active = Array.from({ length: 55 }, (_, i) =>
      makeArticle(
        `a${String(i).padStart(2, "0")}`,
        new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString()
      )
    );
    const archived = ["z1", "z2", "z3"].map((id) =>
      makeArticle(id, "2026-12-01T00:00:00.000Z", true)
    );
    await seed([...active, ...archived]);

    const res = await sendRoute.POST(sendReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number; count: number; bytes: number };
    expect(body).toMatchObject({ ok: true, sent: 1, count: 50 });
    expect(body.bytes).toBeGreaterThan(0);

    expect(seen).toHaveLength(1);
    const msg = seen[0]!;
    expect(msg.to).toBe("user@kindle.com");
    expect(msg.from).toBe("reader@test.local");
    expect(msg.subject).toContain("50 article");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]!.filename).toMatch(/\.html$/);
    expect(msg.attachments[0]!.contentType).toContain("text/html");
    expect(body.bytes).toBe(Buffer.byteLength(msg.attachments[0]!.content, "utf8"));

    const doc = msg.attachments[0]!.content;
    // Newest actives included, oldest actives + archived excluded.
    expect(doc).toContain("Kindle Title a54");
    expect(doc).toContain("Kindle Title a05");
    expect(doc).not.toContain("Kindle Title a04");
    expect(doc).not.toContain("Kindle Title z1");
    expect(doc).not.toContain("Kindle Title z2");
  });

  it("500s with message only when the sender throws", async () => {
    Object.assign(process.env, TEST_SMTP);
    kindle.setMailSenderOverride(async () => {
      throw new Error("SMTP connection refused");
    });
    await seed([makeArticle("a", day(1))]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await sendRoute.POST(sendReq());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "SMTP connection refused" });
      expect(errSpy).toHaveBeenCalledTimes(1);
      const line = String(errSpy.mock.calls[0]?.[0]);
      expect(line).toContain("[POST /api/kindle/send]");
      expect(line).not.toContain("test-secret");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("429s with Retry-After like the other POST routes", async () => {
    Object.assign(process.env, TEST_SMTP);
    kindle.setMailSenderOverride(async () => undefined);
    await seed([makeArticle("a", day(1))]);
    rl.setRateLimitOverride("kindle:9.9.9.9", 1, 60_000);
    const first = await sendRoute.POST(sendReq("9.9.9.9"));
    expect(first.status).toBe(200);
    const limited = await sendRoute.POST(sendReq("9.9.9.9"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limited, retry soon" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("resetModules clears the mail-sender override (fresh module = null)", async () => {
    kindle.setMailSenderOverride(async () => undefined);
    expect(kindle.getMailSenderOverride()).not.toBeNull();
    vi.resetModules();
    const fresh = await import("../lib/kindle");
    expect(fresh.getMailSenderOverride()).toBeNull();
  });
});
