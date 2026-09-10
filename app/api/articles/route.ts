import { NextResponse } from "next/server";
import { createArticle, listArticles, toSummary } from "@/lib/store";
import { extractFromHtml, extractFromUrl } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const articles = await listArticles();
  return NextResponse.json(articles.map(toSummary));
}

export async function POST(req: Request) {
  let body: { url?: string; html?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    if (body.html && typeof body.html === "string") {
      // Client-side extracted HTML path (extension/paste fallback for blocked pages)
      const base = typeof body.url === "string" && body.url ? body.url : "https://localhost/";
      const extracted = extractFromHtml(body.html, base);
      const article = await createArticle(extracted);
      return NextResponse.json(article, { status: 201 });
    }
    if (!body.url || typeof body.url !== "string") {
      return NextResponse.json({ error: "Provide url or html" }, { status: 400 });
    }
    const extracted = await extractFromUrl(body.url);
    const article = await createArticle(extracted);
    return NextResponse.json(article, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Save failed";
    const status = /Invalid|Only http|Blocked/.test(msg) ? 400 : 422;
    return NextResponse.json({ error: msg }, { status });
  }
}
