"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { splitSentences, splitWords } from "@/lib/text";
import { clampOffset, fractionToOffset, offsetToFraction } from "@/lib/progress-sync";
import {
  buildWordAlignment,
  estimateTextOffsetForHtmlIndex,
  htmlIndexToTextOffset,
  textOffsetToHtmlIndex,
  type TextWord,
  type WordAlignment,
} from "@/lib/html-sync";
import { tokenizeArticleHtml } from "@/lib/html-tokenize";
import { clearMediaSession, setupMediaSession } from "@/lib/media-session";
import { nextPlayPauseAction, isCanceledSpeechError } from "@/lib/speech-queue";
import {
  audioCacheKey,
  estimateGlobalOffset,
  planAudioFromOffset,
  planAudioNext,
  type AudioSentencePlan,
} from "@/lib/audio-queue";
import { ensureMespeakLoaded, synthesizeWavArray } from "@/lib/mespeak-tts";
import { loadTtsEngine, rateToWpm, saveTtsEngine, type TtsEngine } from "@/lib/tts-engine";
import { wavArrayToBlob } from "@/lib/wav";
import { loadVoiceSettings, saveVoiceSettings } from "@/lib/voice-settings";
import { persistProgressOffset } from "@/lib/offline-queue";
import { useReadingProgress } from "./ThemeControl";

/**
 * UnifiedReader — one article view for reading + listening (Instapaper-style).
 *
 * There is no read/listen mode toggle: the sanitized article HTML is always
 * rendered, with every visible word wrapped in a clickable span. The sticky
 * listen bar (Play/Pause, engine, rate, voice, auto-scroll, status) lives
 * above it. Pressing Play (or clicking any word) speaks `article.text` and
 * highlights the spoken words in place, in this same view. Pausing keeps the
 * position — scroll on to keep reading. No handoff, no remount, no lost scroll.
 *
 * Two speech engines share the queue semantics (per-sentence slices from a
 * canonical offset, same progress persistence):
 * - "system" (default): OS/browser voices via `speechSynthesis`, word-exact
 *   highlight from `onboundary`. Suspended by iOS when locked/backgrounded.
 * - "offline": built-in eSpeak voice (mespeak, bundled JS, synthesized to
 *   WAV per sentence) played through a single `<audio>` element — the only
 *   client-side playback path iOS keeps alive on lock / in background.
 *   Highlight is time-interpolated (sentence-level, like the Firefox
 *   fallback: no word timestamps from eSpeak v1).
 *
 * Speech still consumes canonical `article.text` (progress offsets index into
 * it); `lib/html-sync` aligns those offsets onto the visible HTML words for
 * highlight + click-to-seek. Unmapped words fall back to neighbors so restore
 * always highlights; unmapped clicks fall back to a fractional estimate.
 *
 * Link behavior: while idle/paused/error, taps inside `<a>` navigate normally
 * (no seek steal). While playing, link taps are intercepted as seeks so a
 * mid-listen tap never yanks the page away.
 */

export type UnifiedArticle = {
  id: string;
  html: string;
  text: string;
  title: string;
  progressOffset: number;
};

/** Shared offline-safe sender: PUT `{ offset }`, queued on failure. */
function sendOffset(id: string, offset: number) {
  return fetch(`/api/articles/${id}/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset }),
  });
}

type AlignedModel = {
  alignment: WordAlignment;
  textWords: TextWord[];
  sentenceHtml: number[][];
  htmlCount: number;
};

export default function UnifiedReader({
  article,
  onEnded,
}: {
  article: UnifiedArticle;
  /**
   * Fired once when the sentence queue drains naturally (all utterances
   * ended). NOT fired on pause, error, stop/cancel, or unmount — the queue
   * player uses it to advance to the next article.
   */
  onEnded?: () => void;
}) {
  const { id, html, text, title } = article;
  const textLength = text.length;
  const initialOffset = clampOffset(article.progressOffset ?? 0, textLength);

  const sentences = useMemo(() => splitSentences(text), [text]);
  const textWords = useMemo(() => splitWords(text), [text]);

  const [supported] = useState(() => typeof window !== "undefined" && "speechSynthesis" in window);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string>(() => loadVoiceSettings().voiceURI);
  const [rate, setRate] = useState<number>(() => loadVoiceSettings().rate);
  const [engine, setEngine] = useState<TtsEngine>(() => loadTtsEngine());
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<"idle" | "playing" | "paused" | "error">("idle");
  const [speakError, setSpeakError] = useState<string | null>(null);
  const [offlinePhase, setOfflinePhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const statusRef = useRef<"idle" | "playing" | "paused" | "error">("idle");
  statusRef.current = status;
  const engineRef = useRef<TtsEngine>(engine);
  engineRef.current = engine;
  const [autoScroll, setAutoScroll] = useState(true);

  const queueRef = useRef<{ idx: number; speaking: boolean }>({ idx: 0, speaking: false });
  const speakGenRef = useRef(0);
  // Offline (<audio>) engine: generation guards in-flight syntheses the way
  // speakGenRef guards stale utterances; the plan + duration drive highlight.
  const offlineGenRef = useRef(0);
  const offlinePlanRef = useRef<AudioSentencePlan | null>(null);
  const offlineDurRef = useRef(1);
  const offlineSpeakingRef = useRef(false);
  const offlineCacheRef = useRef(new Map<string, { url: string; durationSec: number }>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const optsRef = useRef({ voiceURI, rate });
  optsRef.current = { voiceURI, rate };
  const pauseUntilRef = useRef(0);
  const activeOffsetRef = useRef<number>(initialOffset);
  const sentenceRef = useRef<number | null>(null);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  // Tokenized article model (client-only: needs document). First paint (SSR)
  // falls back to plain HTML below; the word-span view swaps in on mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const rootRef = useRef<HTMLElement | null>(null);
  const modelRef = useRef<AlignedModel | null>(null);

  // Throttled playhead persist: boundary ticks call reportPosition (max ~2s),
  // pause/unmount/hide always flush the latest offset.
  const lastSentRef = useRef<number | null>(null);
  const lastSentAtRef = useRef(0);
  const pendingRef = useRef<number | null>(null);

  const reportPosition = useCallback(
    (offset: number, force = false) => {
      pendingRef.current = offset;
      const now = Date.now();
      if (!force && offset === lastSentRef.current) return;
      if (!force && now - lastSentAtRef.current < 2000) return;
      lastSentRef.current = offset;
      lastSentAtRef.current = now;
      persistProgressOffset(id, offset, textLength, sendOffset).catch(() => {});
    },
    [id, textLength]
  );

  const flushPosition = useCallback(() => {
    const pending = pendingRef.current;
    if (pending == null || pending === lastSentRef.current) return;
    lastSentRef.current = pending;
    lastSentAtRef.current = Date.now();
    persistProgressOffset(id, pending, textLength, sendOffset).catch(() => {});
  }, [id, textLength]);

  const flushRef = useRef(flushPosition);
  flushRef.current = flushPosition;
  useEffect(() => {
    function onVis() {
      if (document.hidden) flushRef.current();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      flushRef.current();
    };
  }, []);

  // Read-side progress: scroll persists while not playing. While playing the
  // playhead owns the server position (same last-writer-wins endpoint); the
  // hook's 1s re-enable suppression covers the pause beat.
  const handleScrollPosition = useCallback(
    (next: number) => {
      persistProgressOffset(id, next, textLength, sendOffset).catch(() => {});
    },
    [id, textLength]
  );
  useReadingProgress(id, offsetToFraction(initialOffset, textLength), {
    textLength,
    enabled: !playing,
    onPosition: handleScrollPosition,
  });

  const applyHighlight = useCallback(
    (textOffset: number, sentenceIdx: number | null, opts?: { silent?: boolean }) => {
      activeOffsetRef.current = textOffset;
      const model = modelRef.current;
      const root = rootRef.current;
      const hi = model ? textOffsetToHtmlIndex(textOffset, model.textWords, model.alignment) : null;
      if (root) {
        root.querySelectorAll(".w.active").forEach((el) => el.classList.remove("active"));
        if (hi != null) root.querySelector(`[data-hi="${hi}"]`)?.classList.add("active");
        if (sentenceIdx !== sentenceRef.current) {
          root
            .querySelectorAll(".w.sent-active")
            .forEach((el) => el.classList.remove("sent-active"));
          if (sentenceIdx != null && model) {
            for (const j of model.sentenceHtml[sentenceIdx] ?? []) {
              root.querySelector(`[data-hi="${j}"]`)?.classList.add("sent-active");
            }
          }
          sentenceRef.current = sentenceIdx;
        }
        if (hi != null && autoScrollRef.current && Date.now() >= pauseUntilRef.current) {
          root
            .querySelector(`[data-hi="${hi}"]`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      } else {
        sentenceRef.current = sentenceIdx;
      }
      if (!opts?.silent) reportPosition(textOffset);
    },
    [reportPosition]
  );

  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!supported) return;
    const load = () => {
      const vs = window.speechSynthesis.getVoices();
      if (vs.length) setVoices(vs);
    };
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener?.("voiceschanged", load);
      window.speechSynthesis.cancel();
    };
  }, [supported]);

  useEffect(() => {
    if (!voices.length || !voiceURI) return;
    if (!voices.some((v) => v.voiceURI === voiceURI)) {
      setVoiceURI("");
      saveVoiceSettings({ rate: optsRef.current.rate, voiceURI: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices]);

  // Pause auto-scroll briefly when user scrolls manually
  useEffect(() => {
    const pause = () => {
      pauseUntilRef.current = Date.now() + 3000;
    };
    window.addEventListener("wheel", pause, { passive: true });
    window.addEventListener("touchmove", pause, { passive: true });
    return () => {
      window.removeEventListener("wheel", pause);
      window.removeEventListener("touchmove", pause);
    };
  }, []);

  const speakSentenceRange = useCallback(
    (fromOffset: number, overrides?: { voiceURI?: string; rate?: number }) => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      speakGenRef.current += 1;
      const gen = speakGenRef.current;
      synth.cancel();
      const vuri = overrides?.voiceURI ?? optsRef.current.voiceURI;
      const r = overrides?.rate ?? optsRef.current.rate;
      const voice = voices.find((v) => v.voiceURI === vuri) ?? null;

      let startIdx = sentences.findIndex((s) => fromOffset < s.end);
      if (startIdx === -1) startIdx = 0;
      queueRef.current = { idx: startIdx, speaking: true };
      setPlaying(true);
      setStatus("playing");
      setSpeakError(null);

      const speakIdx = (idx: number, charStart: number) => {
        if (!queueRef.current.speaking || idx >= sentences.length) {
          queueRef.current.speaking = false;
          setPlaying(false);
          if (statusRef.current !== "error") setStatus("idle");
          if (idx >= sentences.length && aliveRef.current) onEndedRef.current?.();
          return;
        }
        queueRef.current.idx = idx;
        const s = sentences[idx]!;
        const sliceFrom = Math.max(0, charStart - s.start);
        const utterText = sliceFrom > 0 ? s.text.slice(sliceFrom) : s.text;
        const utterStart = charStart > s.start ? charStart : s.start;
        if (!utterText.trim()) {
          speakIdx(idx + 1, sentences[idx + 1]?.start ?? charStart);
          return;
        }
        const u = new SpeechSynthesisUtterance(utterText);
        u.rate = r;
        if (voice) u.voice = voice;
        u.onboundary = (e: SpeechSynthesisEvent) => {
          if (gen !== speakGenRef.current) return;
          const rel = typeof e.charIndex === "number" ? e.charIndex : 0;
          const global = utterStart + rel;
          const sIdx = sentences.findIndex((x) => global >= x.start && global < x.end);
          applyHighlight(global, sIdx === -1 ? null : sIdx);
        };
        u.onend = () => {
          if (gen !== speakGenRef.current) return;
          if (!queueRef.current.speaking || statusRef.current === "error") return;
          speakIdx(idx + 1, sentences[idx + 1]?.start ?? utterStart);
        };
        u.onerror = (ev: SpeechSynthesisErrorEvent) => {
          if (gen !== speakGenRef.current) return;
          const code = (ev as SpeechSynthesisErrorEvent | undefined)?.error;
          if (isCanceledSpeechError(code)) return;
          queueRef.current.speaking = false;
          setPlaying(false);
          const detail =
            typeof (ev as SpeechSynthesisErrorEvent | undefined)?.error === "string" &&
            (ev as SpeechSynthesisErrorEvent).error
              ? `Speech error: ${(ev as SpeechSynthesisErrorEvent).error}`
              : "Speech error: playback failed";
          setSpeakError(detail);
          setStatus("error");
          flushPosition();
        };
        synth.speak(u);
        // Sentence-level fallback highlight (Firefox has no word events)
        applyHighlight(utterStart, idx);
      };

      speakIdx(startIdx, fromOffset);
    },
    [sentences, supported, voices, applyHighlight, flushPosition]
  );

  // --- Offline (<audio>) engine -------------------------------------------
  // Same queue semantics as the system path (per-sentence slices from a
  // canonical offset), but each sentence is synthesized to WAV (mespeak,
  // bundled eSpeak — no network TTS) and played through one `<audio>`
  // element, which iOS keeps alive on lock / in background. Highlight is
  // time-interpolated off `currentTime` (no onboundary from eSpeak v1).

  /** Silence the system queue without touching offline state. */
  const stopSystemQueue = useCallback(() => {
    queueRef.current.speaking = false;
    if (!supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore — synth already gone (SSR/test teardown)
    }
  }, [supported]);

  /** Halt offline playback. `speaking=false` first so the element's own
   * error/ended events from the src teardown are ignored. */
  function stopOfflineAudio(clearSrc: boolean) {
    offlineGenRef.current += 1;
    offlineSpeakingRef.current = false;
    offlinePlanRef.current = null;
    const el = audioRef.current;
    if (!el) return;
    try {
      el.pause();
    } catch {
      // ignore
    }
    if (clearSrc) {
      el.removeAttribute("src");
      el.load();
    }
  }

  /** Synthesize (or reuse from the LRU-capped session cache) one slice. */
  const synthesizeCached = useCallback(
    (utterText: string, wpm: number): Promise<{ url: string; durationSec: number }> => {
      const key = audioCacheKey(utterText, wpm);
      const hit = offlineCacheRef.current.get(key);
      if (hit) return Promise.resolve(hit);
      return ensureMespeakLoaded().then((engine) => {
        const res = synthesizeWavArray(engine, utterText, wpm);
        if (!res) throw new Error("synthesis failed");
        const url = URL.createObjectURL(wavArrayToBlob(res.wav));
        const entry = { url, durationSec: res.durationSec };
        const cache = offlineCacheRef.current;
        if (cache.size >= 60) {
          const oldest = cache.keys().next();
          if (!oldest.done) {
            const evicted = cache.get(oldest.value);
            if (evicted) {
              try {
                URL.revokeObjectURL(evicted.url);
              } catch {
                // ignore
              }
            }
            cache.delete(oldest.value);
          }
        }
        cache.set(key, entry);
        return entry;
      });
    },
    []
  );

  const failOffline = useCallback(
    (message: string) => {
      offlineSpeakingRef.current = false;
      setPlaying(false);
      setStatus("error");
      setOfflinePhase("error");
      setOfflineError(message);
      flushPosition();
    },
    [flushPosition]
  );

  /** Start (or restart after error/drain) offline playback from an offset. */
  const speakOfflineRange = useCallback(
    (fromOffset: number) => {
      stopSystemQueue();
      offlineGenRef.current += 1;
      const gen = offlineGenRef.current;
      const wpm = rateToWpm(optsRef.current.rate);
      const plan = planAudioFromOffset(sentences, fromOffset);
      offlineSpeakingRef.current = true;
      offlinePlanRef.current = plan;
      setPlaying(true);
      setStatus("playing");
      setSpeakError(null);
      setOfflineError(null);
      setOfflinePhase("loading");
      if (!plan) {
        offlineSpeakingRef.current = false;
        offlinePlanRef.current = null;
        setPlaying(false);
        setStatus("idle");
        setOfflinePhase("idle");
        if (aliveRef.current) onEndedRef.current?.();
        return;
      }
      applyHighlight(plan.utterStart, plan.sentenceIndex);
      void synthesizeCached(plan.utterText, wpm).then(
        (entry) => {
          if (gen !== offlineGenRef.current || !aliveRef.current) return;
          const el = audioRef.current;
          if (!el) {
            failOffline("Audio element unavailable — Retry to continue.");
            return;
          }
          offlineDurRef.current = entry.durationSec;
          setOfflinePhase("ready");
          el.src = entry.url;
          el.playbackRate = optsRef.current.rate;
          void el
            .play()
            .then(() => {
              if (gen !== offlineGenRef.current) return;
              // Prefetch the next sentence while this one plays.
              const next = planAudioNext(sentences, plan.sentenceIndex);
              if (next) void synthesizeCached(next.utterText, wpm).catch(() => {});
            })
            .catch(() => {
              if (gen !== offlineGenRef.current) return;
              failOffline("Audio playback was blocked — tap Retry.");
            });
        },
        () => {
          if (gen !== offlineGenRef.current) return;
          failOffline("Offline voice failed to load — check connection, then Retry.");
        }
      );
    },
    [sentences, applyHighlight, stopSystemQueue, synthesizeCached, failOffline]
  );

  /** `<audio ended>` — advance to the next sentence or drain the queue. */
  function handleAudioEnded() {
    if (engineRef.current !== "offline" || !offlineSpeakingRef.current) return;
    const gen = offlineGenRef.current;
    const plan = offlinePlanRef.current;
    if (!plan) return;
    const wpm = rateToWpm(optsRef.current.rate);
    const next = planAudioNext(sentences, plan.sentenceIndex);
    if (!next) {
      offlineSpeakingRef.current = false;
      offlinePlanRef.current = null;
      setPlaying(false);
      setStatus("idle");
      if (aliveRef.current) onEndedRef.current?.();
      return;
    }
    offlinePlanRef.current = next;
    applyHighlight(next.utterStart, next.sentenceIndex);
    void synthesizeCached(next.utterText, wpm).then(
      (entry) => {
        if (gen !== offlineGenRef.current || !aliveRef.current) return;
        const el = audioRef.current;
        if (!el) {
          failOffline("Audio element unavailable — Retry to continue.");
          return;
        }
        offlineDurRef.current = entry.durationSec;
        el.src = entry.url;
        el.playbackRate = optsRef.current.rate;
        void el
          .play()
          .then(() => {
            if (gen !== offlineGenRef.current) return;
            const following = planAudioNext(sentences, next.sentenceIndex);
            if (following) void synthesizeCached(following.utterText, wpm).catch(() => {});
          })
          .catch(() => {
            if (gen !== offlineGenRef.current) return;
            failOffline("Audio playback was blocked — tap Retry.");
          });
      },
      () => {
        if (gen !== offlineGenRef.current) return;
        failOffline("Offline voice failed — Retry resumes from here.");
      }
    );
  }

  /** `<audio timeupdate>` (~4Hz) — interpolate the playhead in the slice. */
  function handleAudioTimeUpdate(e: React.SyntheticEvent<HTMLAudioElement>) {
    if (engineRef.current !== "offline" || !offlineSpeakingRef.current) return;
    const plan = offlinePlanRef.current;
    if (!plan) return;
    const el = e.currentTarget;
    const dur =
      Number.isFinite(el.duration) && el.duration > 0 ? el.duration : offlineDurRef.current;
    const off = estimateGlobalOffset(plan, el.currentTime, dur);
    const sIdx = sentences.findIndex((x) => off >= x.start && off < x.end);
    applyHighlight(off, sIdx === -1 ? plan.sentenceIndex : sIdx);
  }

  function handleAudioError() {
    // Teardown (seek/switch/pause) clears speaking first, so stray element
    // errors from src removal never surface.
    if (engineRef.current !== "offline" || !offlineSpeakingRef.current) return;
    // An empty-src element reports an error on load() — not a real failure.
    const src = audioRef.current?.currentSrc;
    if (!src) return;
    failOffline("Audio playback failed — Retry resumes from here.");
  }

  function pauseOfflineAudio() {
    if (!offlineSpeakingRef.current || statusRef.current !== "playing") return;
    // Bump the generation: a synthesis still in flight must not start the
    // element after the user paused.
    offlineGenRef.current += 1;
    try {
      audioRef.current?.pause();
    } catch {
      // ignore
    }
    setPlaying(false);
    setStatus("paused");
    flushPosition();
  }

  function resumeOfflineAudio() {
    const el = audioRef.current;
    if (!offlineSpeakingRef.current || !el || !el.currentSrc) {
      // Paused mid-synthesis, or src cleared: (re)start from the playhead.
      hasPlayedRef.current = true;
      speakOfflineRange(activeOffsetRef.current ?? 0);
      return;
    }
    el.playbackRate = optsRef.current.rate;
    void el
      .play()
      .then(() => {
        setPlaying(true);
        setStatus("playing");
      })
      .catch(() => {
        failOffline("Audio playback was blocked — tap Retry.");
      });
  }

  function onPlayPauseOffline() {
    if (offlineSpeakingRef.current && playing) {
      pauseOfflineAudio();
      return;
    }
    if (offlineSpeakingRef.current && statusRef.current === "paused") {
      resumeOfflineAudio();
      return;
    }
    let start = activeOffsetRef.current ?? 0;
    if (!hasPlayedRef.current) {
      try {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        if (h > 0) {
          const p = Math.min(1, Math.max(0, window.scrollY / h));
          start = fractionToOffset(p, textLength);
        }
      } catch {
        // DOM read failed (SSR/test) — fall back to the kept playhead.
      }
    }
    hasPlayedRef.current = true;
    speakOfflineRange(start);
  }

  function handleEngineChange(next: TtsEngine) {
    stopSystemQueue();
    stopOfflineAudio(true);
    setPlaying(false);
    setStatus("idle");
    setSpeakError(null);
    setOfflineError(null);
    if (next === "system") setOfflinePhase("idle");
    setEngine(next);
    engineRef.current = next;
    saveTtsEngine(next);
    flushPosition();
  }

  // Revoke synthesized blob URLs on unmount (the 60-entry session cache is
  // otherwise kept across engine switches for instant switch-back).
  useEffect(
    () => () => {
      offlineGenRef.current += 1;
      const cache = offlineCacheRef.current;
      for (const entry of cache.values()) {
        try {
          URL.revokeObjectURL(entry.url);
        } catch {
          // ignore
        }
      }
      cache.clear();
    },
    []
  );

  // First Play in a view starts from where you're reading: capture the live
  // scroll position (the playhead ref only knows the last *listen* offset,
  // which is 0 on a fresh read-to-listen switch). Later starts (retry after
  // error, replay after drain) resume the kept playhead instead.
  const hasPlayedRef = useRef(false);

  function onPlayPause() {
    if (engineRef.current === "offline") {
      onPlayPauseOffline();
      return;
    }
    if (!supported) return;
    const synth = window.speechSynthesis;
    const action = nextPlayPauseAction({
      queueSpeaking: queueRef.current.speaking,
      playing,
      status: statusRef.current,
      synthPaused: synth.paused,
      synthSpeaking: synth.speaking,
    });
    if (action === "pause") {
      synth.pause();
      setPlaying(false);
      setStatus("paused");
      flushPosition();
      return;
    }
    if (action === "resume") {
      synth.resume();
      setPlaying(true);
      setStatus("playing");
      return;
    }
    let start = activeOffsetRef.current ?? 0;
    if (!hasPlayedRef.current) {
      try {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        if (h > 0) {
          const p = Math.min(1, Math.max(0, window.scrollY / h));
          start = fractionToOffset(p, textLength);
        }
      } catch {
        // DOM read failed (SSR/test) — fall back to the kept playhead.
      }
    }
    hasPlayedRef.current = true;
    speakSentenceRange(start);
  }

  const seekFromHtml = useCallback(
    (hi: number, e?: Pick<ReactMouseEvent, "preventDefault" | "target">) => {
      const model = modelRef.current;
      // Taps inside links navigate while idle/paused/error; while playing
      // they seek (never yank the page away mid-listen).
      const inLink =
        e?.target instanceof Element ? (e.target as Element).closest("a") != null : false;
      const activelyPlaying =
        (queueRef.current.speaking || offlineSpeakingRef.current) &&
        statusRef.current === "playing";
      if (inLink && !activelyPlaying) return;
      if (inLink) e?.preventDefault();
      let off = model ? htmlIndexToTextOffset(hi, model.textWords, model.alignment) : null;
      if (off == null) off = estimateTextOffsetForHtmlIndex(hi, model?.htmlCount ?? 0, textLength);
      hasPlayedRef.current = true;
      if (engineRef.current === "offline") {
        speakOfflineRange(off);
        return;
      }
      speakSentenceRange(off);
    },
    [speakSentenceRange, speakOfflineRange, textLength]
  );
  const seekRef = useRef(seekFromHtml);
  seekRef.current = seekFromHtml;

  function handleRateChange(next: number) {
    setRate(next);
    const voice = optsRef.current.voiceURI;
    optsRef.current = { voiceURI: voice, rate: next };
    saveVoiceSettings({ rate: next, voiceURI: voice });
    if (engineRef.current === "offline") {
      // No re-synthesis: the current sentence keeps its audio at the new
      // tempo via playbackRate, later sentences synthesize at the new wpm.
      try {
        if (audioRef.current) audioRef.current.playbackRate = next;
      } catch {
        // ignore
      }
      return;
    }
    if (queueRef.current.speaking && statusRef.current === "playing") {
      speakSentenceRange(activeOffsetRef.current ?? 0, { rate: next, voiceURI: voice });
    }
  }

  function handleVoiceChange(nextURI: string) {
    setVoiceURI(nextURI);
    const r = optsRef.current.rate;
    optsRef.current = { voiceURI: nextURI, rate: r };
    saveVoiceSettings({ rate: r, voiceURI: nextURI });
    if (engineRef.current !== "offline") {
      if (queueRef.current.speaking && statusRef.current === "playing") {
        speakSentenceRange(activeOffsetRef.current ?? 0, { rate: r, voiceURI: nextURI });
      }
    }
  }

  function pausePlayback() {
    if (engineRef.current === "offline") {
      pauseOfflineAudio();
      return;
    }
    if (!supported) return;
    if (!queueRef.current.speaking || statusRef.current !== "playing") return;
    window.speechSynthesis.pause();
    setPlaying(false);
    setStatus("paused");
    flushPosition();
  }

  const playPauseRef = useRef(onPlayPause);
  playPauseRef.current = onPlayPause;
  const pauseRef = useRef(pausePlayback);
  pauseRef.current = pausePlayback;
  useEffect(() => {
    const sessionActive = playing || statusRef.current === "paused";
    if (!sessionActive) {
      clearMediaSession();
      return;
    }
    setupMediaSession(title ?? "Readapaper", {
      onPlay: () => playPauseRef.current(),
      onPause: () => playPauseRef.current(),
      onStop: () => pauseRef.current(),
    });
    return () => clearMediaSession();
  }, [playing, status, title]);

  const tokenized = useMemo(() => {
    if (!mounted || typeof document === "undefined") return null;
    const { nodes, htmlWords } = tokenizeArticleHtml(html, document, (hi, e) =>
      seekRef.current(hi, e)
    );
    const alignment = buildWordAlignment(textWords, htmlWords);
    const sentenceHtml: number[][] = sentences.map(() => []);
    htmlWords.forEach((_, j) => {
      const ti = alignment.htmlToText[j];
      if (ti == null) return;
      const off = textWords[ti]?.start;
      if (off == null) return;
      const si = sentences.findIndex((s) => off >= s.start && off < s.end);
      if (si !== -1) sentenceHtml[si]!.push(j);
    });
    return { nodes, alignment, sentenceHtml, htmlCount: htmlWords.length };
  }, [html, mounted, textWords, sentences]);

  useEffect(() => {
    if (!tokenized) {
      modelRef.current = null;
      return;
    }
    modelRef.current = {
      alignment: tokenized.alignment,
      textWords,
      sentenceHtml: tokenized.sentenceHtml,
      htmlCount: tokenized.htmlCount,
    };
    // Silent restore: highlight the saved word with no autoplay, no persist.
    const si = sentences.findIndex((s) => initialOffset >= s.start && initialOffset < s.end);
    applyHighlight(initialOffset, si === -1 ? null : si, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenized]);

  const hasSpeech = sentences.length > 0;
  // The offline engine needs no speechSynthesis, so it stays available where
  // system TTS is missing.
  const ttsAvailable = supported || engine === "offline";
  const statusDetail = speakError ?? offlineError;

  return (
    <div>
      {ttsAvailable && hasSpeech ? (
        <section aria-label="Listen in sync" className="listen-bar">
          <div className="controls">
            <button className="primary" onClick={onPlayPause}>
              {playing
                ? "⏸ Pause"
                : status === "error"
                  ? "↻ Retry"
                  : status === "paused"
                    ? "▶ Resume"
                    : "▶ Listen"}
            </button>
            <label>
              Voice engine{" "}
              <select
                value={engine}
                onChange={(e) => handleEngineChange(e.target.value as TtsEngine)}
                aria-label="TTS engine"
              >
                <option value="system">System voice</option>
                <option value="offline">Offline — plays locked</option>
              </select>
            </label>
            <label>
              Rate{" "}
              <select
                value={rate}
                onChange={(e) => handleRateChange(Number(e.target.value))}
                aria-label="Speech rate"
              >
                {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}x
                  </option>
                ))}
              </select>
            </label>
            <label
              title={
                engine === "offline" ? "Offline voice uses the built-in English voice" : undefined
              }
            >
              Voice{" "}
              <select
                value={voiceURI}
                onChange={(e) => handleVoiceChange(e.target.value)}
                aria-label="Voice"
                style={{ maxWidth: 220 }}
                disabled={engine === "offline"}
              >
                <option value="">Default</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />{" "}
              Auto-scroll
            </label>
            <span role="status" aria-live="polite" data-testid="listen-status" className="muted">
              Status:{" "}
              {status === "playing"
                ? engine === "offline" && offlinePhase === "loading"
                  ? "Loading offline voice…"
                  : "Playing"
                : status === "paused"
                  ? "Paused"
                  : status === "error"
                    ? `Error${statusDetail ? ` — ${statusDetail}` : ""}`
                    : "Idle"}
            </span>
            {engine === "offline" && (
              <span className="muted" data-testid="offline-voice-note">
                Offline voice: robotic English, keeps playing with the screen locked or in
                background.
              </span>
            )}
          </div>
          {/* Single background-capable player for the offline engine. Hidden:
          highlight + status carry the UX; the element must stay mounted so
          iOS keeps the audio session alive across sentences. */}
          <audio
            ref={audioRef}
            preload="auto"
            data-testid="offline-audio"
            style={{ display: "none" }}
            onEnded={handleAudioEnded}
            onTimeUpdate={handleAudioTimeUpdate}
            onError={handleAudioError}
          />
        </section>
      ) : (
        <p className="muted">
          {!supported
            ? "Text-to-speech is not supported in this browser. Try Chrome or Edge."
            : "No readable text for speech."}
        </p>
      )}

      {tokenized ? (
        <article
          className="article-body"
          role="article"
          aria-label="Article"
          ref={rootRef as React.RefObject<HTMLElement>}
        >
          {tokenized.nodes}
        </article>
      ) : (
        <article
          className="article-body"
          // Sanitized server-side with DOMPurify allowlist (see lib/extract.ts)
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <p className="muted">
        Tip: click any word to listen from there — the highlight follows right here. Pause to keep
        reading; links work while paused. Switch to the Offline engine to keep listening with the
        screen locked or in another app.
      </p>
    </div>
  );
}
