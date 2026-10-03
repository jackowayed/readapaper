/**
 * html-tokenize — render sanitized article HTML as React nodes with per-word
 * spans for the unified reader.
 *
 * Plain `.ts` (no JSX) so vitest can import it under `"jsx": "preserve"`.
 * Input HTML is already sanitized server-side (see `lib/extract.ts`); only
 * allowlisted tags/attrs are rendered, everything else degrades to bare
 * words. `onWordClick` fires with the visible word index in document order.
 */

import { createElement, Fragment } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

const WRAPPER_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
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
]);

function attr(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  return v == null || v === "" ? null : v;
}

export function tokenizeArticleHtml(
  html: string,
  doc: Document,
  onWordClick: (htmlIndex: number, e: ReactMouseEvent) => void
): { nodes: ReactNode; htmlWords: string[] } {
  const htmlWords: string[] = [];
  let key = 0;

  function renderText(text: string): ReactNode[] {
    const out: ReactNode[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const hi = htmlWords.length;
      htmlWords.push(m[0]);
      const word = m[0];
      out.push(
        createElement(
          "span",
          {
            key: key++,
            className: "w",
            "data-hi": hi,
            onClick: (e: ReactMouseEvent) => onWordClick(hi, e),
            title: "Click to listen from here",
          },
          word
        )
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function renderChildren(parent: Node): ReactNode[] {
    const out: ReactNode[] = [];
    parent.childNodes.forEach((child) => {
      const rendered = renderNode(child);
      if (Array.isArray(rendered)) out.push(...rendered);
      else if (rendered != null) out.push(rendered);
    });
    return out;
  }

  function renderNode(node: Node): ReactNode | ReactNode[] | null {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      if (!text) return null;
      return renderText(text);
    }
    if (node.nodeType !== 1) return null;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") return createElement("br", { key: key++ });
    if (tag === "hr") return createElement("hr", { key: key++ });
    if (tag === "img") {
      const src = attr(el, "src");
      if (!src) return null;
      return createElement("img", {
        key: key++,
        src,
        alt: attr(el, "alt") ?? "",
        title: attr(el, "title") ?? undefined,
        loading: "lazy",
        decoding: "async",
      });
    }
    if (tag === "a") {
      const href = attr(el, "href");
      const title = attr(el, "title");
      return createElement(
        "a",
        {
          key: key++,
          ...(href ? { href } : {}),
          target: "_blank",
          rel: "noopener noreferrer",
          ...(title ? { title } : {}),
        },
        ...renderChildren(el)
      );
    }
    if (WRAPPER_TAGS.has(tag)) {
      return createElement(tag, { key: key++ }, ...renderChildren(el));
    }
    // Unknown tag (shouldn't survive sanitize): keep the words, drop the wrap.
    return renderChildren(el);
  }

  const template = doc.createElement("template");
  // Sanitized server-side with the DOMPurify allowlist (see lib/extract.ts).
  template.innerHTML = html;
  const nodes = renderChildren(template.content);
  return { nodes: createElement(Fragment, null, ...nodes), htmlWords };
}
