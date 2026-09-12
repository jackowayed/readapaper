import { NextResponse } from "next/server";
import { setArchived } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { archived?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.archived !== "boolean") {
    return NextResponse.json({ error: "Missing archived" }, { status: 400 });
  }
  const updated = await setArchived(id, body.archived);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, archived: updated.archived });
}
