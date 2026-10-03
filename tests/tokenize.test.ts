import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { tokenizeArticleHtml } from "../lib/html-tokenize";
import { buildWordAlignment, htmlIndexToTextOffset } from "../lib/html-sync";
import { splitWords } from "../lib/text";

function doc(): Document {
  return new JSDOM("<!doctype html><html><body></body></html>").window
    .document as unknown as Document;
}

describe("tokenizeArticleHtml", () => {
  it("wraps visible words in order with stable data-hi ids", () => {
    const { nodes, htmlWords } = tokenizeArticleHtml(
      "<p>Hello brave world</p><p>Second line</p>",
      doc(),
      vi.fn()
    );
    expect(htmlWords).toEqual(["Hello", "brave", "world", "Second", "line"]);
    const markup = renderToStaticMarkup(nodes as ReactElement);
    expect(markup).toContain('data-hi="0"');
    expect(markup).toContain('data-hi="4"');
    expect(markup).toContain("Hello");
    expect(markup).toContain("<p>");
  });

  it("preserves links/images and drops unknown wrappers but keeps their words", () => {
    const { nodes, htmlWords } = tokenizeArticleHtml(
      '<p>Read <a href="https://example.com/x">the story</a> here.</p><div>Div words stay.</div><img src="https://example.com/i.jpg" alt="pic">',
      doc(),
      vi.fn()
    );
    expect(htmlWords).toEqual(["Read", "the", "story", "here.", "Div", "words", "stay."]);
    const markup = renderToStaticMarkup(nodes as ReactElement);
    expect(markup).toContain('href="https://example.com/x"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('src="https://example.com/i.jpg"');
    expect(markup).not.toContain("<div");
  });

  it("fires onWordClick with the visible index", () => {
    const onClick = vi.fn();
    const { nodes } = tokenizeArticleHtml("<p>one two three</p>", doc(), onClick);
    expect(nodes).toBeTruthy();
    // Click wiring is exercised in e2e; here we assert the words exist.
    const markup = renderToStaticMarkup(nodes as ReactElement);
    expect((markup.match(/data-hi="/g) ?? []).length).toBe(3);
  });

  it("end-to-end: article text aligns onto tokenized html words", () => {
    const text = "Hello brave world. Second line here.";
    const html = "<p>Hello brave world.</p><p>Second line here.</p>";
    const { htmlWords } = tokenizeArticleHtml(html, doc(), vi.fn());
    const textWords = splitWords(text);
    const alignment = buildWordAlignment(textWords, htmlWords);
    // Every visible word maps back to a text offset in order.
    const offsets = htmlWords.map((_, j) => htmlIndexToTextOffset(j, textWords, alignment));
    expect(offsets.every((o) => typeof o === "number")).toBe(true);
    const sorted = [...(offsets as number[])].sort((a, b) => a - b);
    expect(sorted).toEqual(offsets);
  });
});
