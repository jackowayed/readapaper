import { NextResponse } from "next/server";
import { getArticle, updateProgressOffset } from "@/lib/store";
import { fractionToOffset } from "@/lib/progress-sync";
import { firstIssueMessage, ProgressBodySchema } from "@/lib/schemas";
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
  const parsed = ProgressBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssueMessage(parsed.error) }, { status: 400 });
  }
  body = parsed.data;
  // Canonical offset wins when both are present.
  let offset: number;
  if (body.offset !== undefined) {
    offset = body.offset;
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
