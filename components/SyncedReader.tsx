"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitSentences, splitWords } from "@/lib/text";
import { clampOffset } from "@/lib/progress-sync";
import { clearMediaSession, setupMediaSession } from "@/lib/media-session";

/**
 * SyncedReader — Web Speech API driver (v0).
 * - Speaks article text as a queue of per-sentence utterances (avoids Chrome's
 *   long-utterance cutoff / 15s pause bug).
 * - Highlights current word via onboundary charIndex + auto-scrolls.
 * - Click any word to seek. Firefox lacks word boundaries -> sentence fallback.
 * - Media Session API: lock-screen / background play/pause/stop controls.
 * - Unified progress: starts highlighting at `startOffset` (silent restore, no
 *   autoplay) and reports the playhead via `onPosition` — throttled to ~2s
 *   during playback, flushed on pause/stop/unmount/hide. The owner persists
 *   through the shared offline-safe sender.
 */
export default function SyncedReader({
  text,
  title,
  startOffset,
  onPosition,
}: {
  text: string;
  title?: string;
  startOffset?: number;
  onPosition?: (offset: number) => void;
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
  const [voiceURI, setVoiceURI] = useState<string>("");
  const [rate, setRate] = useState(1);
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
  const optsRef = useRef({ voiceURI, rate });
  optsRef.current = { voiceURI, rate };
  const pauseUntilRef = useRef(0);
  const activeOffsetRef = useRef<number | null>(null);
  activeOffsetRef.current = activeOffset;

  // Throttled playhead reporting: boundary ticks update local highlight
  // immediately, but `onPosition` fires at most every ~2s; pause/stop/unmount/
  // hide always flush the latest offset.
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
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
    (fromOffset: number) => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      // NOTE (listen-reliability suspect #1): cancel() immediately followed
      // by speak() is a known Chrome race that can swallow the first
      // utterance. Phase 0 confirmed the pattern is present but the race did
      // NOT repro in headless Chromium, so per spec §5 we ship surfacing
      // only and keep this call order unchanged.
      synth.cancel();
      const { voiceURI: vuri, rate: r } = optsRef.current;
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
          // Chrome/Edge/Safari: e.name==='word' + charIndex. Firefox: sentence only.
          const rel = typeof e.charIndex === "number" ? e.charIndex : 0;
          const global = utterStart + rel;
          setActiveOffset(global);
          reportPosition(global);
          const sIdx = sentences.findIndex((x) => global >= x.start && global < x.end);
          if (sIdx !== -1) setActiveSentence(sIdx);
        };
        u.onend = () => {
          // Ignore trailing ends after stop/error so an error stays visible
          // for retry instead of flipping back to idle.
          if (!queueRef.current.speaking || statusRef.current === "error") return;
          speakIdx(idx + 1, sentences[idx + 1]?.start ?? utterStart);
        };
        u.onerror = (ev: SpeechSynthesisErrorEvent) => {
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
    if (queueRef.current.speaking && playing) {
      if (synth.paused) synth.resume();
      else synth.pause();
      // reflect pause state; speaking continues on resume
      const paused = synth.paused;
      setPlaying(paused ? false : true);
      setStatus(paused ? "paused" : "playing");
      flushPosition();
      if (!synth.paused && !synth.speaking) {
        // Chrome dropped the queue while paused -> restart
        speakSentenceRange(activeOffsetRef.current ?? 0);
      }
      return;
    }
    if (synth.paused) {
      synth.resume();
      setPlaying(true);
      setStatus("playing");
      return;
    }
    speakSentenceRange(activeOffsetRef.current ?? 0);
  }

  function onStop() {
    if (!supported) return;
    queueRef.current.speaking = false;
    window.speechSynthesis.cancel();
    setPlaying(false);
    setStatus("idle");
    setSpeakError(null);
    flushPosition();
    setActiveOffset(null);
    setActiveSentence(null);
  }

  function onSeek(offset: number) {
    speakSentenceRange(offset);
  }

  // Lock-screen / background controls while listening.
  const playPauseRef = useRef(onPlayPause);
  playPauseRef.current = onPlayPause;
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  useEffect(() => {
    if (!playing) {
      clearMediaSession();
      return;
    }
    setupMediaSession(title ?? "Readapaper", {
      onPlay: () => playPauseRef.current(),
      onPause: () => playPauseRef.current(),
      onStop: () => stopRef.current(),
    });
    return () => clearMediaSession();
  }, [playing, title]);

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
          {playing ? "⏸ Pause" : status === "error" ? "↻ Retry" : "▶ Listen"}
        </button>
        <button onClick={onStop} disabled={!playing && activeOffset == null}>
          ⏹ Stop
        </button>
        <label>
          Rate{" "}
          <select
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
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
            onChange={(e) => setVoiceURI(e.target.value)}
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
        Tip: click any word to start listening from there. Reading and listening share the same
        position.
      </p>
    </section>
  );
}
