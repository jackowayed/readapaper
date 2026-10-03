/**
 * audio-queue — pure queue logic for the offline (`<audio>`) TTS path.
 *
 * Mirrors the sentence selection of `lib/speech-queue.ts` (same
 * `fromOffset < s.end` start rule, same mid-sentence slicing, same blank
 * skipping) so both engines speak identical slices — only the driver
 * differs (WAV-via-`<audio>` instead of `speechSynthesis`). Adds the two
 * audio-only concerns: time-based offset estimation for highlight sync
 * (no `onboundary` from eSpeak v1) and stable cache keys so a seek replay
 * reuses already-synthesized sentences.
 */

import {
  advanceUtterance,
  buildUtterance,
  findStartSentence,
  type SentenceSpan,
} from "./speech-queue";
import { estimateOffsetInSentence } from "./wav";

export type { SentenceSpan };

export type AudioSentencePlan = {
  /** Sentence index this plan was built from. */
  sentenceIndex: number;
  /** Text handed to the synthesizer (possibly sliced on seek). */
  utterText: string;
  /** Global char offset the utterance text starts at. */
  utterStart: number;
};

/**
 * First speakable sentence at/after `fromOffset` (mid-sentence seeks slice
 * the first utterance). Null when nothing speakable remains (blank tail).
 */
export function planAudioFromOffset(
  sentences: SentenceSpan[],
  fromOffset: number
): AudioSentencePlan | null {
  if (sentences.length === 0) return null;
  const startIdx = findStartSentence(sentences, fromOffset);
  const u = buildUtterance(sentences, startIdx, fromOffset);
  if (!u) return null;
  return { sentenceIndex: u.sentenceIndex, utterText: u.text, utterStart: u.utterStart };
}

/** Whole-sentence plan for `idx + 1`. Null at the tail. */
export function planAudioNext(sentences: SentenceSpan[], idx: number): AudioSentencePlan | null {
  if (idx + 1 >= sentences.length) return null;
  const u = advanceUtterance(sentences, idx);
  if (!u) return null;
  return { sentenceIndex: u.sentenceIndex, utterText: u.text, utterStart: u.utterStart };
}

/**
 * Highlight playhead while a sentence's audio plays: uniform interpolation
 * of `currentTime / durationSec` over the spoken slice. Returns the
 * sentence start when `durationSec` is unusable (caller treats it as a
 * sentence-level fallback, like Firefox with no word events).
 */
export function estimateGlobalOffset(
  plan: Pick<AudioSentencePlan, "utterStart" | "utterText">,
  currentTimeSec: number,
  durationSec: number
): number {
  if (!Number.isFinite(currentTimeSec) || !Number.isFinite(durationSec) || durationSec <= 0) {
    return plan.utterStart;
  }
  return estimateOffsetInSentence(
    plan.utterStart,
    plan.utterText.length,
    currentTimeSec / durationSec
  );
}

/** djb2 hex — tiny stable hash for cache keys (DOM/crypto-free). */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/**
 * Cache key for one synthesized sentence. Keyed by voice speed + content
 * hash (+ length guard against pathological collisions): the same rate
 * always replays byte-identical audio, so seeks never re-synthesize.
 */
export function audioCacheKey(utterText: string, wpm: number): string {
  return `${wpm}:${utterText.length}:${hashText(utterText)}`;
}
