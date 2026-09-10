import { NextResponse } from "next/server";
import { createArticle, listArticles, toSummary } from "@/lib/store";
import { extractFromHtml, extractFromUrl } from "@/lib/extract";

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

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  const articles = await listArticles();
  return json(articles.map(toSummary));
}

export async function POST(req: Request) {
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
        return json({ error: "Page HTML too large (>10MB)" }, 422);
      }
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
    return json({ error: msg }, status);
  }
}
