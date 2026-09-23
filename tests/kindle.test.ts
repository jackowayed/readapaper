import { describe, expect, it, vi } from "vitest";
import type { Article } from "../lib/types";
import {
  KINDLE_MAX_BYTES,
  compileKindleHtml,
  getKindleBatch,
  sendToKindle,
  type KindleSender,
} from "../lib/kindle";

function makeArticle(overrides: Partial<Article> & { id: string }): Article {
  return {
    url: `https://example.com/${overrides.id}`,
    title: `Title ${overrides.id}`,
    byline: null,
    excerpt: null,
    html: `<p>Body ${overrides.id}</p>`,
    text: `Body ${overrides.id}`,
    wordCount: 2,
    progress: 0,
    progressOffset: 0,
    progressUpdatedAt: null,
    archived: false,
    archivedAt: null,
    liked: false,
    likedAt: null,
    deleted: false,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getKindleBatch", () => {
  it("orders newest (createdAt desc) first", () => {
    const articles = [
      makeArticle({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeArticle({ id: "c", createdAt: "2026-03-01T00:00:00.000Z" }),
      makeArticle({ id: "b", createdAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const { articles: batch } = getKindleBatch(articles);
    expect(batch.map((a) => a.id)).toEqual(["c", "b", "a"]);
  });

  it("excludes archived articles (fallback: archived !== true)", () => {
    const articles = [
      makeArticle({ id: "keep", createdAt: "2026-02-01T00:00:00.000Z" }),
      {
        ...makeArticle({ id: "old", createdAt: "2026-03-01T00:00:00.000Z" }),
        archived: true,
      } as unknown as Article,
      makeArticle({ id: "legacy", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const { articles: batch, totalActive } = getKindleBatch(articles);
    expect(batch.map((a) => a.id)).toEqual(["keep", "legacy"]);
    expect(totalActive).toBe(2);
  });

  it("excludes trashed articles (deleted === true)", () => {
    const articles = [
      makeArticle({ id: "keep", createdAt: "2026-02-01T00:00:00.000Z" }),
      {
        ...makeArticle({ id: "trashed", createdAt: "2026-03-01T00:00:00.000Z" }),
        deleted: true,
      } as unknown as Article,
    ];
    const { articles: batch, totalActive } = getKindleBatch(articles);
    expect(batch.map((a) => a.id)).toEqual(["keep"]);
    expect(totalActive).toBe(1);
  });

  it("caps at 50 and reports totalActive", () => {
    const articles = Array.from({ length: 60 }, (_, i) =>
      makeArticle({
        id: `a${String(i).padStart(2, "0")}`,
        createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      })
    );
    const { articles: batch, totalActive } = getKindleBatch(articles);
    expect(batch).toHaveLength(50);
    expect(totalActive).toBe(60);
    // Newest first: the two Jan-28 entries lead.
    expect(batch[0]!.createdAt.startsWith("2026-01-28")).toBe(true);
  });

  it("respects a custom limit", () => {
    const articles = [
      makeArticle({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeArticle({ id: "b", createdAt: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(getKindleBatch(articles, 1).articles.map((a) => a.id)).toEqual(["b"]);
  });
});

describe("compileKindleHtml", () => {
  it("builds one doc with a title page, TOC anchors, and one chapter per article", () => {
    const articles = [
      makeArticle({ id: "a1", title: "First", byline: "By One" }),
      makeArticle({ id: "b2", title: "Second", byline: null }),
    ];
    const compiled = compileKindleHtml(articles);
    expect(compiled.count).toBe(2);
    expect(compiled.bytes).toBeGreaterThan(0);
    expect(compiled.html).toContain("Readapaper Kindle Export");
    for (const a of articles) {
      expect(compiled.html).toContain(`href="#kindle-article-${a.id}"`);
      expect(compiled.html).toContain(`id="kindle-article-${a.id}"`);
    }
    expect(compiled.html).toContain("By One");
    // Sanitized html reused as-is.
    expect(compiled.html).toContain("<p>Body a1</p>");
  });

  it("escapes titles/URLs at chapter boundaries", () => {
    const articles = [
      makeArticle({
        id: "x",
        title: `<script>alert("t")</script>`,
        url: `https://example.com/?q="a"&b=<c>`,
      }),
    ];
    const { html } = compileKindleHtml(articles);
    expect(html).not.toContain(`<script>alert("t")</script>`);
    expect(html).toContain(`&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;`);
    expect(html).toContain(`q=&quot;a&quot;&amp;b=&lt;c&gt;`);
  });

  it("refuses oversize documents with a clear error", () => {
    const articles = [makeArticle({ id: "big", html: `<p>${"x".repeat(1000)}</p>` })];
    expect(() => compileKindleHtml(articles, { maxBytes: 10 })).toThrow(/over the.*limit/i);
  });

  it("defaults the size guard to ~40MB", () => {
    expect(KINDLE_MAX_BYTES).toBe(40 * 1024 * 1024);
  });
});

describe("sendToKindle", () => {
  it("uses the injected sender (no network) with To/Subject/attachment", async () => {
    const articles = [makeArticle({ id: "a1", title: "First" })];
    const compiled = compileKindleHtml(articles);
    const send = vi.fn<KindleSender>(async () => undefined);
    const result = await sendToKindle(send, compiled, {
      kindleEmail: "user@kindle.com",
      fromEmail: "reader@example.com",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![0];
    expect(msg.to).toBe("user@kindle.com");
    expect(msg.from).toBe("reader@example.com");
    expect(msg.subject).toContain("1 article");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]!.filename).toMatch(/\.html$/);
    expect(msg.attachments[0]!.content).toBe(compiled.html);
    expect(msg.attachments[0]!.contentType).toContain("text/html");
    expect(result).toEqual({ to: "user@kindle.com", count: 1, bytes: compiled.bytes });
  });
});
