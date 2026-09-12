import { NextResponse } from "next/server";
import { listArticles } from "@/lib/store";
import { isKindleConfigured } from "@/lib/kindle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/kindle/status → { configured, activeCount }.
 * Never includes secrets — just whether SMTP/Kindle env is present and how
 * many active (non-archived) articles would be batched.
 */
export async function GET() {
  const articles = await listArticles({ archived: false });
  return NextResponse.json({
    configured: isKindleConfigured(),
    activeCount: articles.length,
  });
}
