import { NextResponse } from "next/server";
import { createArticle, listArticles, toSummary } from "@/lib/store";
import { extractFromHtml, extractFromUrl, assertSafeHttpUrl } from "@/lib/extract";
import {
  checkRateLimit,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_MS,
  getClientIp,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS_HEADERS });
}

/** Host only (never full URL/body) for error logs; "unknown" when unparseable. */
function safeHost(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "unknown";
  try {
    return new URL(raw).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: Request) {
  const param = new URL(req.url).searchParams.get("archived");
  if (param === "all") {
    const articles = await listArticles();
    return json(articles.map(toSummary));
  }
  if (param === "1") {
    const articles = await listArticles({ archived: true });
    return json(articles.map(toSummary));
  }
  if (param === null || param === "0") {
    const articles = await listArticles({ archived: false });
    return json(articles.map(toSummary));
  }
  return json({ error: "Invalid archived param (expected 0, 1, or all)" }, 400);
}

export async function POST(req: Request) {
  const rl = checkRateLimit(
    `articles:${getClientIp(req)}`,
    DEFAULT_RATE_LIMIT,
    DEFAULT_RATE_WINDOW_MS
  );
  if (!rl.ok) {
    const res = json({ error: "Rate limited, retry soon" }, 429);
    res.headers.set("Retry-After", String(rl.retryAfterSec));
    return res;
  }
  let body: { url?: string; html?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  try {
    if (body.html && typeof body.html === "string") {
      // Client-side extracted HTML path (bookmarklet / extension fallback for
      // blocked pages). Runs in the page's DOM so it carries cookies, rendered
      // JS, and paywall-unlocked text the server fetch can't see.
      if (body.html.length > 10_000_000) {
        console.error(
          `[POST /api/articles] html too large host=${safeHost(body.url)} bytes=${body.html.length}`
        );
        return json({ error: "Page HTML too large (>10MB)" }, 422);
      }
      if (typeof body.url === "string" && body.url) {
        try {
          assertSafeHttpUrl(body.url);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "Invalid URL" }, 400);
        }
      }
      // No url: keep the localhost fallback for parsing (extracted.url then
      // persists as the fallback — pre-existing behavior, kept for minimal diff).
      const base = typeof body.url === "string" && body.url ? body.url : "https://localhost/";
      const extracted = extractFromHtml(body.html, base);
      const { article, created } = await createArticle(extracted);
      return json(article, created ? 201 : 200);
    }
    if (!body.url || typeof body.url !== "string") {
      return json({ error: "Provide url or html" }, 400);
    }
    const extracted = await extractFromUrl(body.url);
    const { article, created } = await createArticle(extracted);
    return json(article, created ? 201 : 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Save failed";
    const status = /Invalid|Only http|Blocked/.test(msg) ? 400 : 422;
    if (status === 422 || status >= 500) {
      console.error(`[POST /api/articles] save failed host=${safeHost(body.url)} err=${msg}`);
    }
    return json({ error: msg }, status);
  }
}
