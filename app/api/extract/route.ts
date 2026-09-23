import { NextResponse } from "next/server";
import { extractFromUrl } from "@/lib/extract";
import { ExtractBodySchema, firstIssueMessage } from "@/lib/schemas";
import {
  checkRateLimit,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_MS,
  getClientIp,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Host only (never full URL/body) for error logs; "unknown" when unparseable. */
function safeHost(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "unknown";
  try {
    return new URL(raw).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

export async function POST(req: Request) {
  const rl = checkRateLimit(
    `extract:${getClientIp(req)}`,
    DEFAULT_RATE_LIMIT,
    DEFAULT_RATE_WINDOW_MS
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limited, retry soon" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = ExtractBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssueMessage(parsed.error) }, { status: 400 });
  }
  const { url } = parsed.data;
  try {
    const result = await extractFromUrl(url);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Extraction failed";
    const status = /Invalid|Only http|Blocked/.test(msg) ? 400 : 422;
    if (status === 422 || status >= 500) {
      console.error(`[POST /api/extract] extraction failed host=${safeHost(url)} err=${msg}`);
    }
    return NextResponse.json({ error: msg }, { status });
  }
}
