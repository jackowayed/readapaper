import { describe, expect, it, vi } from "vitest";
import {
  advanceUtterance,
  buildUtterance,
  findStartSentence,
  needsRestartAfterPause,
  resolveBoundary,
  sliceSentence,
  SpeechQueue,
  type QueueSynth,
  type SentenceSpan,
} from "../lib/speech-queue";

const SENTENCES: SentenceSpan[] = [
  { text: "Hello world. ", start: 0, end: 13 },
  { text: "How are you? ", start: 13, end: 26 },
  { text: "Fine!", start: 26, end: 31 },
];

/** Recording mock standing in for speechSynthesis under node. */
function mockSynth(calls: string[]) {
  const synth: QueueSynth & { spoken: string[] } = {
    spoken: [],
    cancel() {
      calls.push("cancel");
    },
    speak(u: { text: string }) {
      calls.push("speak");
      synth.spoken.push(u.text);
    },
  };
  return synth;
}

describe("findStartSentence", () => {
  it("selects the sentence containing the offset", () => {
    expect(findStartSentence(SENTENCES, 0)).toBe(0);
    expect(findStartSentence(SENTENCES, 5)).toBe(0);
    expect(findStartSentence(SENTENCES, 13)).toBe(1);
    expect(findStartSentence(SENTENCES, 26)).toBe(2);
  });

  it("treats an offset exactly at a sentence end as the next sentence", () => {
    // Mirrors `fromOffset < s.end` in SyncedReader.
    expect(findStartSentence(SENTENCES, 13)).toBe(1);
  });

  it("wraps to 0 past the end (mirrored SyncedReader quirk)", () => {
    expect(findStartSentence(SENTENCES, 31)).toBe(0);
    expect(findStartSentence(SENTENCES, 999)).toBe(0);
  });

  it("returns 0 for an empty sentence list", () => {
    expect(findStartSentence([], 10)).toBe(0);
  });
});

describe("sliceSentence", () => {
  it("returns the whole sentence when seeking at/before its start", () => {
    expect(sliceSentence(SENTENCES, 1, 13)).toEqual({
      sentenceIndex: 1,
      text: "How are you? ",
      utterStart: 13,
    });
    expect(sliceSentence(SENTENCES, 1, 0)).toEqual({
      sentenceIndex: 1,
      text: "How are you? ",
      utterStart: 13,
    });
  });

  it("slices a mid-sentence seek with matching offsets", () => {
    const u = sliceSentence(SENTENCES, 0, 6);
    expect(u).toEqual({ sentenceIndex: 0, text: "world. ", utterStart: 6 });
    // Remainder round-trips through the source span.
    expect(SENTENCES[0]!.text.slice(6)).toBe(u!.text);
  });

  it("returns null for blank remainders and out-of-range idx", () => {
    const blanks: SentenceSpan[] = [{ text: "   ", start: 0, end: 3 }];
    expect(sliceSentence(blanks, 0, 0)).toBeNull();
    expect(sliceSentence(SENTENCES, 99, 0)).toBeNull();
  });
});

describe("buildUtterance / advanceUtterance", () => {
  it("skips whitespace-only sentences", () => {
    const withBlank: SentenceSpan[] = [
      { text: "Hi. ", start: 0, end: 4 },
      { text: "   ", start: 4, end: 7 },
      { text: "Bye.", start: 7, end: 11 },
    ];
    expect(buildUtterance(withBlank, 1, 4)).toEqual({
      sentenceIndex: 2,
      text: "Bye.",
      utterStart: 7,
    });
  });

  it("advances whole-sentence by sentence and drains at the tail", () => {
    expect(advanceUtterance(SENTENCES, 0)).toEqual({
      sentenceIndex: 1,
      text: "How are you? ",
      utterStart: 13,
    });
    expect(advanceUtterance(SENTENCES, 2)).toBeNull();
  });

  it("returns null when nothing speakable remains", () => {
    expect(buildUtterance(SENTENCES, 3, 31)).toBeNull();
  });
});

describe("resolveBoundary", () => {
  it("maps relative charIndex to global offset + sentence", () => {
    // Mid-first-sentence utterance: utterStart 6, +2 chars -> global 8, sentence 0.
    expect(resolveBoundary(SENTENCES, 6, 2)).toEqual({
      globalOffset: 8,
      sentenceIndex: 0,
    });
    // Cross-sentence global offset resolves to the owning sentence.
    expect(resolveBoundary(SENTENCES, 0, 15)).toEqual({
      globalOffset: 15,
      sentenceIndex: 1,
    });
  });

  it("clamps non-finite charIndex to the utterance start", () => {
    expect(resolveBoundary(SENTENCES, 13, Number.NaN)).toEqual({
      globalOffset: 13,
      sentenceIndex: 1,
    });
  });

  it("returns -1 outside all sentences", () => {
    expect(resolveBoundary(SENTENCES, 500, 0).sentenceIndex).toBe(-1);
  });
});

describe("needsRestartAfterPause", () => {
  it("flags the Chrome queue-drop shape (speaking, neither paused nor speaking)", () => {
    expect(
      needsRestartAfterPause({ queueSpeaking: true, synthPaused: false, synthSpeaking: false })
    ).toBe(true);
    expect(
      needsRestartAfterPause({ queueSpeaking: true, synthPaused: true, synthSpeaking: false })
    ).toBe(false);
    expect(
      needsRestartAfterPause({ queueSpeaking: true, synthPaused: false, synthSpeaking: true })
    ).toBe(false);
    expect(
      needsRestartAfterPause({ queueSpeaking: false, synthPaused: false, synthSpeaking: false })
    ).toBe(false);
  });
});

describe("SpeechQueue driver (mocked speechSynthesis)", () => {
  it("proves click -> queue -> advance -> persist ordering", () => {
    const calls: string[] = [];
    const events: string[] = [];
    const synth = mockSynth(calls);
    const q = new SpeechQueue({
      sentences: SENTENCES,
      synth,
      events: {
        onHighlight: (off, idx) => events.push(`highlight:${off}:${idx}`),
        onPersist: (off) => events.push(`persist:${off}`),
        onDone: () => events.push("done"),
      },
    });

    // Click word at offset 0 -> first utterance queued + spoken + persisted.
    const first = q.start(0);
    expect(first?.text).toBe("Hello world. ");
    expect(q.state).toEqual({ idx: 0, speaking: true });

    // Boundary tick inside sentence 0 -> highlight + persist.
    q.handleBoundary(6);

    // Utterance end -> sentence 1 spoken, highlight + persist advance.
    const second = q.handleEnd();
    expect(second?.sentenceIndex).toBe(1);
    const third = q.handleEnd();
    expect(third?.sentenceIndex).toBe(2);
    expect(q.handleEnd()).toBeNull();
    expect(q.state.speaking).toBe(false);

    expect(synth.spoken).toEqual(["Hello world. ", "How are you? ", "Fine!"]);
    // Persist strictly follows its highlight/speak, in sentence order.
    expect(events).toEqual([
      "highlight:0:0",
      "persist:0",
      "highlight:6:0",
      "persist:6",
      "highlight:13:1",
      "persist:13",
      "highlight:26:2",
      "persist:26",
      "done",
    ]);
  });

  it("seeks mid-sentence with a sliced first utterance", () => {
    const calls: string[] = [];
    const synth = mockSynth(calls);
    const q = new SpeechQueue({ sentences: SENTENCES, synth });
    const first = q.start(17); // inside "How are you? "
    expect(first).toEqual({ sentenceIndex: 1, text: "are you? ", utterStart: 17 });
    expect(synth.spoken).toEqual(["are you? "]);
    expect(q.handleEnd()?.sentenceIndex).toBe(2);
  });

  it("records cancel()/speak() call order (suspect #1 repro harness)", () => {
    const calls: string[] = [];
    const synth = mockSynth(calls);
    const q = new SpeechQueue({ sentences: SENTENCES, synth });
    q.start(0);
    // speakSentenceRange shape: cancel() synchronously before speak(), same tick.
    expect(calls.slice(0, 2)).toEqual(["cancel", "speak"]);
    q.handleEnd();
    // Advance path speaks without re-cancelling (onend chain has no cancel).
    expect(calls).toEqual(["cancel", "speak", "speak"]);
  });

  it("halts on error and cancels on stop", () => {
    const calls: string[] = [];
    const onError = vi.fn();
    const synth = mockSynth(calls);
    const q = new SpeechQueue({ sentences: SENTENCES, synth, events: { onError } });
    q.start(0);
    q.handleError();
    expect(q.state.speaking).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(q.handleEnd()).toBeNull();

    const q2 = new SpeechQueue({ sentences: SENTENCES, synth });
    q2.start(0);
    q2.stop();
    expect(q2.state.speaking).toBe(false);
    expect(calls[calls.length - 1]).toBe("cancel");
  });

  it("keeps the retry offset on error (no auto-advance after halt)", () => {
    const calls: string[] = [];
    const synth = mockSynth(calls);
    const q = new SpeechQueue({ sentences: SENTENCES, synth });
    const first = q.start(17); // mid-sentence seek: utterStart 17
    expect(first?.utterStart).toBe(17);
    q.handleError();
    expect(q.state.speaking).toBe(false);
    // No auto-advance: the queue stays halted until the caller retries.
    expect(q.handleEnd()).toBeNull();
    expect(q.handleBoundary(1)).toBeNull();
    // Retry from the kept offset re-speaks the same sliced sentence.
    const retry = q.start(17);
    expect(retry).toEqual({ sentenceIndex: 1, text: "are you? ", utterStart: 17 });
  });

  it("pause/resume restart predicate drives a start() retry in order", () => {
    const calls: string[] = [];
    const synth = mockSynth(calls);
    const q = new SpeechQueue({ sentences: SENTENCES, synth });
    q.start(6); // playing mid-sentence 0
    // Chrome dropped the queue while paused: speaking, neither paused nor speaking.
    expect(
      needsRestartAfterPause({
        queueSpeaking: q.state.speaking,
        synthPaused: false,
        synthSpeaking: false,
      })
    ).toBe(true);
    // Restart from the kept playhead re-issues cancel() before speak().
    const before = calls.length;
    q.start(6);
    expect(calls.slice(before, before + 2)).toEqual(["cancel", "speak"]);
    // Paused synth must NOT restart (resume path instead).
    expect(
      needsRestartAfterPause({ queueSpeaking: true, synthPaused: true, synthSpeaking: false })
    ).toBe(false);
  });
});
