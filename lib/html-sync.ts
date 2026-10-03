/**
 * html-sync — word alignment between canonical `article.text` (what TTS
 * speaks, what progress offsets index into) and the visible words of the
 * sanitized reader HTML (what the unified view renders + highlights).
 *
 * The two sequences are nearly identical (same Readability source, sanitize
 * keeps text), but can drift: bylines/captions present in one, whitespace
 * normalization, curly-vs-straight punctuation. Matching is case-insensitive
 * with punctuation trimmed + typographic folding, aligned greedily with a
 * bounded lookahead so small insertions/deletions don't desync the tail.
 *
 * Pure + DOM-free: the component collects `htmlWords` in document order while
 * tokenizing, aligns here, then maps offsets both ways. Unmapped words fall
 * back to the nearest aligned neighbor (restore always highlights) and clicks
 * fall back to a fractional estimate (a tap always seeks somewhere).
 */

export type TextWord = { text: string; start: number; end: number };

export type WordAlignment = {
  /** Per text-word index: html word index, or null when deleted. */
  textToHtml: (number | null)[];
  /** Per html-word index: text word index, or null when inserted. */
  htmlToText: (number | null)[];
};

/** Normalize for matching: lowercase, fold typographic marks, trim edge punctuation. */
export function normalizeWordForMatch(word: string): string {
  const folded = word
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, "-");
  const lower = folded.toLowerCase();
  const trimmed = lower.replace(
    /^[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+|[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+$/g,
    ""
  );
  // Punctuation-only tokens (em-dash, "…"): match on the folded raw form so
  // identical marks still align but different marks don't collapse together.
  if (!trimmed) return lower.trim();
  return trimmed;
}

function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // Both empty after normalization (different punctuation) never match —
  // the lookahead scan treats them as insertions/deletions, not anchors.
  if (!a || !b) return false;
  return a === b;
}

/**
 * Greedy two-pointer alignment with bounded lookahead for insertions
 * (extra html words: captions, link text) and deletions (missing words).
 * Unresolvable mismatches advance both sides as unmapped so one bad word
 * can't stall the rest of the article.
 */
export function buildWordAlignment(
  textWords: readonly (TextWord | string)[],
  htmlWords: readonly string[],
  lookahead = 20
): WordAlignment {
  const textNorm = textWords.map((w) => normalizeWordForMatch(typeof w === "string" ? w : w.text));
  const htmlNorm = htmlWords.map(normalizeWordForMatch);
  const textToHtml: (number | null)[] = new Array(textWords.length).fill(null);
  const htmlToText: (number | null)[] = new Array(htmlWords.length).fill(null);

  let i = 0;
  let j = 0;
  const K = Math.max(1, Math.floor(lookahead));
  while (i < textNorm.length && j < htmlNorm.length) {
    const t = textNorm[i]!;
    const h = htmlNorm[j]!;
    if (wordsMatch(t, h)) {
      textToHtml[i] = j;
      htmlToText[j] = i;
      i += 1;
      j += 1;
      continue;
    }
    // Look ahead in html: text[i] reappears at j+k -> html j..j+k-1 inserted.
    let hk = -1;
    for (let k = 1; k <= K && j + k < htmlNorm.length; k++) {
      if (wordsMatch(t, htmlNorm[j + k]!)) {
        hk = k;
        break;
      }
    }
    if (hk !== -1) {
      j += hk;
      textToHtml[i] = j;
      htmlToText[j] = i;
      i += 1;
      j += 1;
      continue;
    }
    // Look ahead in text: html[j] reappears at i+k -> text i..i+k-1 deleted.
    let tk = -1;
    for (let k = 1; k <= K && i + k < textNorm.length; k++) {
      if (wordsMatch(textNorm[i + k]!, h)) {
        tk = k;
        break;
      }
    }
    if (tk !== -1) {
      i += tk;
      textToHtml[i] = j;
      htmlToText[j] = i;
      i += 1;
      j += 1;
      continue;
    }
    // No anchor within the window: leave both unmapped, step past the pair.
    i += 1;
    j += 1;
  }
  return { textToHtml, htmlToText };
}

/** Text-word index containing `offset`, or the nearest preceding word. */
export function findTextWordAtOffset(words: readonly TextWord[], offset: number): number | null {
  if (!words.length) return null;
  if (!Number.isFinite(offset)) return null;
  for (let k = words.length - 1; k >= 0; k--) {
    const w = words[k]!;
    if (offset >= w.start && offset < w.end) return k;
  }
  for (let k = words.length - 1; k >= 0; k--) {
    if (words[k]!.start <= offset) return k;
  }
  return 0;
}

/**
 * Map a canonical text offset to the html word to highlight: the aligned
 * html word for the containing (or preceding) text word, falling back to the
 * nearest aligned text word backward then forward. Null when nothing aligns.
 */
export function textOffsetToHtmlIndex(
  offset: number,
  textWords: readonly TextWord[],
  alignment: WordAlignment
): number | null {
  const at = findTextWordAtOffset(textWords, offset);
  if (at == null) return null;
  const direct = alignment.textToHtml[at];
  if (typeof direct === "number") return direct;
  for (let k = at - 1; k >= 0; k--) {
    const h = alignment.textToHtml[k];
    if (typeof h === "number") return h;
  }
  for (let k = at + 1; k < textWords.length; k++) {
    const h = alignment.textToHtml[k];
    if (typeof h === "number") return h;
  }
  return null;
}

/**
 * Map a clicked html word to the canonical text offset to seek from: the
 * aligned word's start, falling back to the nearest aligned html word
 * (backward then forward). Null when nothing aligns (caller may estimate).
 */
export function htmlIndexToTextOffset(
  htmlIndex: number,
  textWords: readonly TextWord[],
  alignment: WordAlignment
): number | null {
  if (!textWords.length) return null;
  if (!Number.isInteger(htmlIndex) || htmlIndex < 0 || htmlIndex >= alignment.htmlToText.length)
    return null;
  const direct = alignment.htmlToText[htmlIndex];
  if (typeof direct === "number") return textWords[direct]!.start;
  for (let k = htmlIndex - 1; k >= 0; k--) {
    const t = alignment.htmlToText[k];
    if (typeof t === "number") return textWords[t]!.start;
  }
  for (let k = htmlIndex + 1; k < alignment.htmlToText.length; k++) {
    const t = alignment.htmlToText[k];
    if (typeof t === "number") return textWords[t]!.start;
  }
  return null;
}

/**
 * Fractional fallback so a tap always seeks somewhere even when the word has
 * no alignment (inserted caption, alignment blowout): position proportional
 * to the click's place in the visible word stream.
 */
export function estimateTextOffsetForHtmlIndex(
  htmlIndex: number,
  htmlCount: number,
  textLength: number
): number {
  if (!Number.isFinite(textLength) || textLength <= 0) return 0;
  if (!Number.isFinite(htmlCount) || htmlCount <= 0) return 0;
  const clamped = Math.min(Math.max(Math.round(htmlIndex), 0), Math.max(0, htmlCount - 1));
  return Math.min(Math.max(Math.round(((clamped + 1) / htmlCount) * textLength), 0), textLength);
}
