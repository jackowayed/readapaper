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
  "p", "h1", "h2", "h3", "h4", "img", "a", "blockquote",
  "ul", "ol", "li", "em", "strong", "code", "pre",
  "figure", "figcaption", "hr", "br",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "loading", "decoding"];

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_PREFIXES = ["127.", "10.", "192.168.", "169.254.", "::1", "::ffff:127."];

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
  const host = u.hostname.toLowerCase();
  if (
    BLOCKED_HOSTS.has(host) ||
    host === "[::1]" ||
    BLOCKED_PREFIXES.some((p) => host.startsWith(p))
  ) {
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
    const preferred = withW.find((c) => c.w >= 960) ?? withW[withW.length - 1];
    return preferred.url;
  }
  const withX = candidates.filter((c) => c.x > 0).sort((a, b) => a.x - b.x);
  if (withX.length > 0) return withX[withX.length - 1].url;
  return candidates[candidates.length - 1].url;
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

export async function extractFromUrl(rawUrl: string): Promise<ExtractResult> {
  const u = assertSafeHttpUrl(rawUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !/html|xml|text/.test(contentType)) {
    throw new Error(`Unsupported content-type: ${contentType}`);
  }
  const html = await res.text();
  if (html.length > 5_000_000) throw new Error("Page too large (>5MB)");
  return extractFromHtml(html, res.url || u.toString());
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
    text: (parsed.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}
