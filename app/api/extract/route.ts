import { NextResponse } from "next/server";
import { extractFromUrl } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  try {
    const result = await extractFromUrl(body.url);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Extraction failed";
    const status = /Invalid|Only http|Blocked/.test(msg) ? 400 : 422;
    return NextResponse.json({ error: msg }, { status });
  }
}
