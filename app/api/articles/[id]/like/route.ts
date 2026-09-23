import { NextResponse } from "next/server";
import { setLiked } from "@/lib/store";
import { firstIssueMessage, LikeBodySchema } from "@/lib/schemas";
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
    `articles-like:${getClientIp(req)}`,
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
  let body: { liked?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = LikeBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssueMessage(parsed.error) }, { status: 400 });
  }
  const updated = await setLiked(id, parsed.data.liked);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, liked: updated.liked });
}
