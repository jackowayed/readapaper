import { describe, expect, it } from "vitest";
import { buildBookmarklet } from "../lib/bookmarklet";

describe("buildBookmarklet", () => {
  it("returns a javascript: URL", () => {
    const out = buildBookmarklet("https://reader.example.com");
    expect(out.startsWith("javascript:")).toBe(true);
  });

  it("injects the base origin", () => {
    const out = buildBookmarklet("https://reader.example.com");
    expect(out).toContain("https://reader.example.com");
    expect(out).toContain("fetch(BASE+'/api/articles'");
  });

  it("strips a trailing slash from the base", () => {
    const withSlash = buildBookmarklet("https://reader.example.com/");
    const withoutSlash = buildBookmarklet("https://reader.example.com");
    expect(withSlash).toBe(withoutSlash);
    expect(withSlash).toContain("https://reader.example.com");
    expect(withSlash).not.toContain("https://reader.example.com/");
  });

  it("escapes single quotes in the base", () => {
    const out = buildBookmarklet("https://x.com/a'b");
    expect(out).toContain("a\\'b");
    expect(out.startsWith("javascript:")).toBe(true);
  });
});
