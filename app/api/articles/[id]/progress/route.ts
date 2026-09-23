import { NextResponse } from "next/server";
import { getArticle, updateProgressOffset } from "@/lib/store";
import { fractionToOffset } from "@/lib/progress-sync";
import {
  checkRateLimit,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_MS,
  getClientIp,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = checkRateLimit(
    `articles-progress:${getClientIp(req)}`,
    DEFAULT_RATE_LIMIT,
    DEFAULT_RATE_WINDOW_MS
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limited, retry soon" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  const { id } = await ctx.params;
  let body: { offset?: number; progress?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const hasOffset = typeof body.offset === "number" && Number.isFinite(body.offset);
  const hasProgress = typeof body.progress === "number" && Number.isFinite(body.progress);
  if (!hasOffset && !hasProgress) {
    return NextResponse.json({ error: "Missing progress" }, { status: 400 });
  }
  // Canonical offset wins when both are present.
  let offset: number;
  if (hasOffset) {
    offset = body.offset as number;
  } else {
    const article = await getArticle(id);
    if (!article) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const textLength = typeof article.text === "string" ? article.text.length : 0;
    offset = fractionToOffset(body.progress as number, textLength);
  }
  // updateProgressOffset clamps server-side against text.length.
  const updated = await updateProgressOffset(id, offset);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, offset: updated.offset, progress: updated.progress });
}
