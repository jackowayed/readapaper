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
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/",
    "http://[::1]/x",
    "http://[::]/",
    "http://[0::0]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://0.0.0.0/",
    "http://0/",
    // Decimal / octal / hex IPv4 encodings of loopback (and other blocked ranges).
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0x7f.0.0.1/",
    "http://0x7f.1/",
    "http://127.1/",
    "http://10.1/",
    "http://0x0a.0.0.1/",
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
    "http://172.15.255.255/",
    "http://172.32.0.1/",
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
    // absolutizeUrls sets target=_blank + rel=noopener noreferrer and the
    // DOMPurify allowlist (lib/extract.ts ALLOWED_ATTR) keeps them.
    for (const a of doc.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
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
    contentType: string | null = "text/html; charset=utf-8",
    url = "https://example.com/final",
    contentLength: string | null = null
  ) => ({
    ok: true,
    status: 200,
    url,
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "content-length") return contentLength;
        return null;
      },
    },
    text: async () => html,
  });

  const redirectTo = (location: string, url = "https://example.com/start") => ({
    ok: false,
    status: 302,
    url,
    headers: {
      get: (k: string) => (k.toLowerCase() === "location" ? location : null),
    },
  });

  /** Chunked-stream body mock for the incremental size-cap path. */
  const streamPage = (
    chunks: Uint8Array[],
    contentType: string | null = "text/html; charset=utf-8",
    url = "https://example.com/stream"
  ) => {
    let i = 0;
    return {
      ok: true,
      status: 200,
      url,
      headers: {
        get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null),
      },
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length
              ? { done: false, value: chunks[i++]! }
              : { done: true, value: undefined },
          cancel: async () => {},
        }),
      },
    };
  };

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

  it.each(["text/plain; charset=utf-8", "application/json", "image/png"])(
    "rejects content-type %s",
    async (contentType) => {
      stubFetch(() => okPage("x", contentType));
      await expect(extractFromUrl("https://example.com/x")).rejects.toThrow(
        /Unsupported content-type/
      );
    }
  );

  it.each([
    "text/html; charset=utf-8",
    "text/html",
    "application/xhtml+xml; charset=utf-8",
    "application/xhtml+xml",
    "Text/HTML; Charset=UTF-8",
  ])("allows content-type %s", async (contentType) => {
    stubFetch(() => okPage(loadFixture("simple"), contentType));
    const r = await extractFromUrl("https://example.com/x");
    expect(r.title).toBe("The Quiet Science of Reading on Screens");
  });

  it.each([null, ""])("allows missing/empty content-type (%s)", async (contentType) => {
    stubFetch(() => okPage(loadFixture("simple"), contentType));
    const r = await extractFromUrl("https://example.com/x");
    expect(r.title).toBe("The Quiet Science of Reading on Screens");
  });

  it("throws when the page exceeds 5MB", async () => {
    stubFetch(() => okPage("x".repeat(5_000_001)));
    await expect(extractFromUrl("https://example.com/huge")).rejects.toThrow(/too large/);
  });

  it("rejects an oversize Content-Length before reading the body", async () => {
    let textCalled = false;
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      url: "https://example.com/big",
      headers: {
        get: (k: string) => {
          const key = k.toLowerCase();
          if (key === "content-length") return "5000001";
          if (key === "content-type") return "text/html; charset=utf-8";
          return null;
        },
      },
      text: async () => {
        textCalled = true;
        return "x";
      },
    }));
    await expect(extractFromUrl("https://example.com/big")).rejects.toThrow(/too large/);
    expect(textCalled).toBe(false);
  });

  it("aborts a streaming body that exceeds 5MB mid-read", async () => {
    const oneMB = new Uint8Array(1_000_000).fill(120); // "x"
    stubFetch(() => streamPage([oneMB, oneMB, oneMB, oneMB, oneMB, oneMB]));
    await expect(extractFromUrl("https://example.com/stream")).rejects.toThrow(/too large/);
  });

  it("extracts a streaming body that stays under 5MB", async () => {
    const bytes = new TextEncoder().encode(loadFixture("simple"));
    const mid = Math.floor(bytes.length / 2);
    stubFetch(() => streamPage([bytes.slice(0, mid), bytes.slice(mid)]));
    const r = await extractFromUrl("https://example.com/stream");
    expect(r.title).toBe("The Quiet Science of Reading on Screens");
    expect(r.url).toBe("https://example.com/stream");
  });

  it("validates the URL before fetching", async () => {
    const { calls } = stubFetch(() => okPage("x"));
    await expect(extractFromUrl("ftp://example.com/x")).rejects.toThrow(/Only http/);
    expect(calls).toHaveLength(0);
  });

  it("blocks a redirect to an internal host without following it", async () => {
    const { calls } = stubFetch((url) =>
      url === "https://example.com/start"
        ? redirectTo("http://169.254.169.254/latest/meta-data")
        : okPage("must not be fetched")
    );
    await expect(extractFromUrl("https://example.com/start")).rejects.toThrow(/Blocked host/);
    expect(calls).toEqual(["https://example.com/start"]);
  });

  it("blocks a redirect to an internal host on a later hop", async () => {
    const { calls } = stubFetch((url) => {
      if (url === "https://example.com/start") return redirectTo("https://example.com/hop2");
      if (url === "https://example.com/hop2") return redirectTo("http://127.0.0.1:8080/admin");
      return okPage("must not be fetched");
    });
    await expect(extractFromUrl("https://example.com/start")).rejects.toThrow(/Blocked host/);
    expect(calls).toEqual(["https://example.com/start", "https://example.com/hop2"]);
  });

  it("follows a relative Location against the current URL", async () => {
    const { calls } = stubFetch((url) =>
      url === "https://example.com/start" ? redirectTo("/final") : okPage(loadFixture("simple"))
    );
    const r = await extractFromUrl("https://example.com/start");
    expect(calls).toEqual(["https://example.com/start", "https://example.com/final"]);
    expect(r.title).toBe("The Quiet Science of Reading on Screens");
    expect(r.url).toBe("https://example.com/final");
  });

  it("blocks a protocol-relative redirect to an internal host", async () => {
    const { calls } = stubFetch((url) =>
      url === "https://example.com/start"
        ? redirectTo("//127.0.0.1/admin")
        : okPage("must not be fetched")
    );
    await expect(extractFromUrl("https://example.com/start")).rejects.toThrow(/Blocked host/);
    expect(calls).toEqual(["https://example.com/start"]);
  });

  it("rejects a redirect to a non-http(s) URL", async () => {
    stubFetch(() => redirectTo("ftp://example.com/x"));
    await expect(extractFromUrl("https://example.com/start")).rejects.toThrow(/Only http/);
  });

  it("gives up after too many redirects", async () => {
    const { calls } = stubFetch((url) => redirectTo("https://example.com/loop", url));
    await expect(extractFromUrl("https://example.com/loop")).rejects.toThrow(/Too many redirects/);
    expect(calls).toHaveLength(6); // initial + 5 hops
  });
});
