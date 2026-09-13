/**
 * speech-queue — pure TTS queue logic extracted from SyncedReader.
 *
 * Mirrors `speakSentenceRange` / `onPlayPause` queue semantics in
 * `components/SyncedReader.tsx` (read-only reference, do not drift):
 * - queue of per-sentence utterances, start sentence selected by offset
 * - mid-sentence seeks slice the first utterance, later ones speak whole
 * - whitespace-only sentences are skipped, `onend` advances to next
 * - every `start()` issues `cancel()` synchronously before `speak()`
 *
 * Zero DOM / Web Speech dependencies: the synth is injected via the
 * `QueueSynth` interface so tests run under node with a recording mock.
 */

export type SentenceSpan = { text: string; start: number; end: number };

export type QueueState = { idx: number; speaking: boolean };

export type UtteranceRequest = {
  /** Sentence index this utterance was built from. */
  sentenceIndex: number;
  /** Text handed to speechSynthesis.speak (possibly sliced on seek). */
  text: string;
  /** Global char offset the utterance text starts at. */
  utterStart: number;
};

export type BoundaryHit = { globalOffset: number; sentenceIndex: number };

/** Minimal structural synth surface — satisfied by SpeechSynthesis in the browser. */
export interface QueueSynth {
  cancel(): void;
  speak(utterance: { text: string }): void;
}

export interface QueueEvents {
  /** Word/sentence highlight moved (mirrors setActiveOffset/setActiveSentence). */
  onHighlight?: (offset: number, sentenceIndex: number) => void;
  /** Persist hook: called on boundary + utterance advance (progress-sync owner). */
  onPersist?: (offset: number) => void;
  /** Queue drained (mirrors setPlaying(false) at the tail). */
  onDone?: () => void;
  /** Speech error surfaced (mirrors u.onerror -> playing=false). */
  onError?: () => void;
}

/**
 * Sentence selection: first sentence with `fromOffset < s.end`.
 * Mirrors SyncedReader (`findIndex((s) => fromOffset < s.end)`, `-1` -> 0),
 * including its wrap-to-0 quirk for offsets past the end.
 */
export function findStartSentence(sentences: SentenceSpan[], fromOffset: number): number {
  if (sentences.length === 0) return 0;
  const idx = sentences.findIndex((s) => fromOffset < s.end);
  return idx === -1 ? 0 : idx;
}

/**
 * Slice offsets for speaking sentence `sentences[idx]` from `charStart`.
 * Returns null when the remainder is blank (caller must advance).
 */
export function sliceSentence(
  sentences: SentenceSpan[],
  idx: number,
  charStart: number
): UtteranceRequest | null {
  const s = sentences[idx];
  if (!s) return null;
  const sliceFrom = Math.max(0, charStart - s.start);
  const text = sliceFrom > 0 ? s.text.slice(sliceFrom) : s.text;
  const utterStart = charStart > s.start ? charStart : s.start;
  if (!text.trim()) return null;
  return { sentenceIndex: idx, text, utterStart };
}

/**
 * Build the next speakable utterance at/after `idx` starting from `charStart`.
 * Skips whitespace-only remainders. Returns null when the queue is drained.
 */
export function buildUtterance(
  sentences: SentenceSpan[],
  idx: number,
  charStart: number
): UtteranceRequest | null {
  for (let i = idx; i < sentences.length; i++) {
    const start = i === idx ? charStart : (sentences[i]?.start ?? charStart);
    const u = sliceSentence(sentences, i, start);
    if (u) return u;
  }
  return null;
}

/** Next-sentence advance: utterance for `idx + 1` (whole sentence). Null at tail. */
export function advanceUtterance(sentences: SentenceSpan[], idx: number): UtteranceRequest | null {
  if (idx + 1 >= sentences.length) return null;
  return buildUtterance(sentences, idx + 1, sentences[idx + 1]?.start ?? 0);
}

/**
 * Map an `onboundary` charIndex (relative to the utterance) to a global
 * offset + sentence index. Mirrors the SyncedReader onboundary handler.
 * `sentenceIndex` is -1 when the offset falls outside all sentences.
 */
export function resolveBoundary(
  sentences: SentenceSpan[],
  utterStart: number,
  charIndex: number
): BoundaryHit {
  const rel = typeof charIndex === "number" && Number.isFinite(charIndex) ? charIndex : 0;
  const globalOffset = utterStart + Math.max(0, rel);
  const sentenceIndex = sentences.findIndex((x) => globalOffset >= x.start && globalOffset < x.end);
  return { globalOffset, sentenceIndex };
}

/**
 * Chrome queue-drop restart predicate, mirroring `onPlayPause`:
 * queue claims to be speaking, synth is neither paused nor speaking.
 */
export function needsRestartAfterPause(args: {
  queueSpeaking: boolean;
  synthPaused: boolean;
  synthSpeaking: boolean;
}): boolean {
  return args.queueSpeaking && !args.synthPaused && !args.synthSpeaking;
}

export type PlayPauseStatus = "idle" | "playing" | "paused" | "error";

export type PlayPauseIntent = "pause" | "resume" | "restart" | "start";

/**
 * Pure play/pause toggle decision for `SyncedReader.onPlayPause`.
 *
 * The previous implementation derived the UI state by reading
 * `synth.paused` immediately after calling `synth.pause()`/`resume()`.
 * That read is stale on implementations where the flag flips
 * asynchronously: pausing kept `playing=true` (button stuck on "Pause")
 * and resuming could fall through to a full restart. The intent here is
 * derived from owned state instead — `playing`/`status` decide
 * pause-vs-resume, and the synth flags are only read (pre-mutation) to
 * distinguish a resume from a queue-drop restart.
 */
export function nextPlayPauseAction(args: {
  queueSpeaking: boolean;
  playing: boolean;
  status: PlayPauseStatus;
  synthPaused: boolean;
  synthSpeaking: boolean;
}): PlayPauseIntent {
  // Playing -> pause (own state wins over the synth flag).
  if (args.queueSpeaking && args.playing) return "pause";
  // Paused with a live queue -> resume, unless the synth queue dropped.
  if (args.queueSpeaking && args.status === "paused") {
    if (needsRestartAfterPause(args)) return "restart";
    return "resume";
  }
  // Idle / error / drained queue -> (re)start from the kept offset.
  return "start";
}

export type SpeechQueueOptions = {
  sentences: SentenceSpan[];
  synth: QueueSynth;
  events?: QueueEvents;
};

/**
 * Injectable queue driver. `start()` reproduces the exact call order of
 * `speakSentenceRange`: `cancel()` synchronously followed by `speak()`.
 * `handleEnd()` reproduces `u.onend -> speakIdx(idx + 1, ...)`.
 */
export class SpeechQueue {
  private sentences: SentenceSpan[];
  private synth: QueueSynth;
  private events: QueueEvents;
  readonly state: QueueState = { idx: 0, speaking: false };
  private current: UtteranceRequest | null = null;

  constructor(opts: SpeechQueueOptions) {
    this.sentences = opts.sentences;
    this.synth = opts.synth;
    this.events = opts.events ?? {};
  }

  /** Click/seek entry point: cancel queue, enqueue from offset, speak first. */
  start(fromOffset: number): UtteranceRequest | null {
    this.synth.cancel();
    const startIdx = findStartSentence(this.sentences, fromOffset);
    this.state.idx = startIdx;
    this.state.speaking = true;
    const first = buildUtterance(this.sentences, startIdx, fromOffset);
    if (!first) {
      this.state.speaking = false;
      this.current = null;
      this.events.onDone?.();
      return null;
    }
    this.current = first;
    this.state.idx = first.sentenceIndex;
    this.synth.speak({ text: first.text });
    this.events.onHighlight?.(first.utterStart, first.sentenceIndex);
    this.events.onPersist?.(first.utterStart);
    return first;
  }

  /** Boundary tick: highlight + persist ordering probe point. */
  handleBoundary(relativeCharIndex: number): BoundaryHit | null {
    if (!this.state.speaking || !this.current) return null;
    const hit = resolveBoundary(this.sentences, this.current.utterStart, relativeCharIndex);
    if (hit.sentenceIndex !== -1) {
      this.events.onHighlight?.(hit.globalOffset, hit.sentenceIndex);
    } else {
      this.events.onHighlight?.(hit.globalOffset, this.current.sentenceIndex);
    }
    this.events.onPersist?.(hit.globalOffset);
    return hit;
  }

  /** Utterance end: speak next sentence or drain the queue. */
  handleEnd(): UtteranceRequest | null {
    if (!this.state.speaking || !this.current) return null;
    const next = advanceUtterance(this.sentences, this.current.sentenceIndex);
    if (!next) {
      this.state.speaking = false;
      this.current = null;
      this.events.onDone?.();
      return null;
    }
    this.current = next;
    this.state.idx = next.sentenceIndex;
    this.synth.speak({ text: next.text });
    this.events.onHighlight?.(next.utterStart, next.sentenceIndex);
    this.events.onPersist?.(next.utterStart);
    return next;
  }

  /** Speech error: halt the queue (mirrors u.onerror -> playing=false). */
  handleError(): void {
    this.state.speaking = false;
    this.current = null;
    this.events.onError?.();
  }

  /** Stop button: halt + cancel (mirrors onStop). */
  stop(): void {
    this.state.speaking = false;
    this.current = null;
    this.synth.cancel();
  }

  currentUtterance(): UtteranceRequest | null {
    return this.current;
  }
}
