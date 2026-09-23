import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import DOMPurify from "isomorphic-dompurify";

export type ExtractResult = {
  url: string;
  title: string;
  byline: string | null;
  excerpt: string | null;
  html: string;
  text: string;
};

const ALLOWED_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "img",
  "a",
  "blockquote",
  "ul",
  "ol",
  "li",
  "em",
  "strong",
  "code",
  "pre",
  "figure",
  "figcaption",
  "hr",
  "br",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "loading", "decoding", "target", "rel"];

export const MAX_BODY_BYTES = 5_000_000;
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);
// Backstop for dotted hosts that don't decode as numeric IPv4 (e.g. out-of-range
// octets like "127.0.0.999" that fail closed below, or trailing-dot remnants).
const BLOCKED_DOTTED_PREFIXES = ["127.", "10.", "192.168.", "169.254.", "0."];

/** Lowercase, drop IPv6 brackets (Node keeps "[::1]" in hostname) + trailing dot. */
function normalizeHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Parse one legacy IPv4 part: 0x-hex, leading-0 octal, else decimal. */
function parseIPv4Part(part: string): number | null {
  if (!part) return null;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const n = parseInt(part, 16);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (part.length > 1 && /^0[0-7]+$/.test(part)) {
    const n = parseInt(part, 8);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (/^[0-9]+$/.test(part)) {
    const n = parseInt(part, 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Decode legacy numeric IPv4 forms (inet_aton rules): single 32-bit number
 * ("2130706433", "0x7f000001") or 2-4 dot-separated decimal/octal/hex parts
 * ("0177.0.0.1", "0x7f.1"). Node's URL parser already normalizes most of these
 * to canonical quads, but decode explicitly as defense-in-depth.
 */
function decodeNumericIPv4(host: string): [number, number, number, number] | null {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  if (!host.includes(".")) {
    const n = parseIPv4Part(host);
    if (n === null || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  const parts = host.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIPv4Part(p);
    if (n === null) return null;
    nums.push(n);
  }
  if (nums.length === 4) {
    if (nums.some((n) => n < 0 || n > 255)) return null;
    return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
  }
  if (nums.length === 3) {
    const [a, b, c] = nums as [number, number, number];
    if (a > 255 || b > 255 || c > 65535) return null;
    return [a, b, (c >> 8) & 255, c & 255];
  }
  const [a, b] = nums as [number, number];
  if (a > 255 || b > 16777215) return null;
  return [a, (b >> 16) & 255, (b >> 8) & 255, b & 255];
}

type IPv4Octets = [number, number, number, number];

function isBlockedIPv4Octets(o: IPv4Octets): boolean {
  const [a, b] = o;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this network" / unspecified
  return false;
}

function isBlockedIPv6(host: string): boolean {
  if (!host.includes(":")) return false;
  // IPv4-mapped: judge the embedded tail as IPv4.
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const tail = mapped[1]!;
    if (!tail.includes(".") && !tail.includes(":")) return true;
    if (tail.includes(".")) {
      const octets = decodeNumericIPv4(tail);
      return octets ? isBlockedIPv4Octets(octets) : true;
    }
    return true; // hex/expanded tail (e.g. normalized ::ffff:7f00:1) — fail closed
  }
  if (host === "::" || host === "::1" || host === "0::0") return true;
  if (host === "0:0:0:0:0:0:0:0" || host === "0:0:0:0:0:0:0:1") return true;
  const first = host.split(":")[0] ?? "";
  if (/^fe[89ab]/i.test(first)) return true; // fe80::/10 link-local
  if (/^(fc|fd)/i.test(first)) return true; // fc00::/7 unique-local
  return false;
}

/** Decimal 172.16.0.0/12 check for dotted hosts that fail numeric decode. */
function isBlocked172(host: string): boolean {
  const m = /^172\.(\d+)\./.exec(host);
  if (!m) return false;
  const second = parseInt(m[1]!, 10);
  return second >= 16 && second <= 31;
}

export function assertSafeHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const host = normalizeHost(u.hostname);
  if (!host) throw new Error("Blocked host");
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error("Blocked host");
  }
  if (isBlockedIPv6(host)) {
    throw new Error("Blocked host");
  }
  const octets = decodeNumericIPv4(host);
  if (octets) {
    if (isBlockedIPv4Octets(octets)) throw new Error("Blocked host");
    return u;
  }
  if (BLOCKED_DOTTED_PREFIXES.some((p) => host.startsWith(p)) || isBlocked172(host)) {
    throw new Error("Blocked host");
  }
  return u;
}

function pickFromSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  // "url1 80w, url2 640w, ..." or "url1 1x, url2 2x"
  const candidates: { url: string; w: number; x: number }[] = [];
  for (const part of srcset.split(",")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const url = tokens[0];
    if (!url || url.startsWith("data:")) continue;
    let w = 0;
    let x = 0;
    const d = tokens[1] ?? "";
    if (d.endsWith("w")) w = parseInt(d, 10) || 0;
    else if (d.endsWith("x")) x = parseFloat(d) || 0;
    candidates.push({ url, w, x });
  }
  if (candidates.length === 0) return null;
  const withW = candidates.filter((c) => c.w > 0).sort((a, b) => a.w - b.w);
  if (withW.length > 0) {
    // Prefer something around reader-column width (~960px); else largest.
    const preferred = withW.find((c) => c.w >= 960) ?? withW[withW.length - 1]!;
    return preferred.url;
  }
  const withX = candidates.filter((c) => c.x > 0).sort((a, b) => a.x - b.x);
  if (withX.length > 0) return withX[withX.length - 1]!.url;
  return candidates[candidates.length - 1]!.url;
}

function isPlaceholderSrc(src: string | null): boolean {
  if (!src) return true;
  const s = src.trim();
  if (!s) return true;
  if (s.startsWith("data:")) return true;
  if (s.startsWith("blob:")) return true;
  if (s === "about:blank") return true;
  return false;
}

const LAZY_SRC_ATTRS = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-original-src",
  "data-image-src",
  "data-image",
  "data-lazy",
  "data-url",
];
const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset", "data-original-srcset"];

function absolutizeUrls(doc: Document, base: string) {
  const baseUrl = new URL(base);
  const toAbs = (v: string | null): string | null => {
    if (!v || isPlaceholderSrc(v)) return null;
    try {
      const abs = new URL(v.trim(), baseUrl).toString();
      if (abs.startsWith("data:") || abs.startsWith("blob:")) return null;
      return abs;
    } catch {
      return null;
    }
  };
  doc.querySelectorAll("img").forEach((img) => {
    const el = img as HTMLImageElement;

    // 1. usable src wins
    let src = toAbs(el.getAttribute("src"));

    // 2. lazy-load attrs
    if (!src) {
      for (const attr of LAZY_SRC_ATTRS) {
        src = toAbs(el.getAttribute(attr));
        if (src) break;
      }
    }

    // 3. srcset / lazy srcset (many sites, e.g. Hearst/SFGate, ship srcset-only <img>)
    if (!src) {
      src = toAbs(pickFromSrcset(el.getAttribute("srcset")));
    }
    if (!src) {
      for (const attr of LAZY_SRCSET_ATTRS) {
        src = toAbs(pickFromSrcset(el.getAttribute(attr)));
        if (src) break;
      }
    }

    // 4. <picture><source srcset> fallback
    if (!src) {
      const picture = el.parentElement;
      if (picture && picture.tagName.toLowerCase() === "picture") {
        const sources = picture.querySelectorAll("source[srcset], source[data-srcset]");
        for (const s of Array.from(sources)) {
          src =
            toAbs(pickFromSrcset(s.getAttribute("srcset"))) ??
            toAbs(pickFromSrcset(s.getAttribute("data-srcset")));
          if (src) break;
        }
      }
    }

    // Clean lazy/responsive attrs; we keep a single absolutized src
    // to avoid broken srcset URLs and layout shift in reader view.
    el.removeAttribute("srcset");
    el.removeAttribute("sizes");
    for (const attr of [...LAZY_SRC_ATTRS, ...LAZY_SRCSET_ATTRS]) el.removeAttribute(attr);

    if (src) {
      el.setAttribute("src", src);
      el.setAttribute("loading", "lazy");
      el.setAttribute("decoding", "async");
    } else {
      // No recoverable URL (tracking pixel, empty) — drop so the
      // reader doesn't render broken-image icons.
      el.remove();
    }
  });
  doc.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href");
    if (href) {
      try {
        a.setAttribute("href", new URL(href, baseUrl).toString());
      } catch {
        a.removeAttribute("href");
      }
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
}

/** text/html + application/xhtml+xml (charset suffix ok); empty/missing allowed. */
function assertAllowedContentType(raw: string | null): void {
  if (!raw || !raw.trim()) return;
  const mediaType = raw.split(";")[0]!.trim().toLowerCase();
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return;
  throw new Error(`Unsupported content-type: ${raw}`);
}

function assertAllowedContentLength(res: Response): void {
  const raw = res.headers.get("content-length");
  if (raw === null) return;
  const parsed = parseInt(raw.trim(), 10);
  if (Number.isFinite(parsed) && parsed > MAX_BODY_BYTES) {
    throw new Error(`Page too large (>5MB, Content-Length: ${parsed})`);
  }
}

/**
 * Read the body with an incremental byte cap so oversize pages abort early.
 * Falls back to res.text() for stubbed bodies without a stream, keeping the
 * post-read length check as a backstop in both paths.
 */
async function readBodyWithLimit(res: Response): Promise<string> {
  const stream = res.body;
  if (!stream || typeof stream.getReader !== "function") {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("Page too large (>5MB)");
    return text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // ignore cleanup errors; the size error below is what matters
        }
        throw new Error("Page too large (>5MB)");
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  if (text.length > MAX_BODY_BYTES) throw new Error("Page too large (>5MB)");
  return text;
}

export async function extractFromUrl(rawUrl: string): Promise<ExtractResult> {
  let current = assertSafeHttpUrl(rawUrl);
  let res: Response | undefined;
  // Manual redirect chain: every hop (initial + each Location resolved against
  // the current URL, relative included) is re-validated by assertSafeHttpUrl,
  // so a redirect to an internal host fails closed instead of being followed.
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      res = await fetch(current.toString(), {
        signal: ctrl.signal,
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!REDIRECT_STATUSES.has(res.status)) break;
    if (hop >= MAX_REDIRECT_HOPS) throw new Error("Too many redirects");
    const location = res.headers.get("location");
    if (!location) throw new Error(`Redirect without Location: ${res.status}`);
    try {
      await res.body?.cancel();
    } catch {
      // ignore cleanup errors on the redirect hop body
    }
    let next: URL;
    try {
      next = new URL(location, current.toString());
    } catch {
      throw new Error("Invalid redirect URL");
    }
    current = assertSafeHttpUrl(next.toString());
  }
  const finalRes = res!;
  if (!finalRes.ok) throw new Error(`Fetch failed: ${finalRes.status}`);
  assertAllowedContentLength(finalRes);
  const contentType = finalRes.headers.get("content-type") ?? "";
  assertAllowedContentType(contentType);
  const html = await readBodyWithLimit(finalRes);
  return extractFromHtml(html, finalRes.url || current.toString());
}

export function extractFromHtml(html: string, baseUrl: string): ExtractResult {
  const dom = new JSDOM(html, { url: baseUrl });
  const doc = dom.window.document;
  // Pre-pass before Readability: promote srcset/lazy attrs to src so
  // Readability keeps srcset-only <img> (it drops src-less images) and
  // <picture><source> fallbacks.
  absolutizeUrls(doc, baseUrl);
  const parsed = new Readability(doc).parse();
  if (!parsed || !parsed.textContent?.trim()) {
    throw new Error(
      "Could not extract article text (JS-rendered or blocked page?). Use the bookmarklet (/bookmarklet) to save from the live page DOM."
    );
  }
  // Sanitize the Readability HTML fragment in a fresh doc so URLs absolutize correctly
  const frag = new JSDOM(`<body>${parsed.content ?? ""}</body>`, { url: baseUrl });
  const fdoc = frag.window.document;
  absolutizeUrls(fdoc, baseUrl);
  const dirty = fdoc.body.innerHTML;
  const clean = DOMPurify.sanitize(dirty, { ALLOWED_TAGS, ALLOWED_ATTR }) as unknown as string;

  return {
    url: baseUrl,
    title: (parsed.title ?? "Untitled").trim() || "Untitled",
    byline: parsed.byline?.trim() || null,
    excerpt: parsed.excerpt?.trim() || null,
    html: clean,
    text: (parsed.textContent ?? "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}
