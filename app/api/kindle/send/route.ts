import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { listArticles } from "@/lib/store";
import {
  compileKindleHtml,
  DEFAULT_KINDLE_LIMIT,
  getKindleBatch,
  getKindleSmtpConfig,
  getMailSenderOverride,
  KINDLE_SETUP_HINT,
  sendToKindle,
  type KindleMailMessage,
} from "@/lib/kindle";
import {
  checkRateLimit,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_MS,
  getClientIp,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * POST /api/kindle/send → { ok: true, sent: 1, count, bytes }.
 * - 429 when rate-limited (same 30 req/min/IP policy as the other POSTs).
 * - 503 when SMTP/Kindle env is missing (setup hint, never secrets/stacks).
 * - 400 when there are no active articles to send.
 * - 500 on compile/send failure (message only, no secrets).
 */
export async function POST(req: Request) {
  const rl = checkRateLimit(
    `kindle:${getClientIp(req)}`,
    DEFAULT_RATE_LIMIT,
    DEFAULT_RATE_WINDOW_MS
  );
  if (!rl.ok) {
    const res = json({ error: "Rate limited, retry soon" }, 429);
    res.headers.set("Retry-After", String(rl.retryAfterSec));
    return res;
  }

  const smtp = getKindleSmtpConfig();
  if (!smtp) {
    return json({ error: "Kindle sending is not configured", setup: KINDLE_SETUP_HINT }, 503);
  }

  const all = await listArticles({ archived: false });
  const { articles: batch, totalActive } = getKindleBatch(all, DEFAULT_KINDLE_LIMIT);
  void totalActive;
  if (batch.length === 0) {
    return json({ error: "No active articles to send" }, 400);
  }

  let compiled: { html: string; bytes: number; count: number };
  try {
    compiled = compileKindleHtml(batch);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Kindle document failed to compile";
    console.error(`[POST /api/kindle/send] compile failed count=${batch.length} err=${msg}`);
    return json({ error: msg }, 500);
  }

  const override = getMailSenderOverride();
  const send = override
    ? override
    : async (message: KindleMailMessage) => {
        const transport = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: { user: smtp.user, pass: smtp.pass },
        });
        await transport.sendMail({
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: `Readapaper Kindle Export — ${compiled.count} article(s). See the attached HTML document.`,
          attachments: message.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          })),
        });
      };

  try {
    await sendToKindle(send, compiled, {
      kindleEmail: smtp.kindleEmail,
      fromEmail: smtp.fromEmail,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Kindle send failed";
    // Message only: never echo env values, addresses, or stacks.
    console.error(`[POST /api/kindle/send] send failed count=${compiled.count} err=${msg}`);
    return json({ error: msg }, 500);
  }

  return json({ ok: true, sent: 1, count: compiled.count, bytes: compiled.bytes });
}
