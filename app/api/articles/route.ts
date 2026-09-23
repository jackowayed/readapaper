import { NextResponse } from "next/server";
import { createArticle, listArticles, toSummary } from "@/lib/store";
import type { SortKey } from "@/lib/store";
import { extractFromHtml, extractFromUrl, assertSafeHttpUrl } from "@/lib/extract";
import { firstIssueMessage, SaveBodySchema } from "@/lib/schemas";
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

const SORT_KEYS: SortKey[] = ["newest", "oldest", "longest", "shortest", "progress"];

export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const rawSort = searchParams.get("sort");
  const sort: SortKey = rawSort === null ? "newest" : (rawSort as SortKey);
  if (rawSort !== null && !SORT_KEYS.includes(sort)) {
    return json({ error: `Invalid sort, expected one of: ${SORT_KEYS.join(", ")}` }, 400);
  }
  const rawQ = searchParams.get("q");
  const q = rawQ === null ? undefined : rawQ.trim();
  if (q !== undefined && q.length > 200) {
    return json({ error: "Query too long (max 200 chars)" }, 400);
  }
  const archivedParam = searchParams.get("archived");
  const likedOnly = searchParams.get("liked") === "1";
  const liked = likedOnly ? true : undefined;
  // Trash scope: ?deleted=1 shows soft-deleted rows. Inside trash the
  // archived scope defaults to "all" (trashed items keep their archived
  // flag); an explicit ?archived=1/0 narrows, ?archived=all is the default.
  if (searchParams.get("deleted") === "1") {
    if (
      archivedParam !== null &&
      archivedParam !== "1" &&
      archivedParam !== "0" &&
      archivedParam !== "all"
    ) {
      return json({ error: "Invalid archived param (expected 0, 1, or all)" }, 400);
    }
    const filter: {
      archived?: boolean;
      liked?: boolean;
      deleted: boolean;
      q?: string;
      sort?: SortKey;
    } = { deleted: true, q, sort };
    if (archivedParam === "1") filter.archived = true;
    else if (archivedParam === "0") filter.archived = false;
    if (likedOnly) filter.liked = true;
    const articles = await listArticles(filter);
    return json(articles.map(toSummary));
  }
  // Liked narrows within the archived scope (default active-only).
  if (archivedParam === "all") {
    const articles = await listArticles({ q, sort, ...(liked !== undefined ? { liked } : {}) });
    return json(articles.map(toSummary));
  }
  if (archivedParam === "1") {
    const articles = await listArticles({
      archived: true,
      q,
      sort,
      ...(liked !== undefined ? { liked } : {}),
    });
    return json(articles.map(toSummary));
  }
  if (archivedParam === null || archivedParam === "0") {
    const articles = await listArticles({
      archived: false,
      q,
      sort,
      ...(liked !== undefined ? { liked } : {}),
    });
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
  const parsed = SaveBodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: firstIssueMessage(parsed.error) }, 400);
  }
  body = parsed.data;
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
