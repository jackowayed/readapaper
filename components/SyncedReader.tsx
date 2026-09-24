"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitSentences, splitWords } from "@/lib/text";
import { clampOffset } from "@/lib/progress-sync";
import { clearMediaSession, setupMediaSession } from "@/lib/media-session";
import { nextPlayPauseAction, isCanceledSpeechError } from "@/lib/speech-queue";
import { loadVoiceSettings, saveVoiceSettings } from "@/lib/voice-settings";

/**
 * SyncedReader — Web Speech API driver (v0).
 * - Speaks article text as a queue of per-sentence utterances (avoids Chrome's
 *   long-utterance cutoff / 15s pause bug).
 * - Highlights current word via onboundary charIndex + auto-scrolls.
 * - Click any word to seek. Firefox lacks word boundaries -> sentence fallback.
 * - Single Play/Pause toggle (no separate Stop — pausing keeps the position,
 *   resuming continues from it; click the first word to restart from the top).
 * - Voice settings (rate + voice) persist per-browser in localStorage
 *   (offline-safe) and apply immediately: changing them mid-play restarts
 *   from the current playhead with the new settings; while paused/idle the
 *   new settings apply to the next resume/start.
 * - Media Session API: lock-screen play/pause controls (OS-level stop maps
 *   to pause, keeping the position).
 * - Unified progress: starts highlighting at `startOffset` (silent restore, no
 *   autoplay) and reports the playhead via `onPosition` — throttled to ~2s
 *   during playback, flushed on pause/unmount/hide. The owner persists
 *   through the shared offline-safe sender.
 */
export default function SyncedReader({
  text,
  title,
  startOffset,
  onPosition,
  onEnded,
}: {
  text: string;
  title?: string;
  startOffset?: number;
  onPosition?: (offset: number) => void;
  /**
   * Fired once when the sentence queue drains naturally (all utterances
   * ended). NOT fired on pause, error, stop/cancel, or unmount — the queue
   * player uses it to advance to the next article.
   */
  onEnded?: () => void;
}) {
  const sentences = useMemo(() => splitSentences(text), [text]);
  const words = useMemo(() => splitWords(text), [text]);
  const paragraphs = useMemo(() => {
    // group words by blank-line paragraphs so layout mirrors the article
    const paras: (typeof words)[] = [];
    // walk raw text paragraph splits and bucket words by offset
    const splits: { start: number; end: number }[] = [];
    const re = /\n\s*\n/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      splits.push({ start: last, end: m.index });
      last = m.index + m[0].length;
    }
    splits.push({ start: last, end: text.length });
    for (const s of splits) {
      const bucket = words.filter((w) => w.start >= s.start && w.start < s.end);
      if (bucket.length) paras.push(bucket);
    }
    if (!paras.length && words.length) paras.push(words);
    return paras;
  }, [text, words]);

  const [supported] = useState(() => typeof window !== "undefined" && "speechSynthesis" in window);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  // Per-browser memory (localStorage, offline-safe): lazy init so SSR falls
  // back to defaults without touching window.
  const [voiceURI, setVoiceURI] = useState<string>(() => loadVoiceSettings().voiceURI);
  const [rate, setRate] = useState<number>(() => loadVoiceSettings().rate);
  const [playing, setPlaying] = useState(false);
  // Audible player state (listen-reliability Phase 1): idle | playing |
  // paused | error, shown as a status line next to the controls. Silent
  // position restore + throttled onPosition persist below are unchanged.
  const [status, setStatus] = useState<"idle" | "playing" | "paused" | "error">("idle");
  const [speakError, setSpeakError] = useState<string | null>(null);
  const statusRef = useRef<"idle" | "playing" | "paused" | "error">("idle");
  statusRef.current = status;
  const [activeOffset, setActiveOffset] = useState<number | null>(() =>
    clampOffset(startOffset ?? 0, text.length)
  );
  const [activeSentence, setActiveSentence] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const queueRef = useRef<{ idx: number; speaking: boolean }>({ idx: 0, speaking: false });
  // Generation counter: bumped on every speakSentenceRange (cancel→speak).
  // Real browsers fire onerror({error:'interrupted'/'canceled'}) + onend on
  // the cancelled in-flight utterance; the stale closures must ignore them
  // so a rate/voice change or seek mid-play doesn't flip Playing → Error.
  const speakGenRef = useRef(0);
  const optsRef = useRef({ voiceURI, rate });
  optsRef.current = { voiceURI, rate };
  const pauseUntilRef = useRef(0);
  const activeOffsetRef = useRef<number | null>(null);
  activeOffsetRef.current = activeOffset;

  // Throttled playhead reporting: boundary ticks update local highlight
  // immediately, but `onPosition` fires at most every ~2s; pause/unmount/
  // hide always flush the latest offset.
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  // Natural-drain callback (queue advance). Ref pattern keeps the speak
  // closure stable; only the drain path below invokes it.
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  // Guard against a trailing onend racing unmount (cancel in cleanup can
  // still flush a queued end event in real browsers).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const lastSentRef = useRef<number | null>(null);
  const lastSentAtRef = useRef(0);
  const pendingRef = useRef<number | null>(null);

  const reportPosition = useCallback((offset: number, force = false) => {
    pendingRef.current = offset;
    const send = onPositionRef.current;
    if (!send) return;
    const now = Date.now();
    if (!force && offset === lastSentRef.current) return;
    if (!force && now - lastSentAtRef.current < 2000) return;
    lastSentRef.current = offset;
    lastSentAtRef.current = now;
    send(offset);
  }, []);

  const flushPosition = useCallback(() => {
    const pending = pendingRef.current;
    const send = onPositionRef.current;
    if (send == null || pending == null || pending === lastSentRef.current) return;
    lastSentRef.current = pending;
    lastSentAtRef.current = Date.now();
    send(pending);
  }, []);

  // Flush the latest playhead on hide + unmount (silent, no UI).
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

  // Stored voice may not exist in this browser (voices are per-device): once
  // the voice list arrives, fall back to Default instead of a blank select.
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

  // Word shown as active for a playhead offset: the containing word, or —
  // when the offset lands on inter-word whitespace — the nearest preceding
  // word (same fallback as auto-scroll, so restore always highlights).
  const activeWordStart = useMemo(() => {
    if (activeOffset == null) return null;
    const exact = words.find((x) => activeOffset >= x.start && activeOffset < x.end);
    if (exact) return exact.start;
    return words.filter((x) => x.start <= activeOffset).pop()?.start ?? null;
  }, [activeOffset, words]);

  // Auto-scroll to active word
  useEffect(() => {
    if (activeWordStart == null || !autoScroll) return;
    if (Date.now() < pauseUntilRef.current) return;
    document
      .getElementById(`w-${activeWordStart}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeWordStart, autoScroll]);

  const speakSentenceRange = useCallback(
    (fromOffset: number, overrides?: { voiceURI?: string; rate?: number }) => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      // NOTE (listen-reliability suspect #1): cancel() immediately followed
      // by speak() is a known Chrome race that can swallow the first
      // utterance. Phase 0 confirmed the pattern is present but the race did
      // NOT repro in headless Chromium, so per spec §5 we ship surfacing
      // only and keep this call order unchanged.
      // Bump the generation BEFORE cancel: the cancelled utterance's async
      // onerror('interrupted'/'canceled') + onend belong to the old
      // generation and are ignored below.
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
      setActiveSentence(startIdx);

      const speakIdx = (idx: number, charStart: number) => {
        if (!queueRef.current.speaking || idx >= sentences.length) {
          queueRef.current.speaking = false;
          setPlaying(false);
          // Keep an error state sticky: a trailing onend after onerror must
          // not overwrite it (browsers fire both).
          if (statusRef.current !== "error") setStatus("idle");
          // Natural drain only: the queue was live and ran past the last
          // sentence (not a pause/error/stop halt, which clears `speaking`
          // first or never reaches the tail). Skip after unmount.
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
          // Chrome/Edge/Safari: e.name==='word' + charIndex. Firefox: sentence only.
          const rel = typeof e.charIndex === "number" ? e.charIndex : 0;
          const global = utterStart + rel;
          setActiveOffset(global);
          reportPosition(global);
          const sIdx = sentences.findIndex((x) => global >= x.start && global < x.end);
          if (sIdx !== -1) setActiveSentence(sIdx);
        };
        u.onend = () => {
          if (gen !== speakGenRef.current) return;
          // Ignore trailing ends after pause/error so an error stays visible
          // for retry instead of flipping back to idle.
          if (!queueRef.current.speaking || statusRef.current === "error") return;
          speakIdx(idx + 1, sentences[idx + 1]?.start ?? utterStart);
        };
        u.onerror = (ev: SpeechSynthesisErrorEvent) => {
          if (gen !== speakGenRef.current) return;
          const code = (ev as SpeechSynthesisErrorEvent | undefined)?.error;
          // Our own cancel() (rate/voice change, seek, restart) surfaces as
          // 'interrupted' (Chrome) / 'canceled' (Safari) on the replaced
          // utterance — never a real failure, stay Playing.
          if (isCanceledSpeechError(code)) return;
          queueRef.current.speaking = false;
          setPlaying(false);
          // Position (activeOffset) is deliberately kept for retry.
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
        setActiveOffset(utterStart);
        reportPosition(utterStart);
      };

      speakIdx(startIdx, fromOffset);
    },
    [sentences, supported, voices, reportPosition, flushPosition]
  );

  function onPlayPause() {
    if (!supported) return;
    const synth = window.speechSynthesis;
    // Derive the intent from owned state (playing/status), not from a
    // post-mutation read of `synth.paused` — that flag can flip
    // asynchronously, which previously left the button stuck on "Pause"
    // while the audio was actually paused.
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
    // "restart" (Chrome dropped the queue while paused) and "start"
    // (idle/error/drained) both re-speak from the kept offset. A fresh
    // cancel→speak also clears a stale synth paused flag, so unlike the
    // old code there is no resume-only fallback for an idle queue (it
    // would report Playing while silent).
    speakSentenceRange(activeOffsetRef.current ?? 0);
  }

  function onSeek(offset: number) {
    speakSentenceRange(offset);
  }

  // Voice settings apply immediately: while playing, restart from the
  // current playhead with the new settings (same cancel→speak order as a
  // seek); while paused/idle, persist for the next resume/start.
  function handleRateChange(next: number) {
    setRate(next);
    const voice = optsRef.current.voiceURI;
    optsRef.current = { voiceURI: voice, rate: next };
    saveVoiceSettings({ rate: next, voiceURI: voice });
    if (queueRef.current.speaking && statusRef.current === "playing") {
      speakSentenceRange(activeOffsetRef.current ?? 0, { rate: next, voiceURI: voice });
    }
  }

  function handleVoiceChange(nextURI: string) {
    setVoiceURI(nextURI);
    const r = optsRef.current.rate;
    optsRef.current = { voiceURI: nextURI, rate: r };
    saveVoiceSettings({ rate: r, voiceURI: nextURI });
    if (queueRef.current.speaking && statusRef.current === "playing") {
      speakSentenceRange(activeOffsetRef.current ?? 0, { rate: r, voiceURI: nextURI });
    }
  }

  // OS-level stop keeps the position (same as pause) — there is no
  // destructive reset; the playhead stays highlighted for resume/retry.
  function pausePlayback() {
    if (!supported) return;
    if (!queueRef.current.speaking || statusRef.current !== "playing") return;
    window.speechSynthesis.pause();
    setPlaying(false);
    setStatus("paused");
    flushPosition();
  }

  // Lock-screen / background controls while listening or paused (so resume
  // stays available from the lock screen). Cleared when idle/error/drained.
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

  if (!supported) {
    return (
      <p className="muted">Text-to-speech is not supported in this browser. Try Chrome or Edge.</p>
    );
  }
  if (!sentences.length) {
    return <p className="muted">No readable text for speech.</p>;
  }

  const activeSent = activeSentence != null ? sentences[activeSentence] : null;

  return (
    <section aria-label="Listen in sync">
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
        <label>
          Voice{" "}
          <select
            value={voiceURI}
            onChange={(e) => handleVoiceChange(e.target.value)}
            aria-label="Voice"
            style={{ maxWidth: 220 }}
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
            ? "Playing"
            : status === "paused"
              ? "Paused"
              : status === "error"
                ? `Error${speakError ? ` — ${speakError}` : ""}`
                : "Idle"}
        </span>
      </div>

      <div className="listen-text" role="article" aria-label="Sync text">
        {paragraphs.map((para, pi) => (
          <p key={pi}>
            {para.map((w) => {
              const isActive = activeWordStart != null && w.start === activeWordStart;
              const inSent =
                activeSent != null &&
                w.start >= activeSent.start &&
                w.start < activeSent.end &&
                !isActive;
              return (
                <span
                  key={w.start}
                  id={`w-${w.start}`}
                  className={`w${isActive ? " active" : ""}${inSent ? " sent-active" : ""}`}
                  onClick={() => onSeek(w.start)}
                  title="Click to play from here"
                >
                  {w.text}{" "}
                </span>
              );
            })}
          </p>
        ))}
      </div>
      <p className="muted">
        Tip: click any word to start listening from there. Pause keeps your place — press Resume to
        continue. Reading and listening share the same position.
      </p>
    </section>
  );
}
