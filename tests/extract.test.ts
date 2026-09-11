import { readFileSync } from "fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeHttpUrl, extractFromHtml, extractFromUrl } from "../lib/extract";

const BASE = "https://example.com/articles/hello";

function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
}

/** Minimal readable page around an arbitrary body fragment. */
function articlePage(body: string): string {
  return `<html><head><title>T</title></head><body><article><h1>T</h1><p>${"Word ".repeat(200)}</p>${body}<p>${"More ".repeat(200)}</p></article></body></html>`;
}

function parseBody(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("assertSafeHttpUrl", () => {
  it.each([
    "http://localhost/",
    "http://localhost:3000/x",
    "HTTP://LOCALHOST:3000/x",
    "http://127.0.0.1/",
    "http://127.1.2.3:8080/a",
    "http://10.0.0.5/",
    "http://192.168.1.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/",
    "http://[::1]/x",
  ])("blocks %s", (raw) => {
    expect(() => assertSafeHttpUrl(raw)).toThrow(/Blocked host/);
  });

  it.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
  ])("rejects non-http(s) URL %s", (raw) => {
    expect(() => assertSafeHttpUrl(raw)).toThrow(/Only http\(s\)/);
  });

  it("rejects malformed URLs", () => {
    expect(() => assertSafeHttpUrl("not a url")).toThrow(/Invalid URL/);
    expect(() => assertSafeHttpUrl("")).toThrow(/Invalid URL/);
  });

  it.each([
    "https://example.com/article",
    "http://example.com:8080/x?q=1#frag",
    "https://sub.domain.co.uk/a/b",
  ])("allows %s", (raw) => {
    expect(assertSafeHttpUrl(raw).toString()).toBe(new URL(raw).toString());
  });
});

describe("extractFromHtml", () => {
  it("extracts a simple article with title, byline, and excerpt", () => {
    const r = extractFromHtml(loadFixture("simple"), BASE);
    expect(r.url).toBe(BASE);
    expect(r.title).toBe("The Quiet Science of Reading on Screens");
    expect(r.byline).toBe("Jane Reporter");
    expect(r.excerpt).toBe("Typography, line length, and image placement shape comprehension.");
    expect(r.text).toContain("Researchers have spent decades");
    expect(r.html).toContain("Researchers have spent decades");
  });

  it("absolutizes href/src and keeps lazy/decoding hints on images", () => {
    const r = extractFromHtml(loadFixture("simple"), BASE);
    const doc = parseBody(r.html);
    const img = doc.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/images/reader.jpg");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("decoding")).toBe("async");
    const hrefs = [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://example.com/authors/jane");
    expect(hrefs).toContain("https://example.com/topics/reading");
    // NOTE: absolutizeUrls sets target=_blank pre-sanitize, but the DOMPurify
    // allowlist (lib/extract.ts ALLOWED_ATTR) strips target/rel. Locked as-is;
    // follow-up: add target/rel to the allowlist or drop the dead code.
    for (const a of doc.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBeNull();
    }
  });

  it("promotes srcset-only <img> to a single absolutized src", () => {
    const r = extractFromHtml(loadFixture("srcset-only"), BASE);
    const doc = parseBody(r.html);
    const img = doc.querySelector("img");
    // Prefers the first candidate >= ~960px column width.
    expect(img?.getAttribute("src")).toBe("https://example.com/img/medium.jpg");
    expect(img?.hasAttribute("srcset")).toBe(false);
  });

  it("resolves data-src lazy images over data: placeholders", () => {
    const r = extractFromHtml(loadFixture("lazy"), BASE);
    const doc = parseBody(r.html);
    const img = doc.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/img/lazy-real.jpg");
    expect(img?.hasAttribute("data-src")).toBe(false);
    expect(r.html).not.toContain("data:image");
  });

  it("falls back to <picture><source> srcset", () => {
    const r = extractFromHtml(loadFixture("picture"), BASE);
    const doc = parseBody(r.html);
    const img = doc.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/img/pic-1200.jpg");
  });

  it("drops data:/blob: placeholder images", () => {
    const r = extractFromHtml(loadFixture("placeholder"), BASE);
    const doc = parseBody(r.html);
    expect(doc.querySelector("img")).toBeNull();
    expect(r.html).not.toContain("data:image");
    expect(r.html).not.toContain("blob:");
    // Article text itself survives.
    expect(r.text).toContain("Researchers have spent decades");
  });

  it("strips <script> tags", () => {
    const r = extractFromHtml(loadFixture("script"), BASE);
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toContain('alert("xss")');
    expect(r.html).not.toContain("evil.js");
    expect(r.text).toContain("Article pages are full of scripts");
  });

  it("falls back to 'Untitled' when the page has no title", () => {
    const html = `<html><body><article><h1>No Title Tag Here</h1><p>${"Word ".repeat(300)}</p></article></body></html>`;
    expect(extractFromHtml(html, BASE).title).toBe("Untitled");
  });

  it("throws on empty or content-free HTML", () => {
    expect(() => extractFromHtml("", BASE)).toThrow(/Could not extract article text/);
    expect(() => extractFromHtml("<html><head></head><body></body></html>", BASE)).toThrow(
      /Could not extract article text/
    );
  });

  it("picks the highest x-descriptor from srcset", () => {
    const r = extractFromHtml(
      articlePage('<img srcset="/img/a.jpg 1x, /img/b.jpg 2x" alt="x">'),
      BASE
    );
    expect(parseBody(r.html).querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/img/b.jpg"
    );
  });

  it("picks the last bare URL from srcset", () => {
    const r = extractFromHtml(articlePage('<img srcset="/img/a.jpg, /img/b.jpg" alt="x">'), BASE);
    expect(parseBody(r.html).querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/img/b.jpg"
    );
  });

  it("resolves lazy data-srcset attributes", () => {
    const r = extractFromHtml(
      articlePage('<img data-srcset="/img/a.jpg 400w, /img/b.jpg 1200w" alt="x">'),
      BASE
    );
    expect(parseBody(r.html).querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/img/b.jpg"
    );
  });
});

describe("extractFromUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(impl: (url: string) => unknown): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return impl(url);
    });
    return { calls };
  }

  const okPage = (
    html: string,
    contentType = "text/html; charset=utf-8",
    url = "https://example.com/final"
  ) => ({
    ok: true,
    status: 200,
    url,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => html,
  });

  it("fetches, then extracts with the final response URL", async () => {
    stubFetch(() => okPage(loadFixture("simple")));
    const r = await extractFromUrl("https://example.com/start");
    expect(r.title).toBe("The Quiet Science of Reading on Screens");
    expect(r.url).toBe("https://example.com/final");
    expect(r.text).toContain("Researchers have spent decades");
  });

  it("throws on non-OK status", async () => {
    stubFetch(() => ({ ...okPage("x"), ok: false, status: 404 }));
    await expect(extractFromUrl("https://example.com/missing")).rejects.toThrow(
      /Fetch failed: 404/
    );
  });

  it("throws on unsupported content-type", async () => {
    stubFetch(() => okPage("%PDF-1.4", "application/pdf"));
    await expect(extractFromUrl("https://example.com/f.pdf")).rejects.toThrow(
      /Unsupported content-type/
    );
  });

  it("throws when the page exceeds 5MB", async () => {
    stubFetch(() => okPage("x".repeat(5_000_001)));
    await expect(extractFromUrl("https://example.com/huge")).rejects.toThrow(/too large/);
  });

  it("validates the URL before fetching", async () => {
    const { calls } = stubFetch(() => okPage("x"));
    await expect(extractFromUrl("ftp://example.com/x")).rejects.toThrow(/Only http/);
    expect(calls).toHaveLength(0);
  });
});
