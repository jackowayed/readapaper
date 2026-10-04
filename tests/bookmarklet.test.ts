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

  it("relays via window.open + postMessage first to avoid the local-network prompt", () => {
    const out = buildBookmarklet("https://reader.example.com");
    expect(out).toContain("window.open(BASE+'/bookmarklet#autosave'");
    expect(out).toContain("postMessage(payload,BASE)");
    expect(out).toContain("readapaper-save");
    expect(out).toContain("readapaper-saved");
    expect(out).toContain("readapaper-error");
    expect(out).toContain("readapaper-ready");
    // Direct fetch stays as the popup-blocked fallback.
    expect(out).toContain("fetch(BASE+'/api/articles'");
  });

  it("tags the direct-save fallback with targetAddressSpace", () => {
    const out = buildBookmarklet("https://reader.example.com");
    expect(out).toContain("targetAddressSpace");
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

  it("falls back to clipboard + manual save on CSP/mixed-content block", () => {
    const out = buildBookmarklet("http://localhost:3000");
    expect(out).toContain("navigator.clipboard");
    expect(out).toContain("writeText(html)");
    expect(out).toContain("local-network permission");
    expect(out).toContain("/bookmarklet#manual");
    expect(out).toContain("location.protocol");
  });
});
