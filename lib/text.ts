export type Sentence = { text: string; start: number; end: number };
export type Word = { text: string; start: number; end: number };

/** Split plain text into sentences with global char offsets. Uses Intl.Segmenter when available. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  if (!text.trim()) return out;
  try {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    for (const s of Array.from(seg.segment(text))) {
      const segText = s.segment;
      if (!segText.trim()) continue;
      // s.index is available in modern runtimes; fall back to search if missing
      const idx =
        typeof s.index === "number"
          ? s.index
          : text.indexOf(segText, out.length ? out[out.length - 1]!.end : 0);
      out.push({ text: segText, start: idx, end: idx + segText.length });
    }
    if (out.length) return out;
  } catch {
    // fall through to regex
  }
  const re = /[^.!?…\n]+[.!?…]+["”']?\s*|\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!m[0].trim()) continue;
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (!out.length) out.push({ text, start: 0, end: text.length });
  return out;
}

/** Split text into non-whitespace tokens with global offsets. */
export function splitWords(text: string): Word[] {
  const out: Word[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function countWords(text: string): number {
  return splitWords(text).length;
}

export function readingMinutes(wordCount: number, wpm = 200): number {
  return Math.max(1, Math.round(wordCount / wpm));
}
