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
const ALLOWED_ATTR = ["href", "src", "alt", "title"];

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

function absolutizeUrls(doc: Document, base: string) {
  const baseUrl = new URL(base);
  doc.querySelectorAll("img").forEach((img) => {
    const el = img as HTMLImageElement;
    // promote lazy-load attrs
    const lazy = el.getAttribute("data-src") || el.getAttribute("data-original");
    if (lazy && !el.getAttribute("src")) el.setAttribute("src", lazy);
    el.removeAttribute("srcset");
    el.removeAttribute("data-src");
    el.removeAttribute("data-srcset");
    el.setAttribute("loading", "lazy");
    const src = el.getAttribute("src");
    if (src) {
      try {
        el.setAttribute("src", new URL(src, baseUrl).toString());
      } catch {
        el.removeAttribute("src");
      }
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
  const parsed = new Readability(doc).parse();
  if (!parsed || !parsed.textContent?.trim()) {
    throw new Error(
      "Could not extract article text (JS-rendered or blocked page?). Try pasting page HTML via the extension path."
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
