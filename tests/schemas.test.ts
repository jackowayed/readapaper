import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ArchiveBodySchema,
  ArticleSchema,
  ExtractBodySchema,
  LikeBodySchema,
  ProgressBodySchema,
  SaveBodySchema,
  TrashBodySchema,
  firstIssueMessage,
} from "../lib/schemas";

describe("firstIssueMessage", () => {
  it("returns the first issue message", () => {
    const parsed = ExtractBodySchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(firstIssueMessage(parsed.error)).toBe("Missing url");
    }
  });

  it("falls back when there are no issues", () => {
    expect(firstIssueMessage(new z.ZodError([]))).toBe("Invalid request");
  });
});

describe("ExtractBodySchema", () => {
  it("accepts a url", () => {
    expect(ExtractBodySchema.safeParse({ url: "https://example.com/a" }).success).toBe(true);
  });

  it("rejects missing/empty/wrong-type urls with the legacy message", () => {
    for (const body of [{}, { url: "" }, { url: 42 }, { url: null }]) {
      const parsed = ExtractBodySchema.safeParse(body);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(firstIssueMessage(parsed.error)).toBe("Missing url");
    }
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, [1], "url", 42]) {
      expect(ExtractBodySchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("SaveBodySchema", () => {
  it("accepts url-only, html-only, or both", () => {
    expect(SaveBodySchema.safeParse({ url: "https://example.com/a" }).success).toBe(true);
    expect(SaveBodySchema.safeParse({ html: "<p>hi</p>" }).success).toBe(true);
    expect(
      SaveBodySchema.safeParse({ url: "https://example.com/a", html: "<p>hi</p>" }).success
    ).toBe(true);
  });

  it("rejects empty/missing bodies with the legacy message", () => {
    for (const body of [{}, { url: "" }, { html: "" }, { url: "", html: "" }]) {
      const parsed = SaveBodySchema.safeParse(body);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(firstIssueMessage(parsed.error)).toBe("Provide url or html");
    }
  });

  it("rejects wrong-type fields and non-object bodies", () => {
    for (const body of [{ url: 42 }, { html: 42 }, null, [1], "x"]) {
      expect(SaveBodySchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("ProgressBodySchema", () => {
  it("accepts offset, progress, or both (offset wins at the route)", () => {
    expect(ProgressBodySchema.safeParse({ offset: 10 }).success).toBe(true);
    expect(ProgressBodySchema.safeParse({ progress: 0.5 }).success).toBe(true);
    expect(ProgressBodySchema.safeParse({ offset: 3, progress: 0.1 }).success).toBe(true);
  });

  it("rejects missing/non-numeric/non-finite values with the legacy message", () => {
    for (const body of [
      {},
      { offset: "10" },
      { offset: null },
      { offset: NaN },
      { offset: Infinity },
      { progress: "half" },
      { progress: NaN },
    ]) {
      const parsed = ProgressBodySchema.safeParse(body);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(firstIssueMessage(parsed.error)).toBe("Missing progress");
    }
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, [1], "x"]) {
      expect(ProgressBodySchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("archive/like/trash toggle schemas", () => {
  it("accepts true and false", () => {
    expect(ArchiveBodySchema.safeParse({ archived: true }).success).toBe(true);
    expect(ArchiveBodySchema.safeParse({ archived: false }).success).toBe(true);
    expect(LikeBodySchema.safeParse({ liked: false }).success).toBe(true);
    expect(TrashBodySchema.safeParse({ deleted: true }).success).toBe(true);
  });

  it("rejects missing/truthy-non-boolean values with the legacy messages", () => {
    const cases = [
      [ArchiveBodySchema, {}, "Missing archived"],
      [ArchiveBodySchema, { archived: 1 }, "Missing archived"],
      [ArchiveBodySchema, { archived: "yes" }, "Missing archived"],
      [LikeBodySchema, { liked: 0 }, "Missing liked"],
      [TrashBodySchema, { deleted: null }, "Missing deleted"],
      [TrashBodySchema, null, null],
    ] as const;
    for (const [schema, body, message] of cases) {
      const parsed = schema.safeParse(body);
      expect(parsed.success).toBe(false);
      if (!parsed.success && message) expect(firstIssueMessage(parsed.error)).toBe(message);
    }
  });
});

describe("ArticleSchema", () => {
  function validArticle() {
    return {
      id: "abc123",
      url: "https://example.com/a",
      title: "T",
      byline: null,
      excerpt: null,
      html: "<p>hi</p>",
      text: "hi",
      wordCount: 1,
      progress: 0.5,
      progressOffset: 1,
      progressUpdatedAt: null,
      archived: false,
      archivedAt: null,
      liked: false,
      likedAt: null,
      deleted: false,
      deletedAt: null,
      createdAt: "2026-09-24T00:00:00.000Z",
    };
  }

  it("accepts a complete valid row", () => {
    expect(ArticleSchema.safeParse(validArticle()).success).toBe(true);
  });

  it("rejects out-of-range progress, bad counts, and missing identity", () => {
    expect(ArticleSchema.safeParse({ ...validArticle(), progress: 1.5 }).success).toBe(false);
    expect(ArticleSchema.safeParse({ ...validArticle(), progress: -0.1 }).success).toBe(false);
    expect(ArticleSchema.safeParse({ ...validArticle(), wordCount: -1 }).success).toBe(false);
    expect(ArticleSchema.safeParse({ ...validArticle(), progressOffset: 1.5 }).success).toBe(false);
    const noId: Record<string, unknown> = { ...validArticle() };
    delete noId.id;
    expect(ArticleSchema.safeParse(noId).success).toBe(false);
    expect(ArticleSchema.safeParse({ ...validArticle(), byline: 42 }).success).toBe(false);
  });

  it("preserves unknown future fields instead of stripping them", () => {
    const parsed = ArticleSchema.safeParse({ ...validArticle(), futureField: "keep-me" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).futureField).toBe("keep-me");
    }
  });
});
