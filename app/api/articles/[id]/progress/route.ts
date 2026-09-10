import { NextResponse } from "next/server";
import { updateProgress } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { progress?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.progress !== "number" || Number.isNaN(body.progress)) {
    return NextResponse.json({ error: "Missing progress" }, { status: 400 });
  }
  const ok = await updateProgress(id, body.progress);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
