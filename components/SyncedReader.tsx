"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitSentences, splitWords } from "@/lib/text";

/**
 * SyncedReader — Web Speech API driver (v0).
 * - Speaks article text as a queue of per-sentence utterances (avoids Chrome's
 *   long-utterance cutoff / 15s pause bug).
 * - Highlights current word via onboundary charIndex + auto-scrolls.
 * - Click any word to seek. Firefox lacks word boundaries -> sentence fallback.
 */
export default function SyncedReader({ text }: { text: string }) {
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
  const [activeOffset, setActiveOffset] = useState<number | null>(null);
  const [activeSentence, setActiveSentence] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const queueRef = useRef<{ idx: number; speaking: boolean }>({ idx: 0, speaking: false });
  const optsRef = useRef({ voiceURI, rate });
  optsRef.current = { voiceURI, rate };
  const pauseUntilRef = useRef(0);
  const activeOffsetRef = useRef<number | null>(null);
  activeOffsetRef.current = activeOffset;

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

  // Auto-scroll to active word
  useEffect(() => {
    if (activeOffset == null || !autoScroll) return;
    if (Date.now() < pauseUntilRef.current) return;
    const w = words.find((x) => activeOffset >= x.start && activeOffset < x.end);
    const target = w ?? words.filter((x) => x.start <= activeOffset).pop();
    if (!target) return;
    document
      .getElementById(`w-${target.start}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeOffset, autoScroll, words]);

  const speakSentenceRange = useCallback(
    (fromOffset: number) => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      synth.cancel();
      const { voiceURI: vuri, rate: r } = optsRef.current;
      const voice = voices.find((v) => v.voiceURI === vuri) ?? null;

      let startIdx = sentences.findIndex((s) => fromOffset < s.end);
      if (startIdx === -1) startIdx = 0;
      queueRef.current = { idx: startIdx, speaking: true };
      setPlaying(true);
      setActiveSentence(startIdx);

      const speakIdx = (idx: number, charStart: number) => {
        if (!queueRef.current.speaking || idx >= sentences.length) {
          queueRef.current.speaking = false;
          setPlaying(false);
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
          const sIdx = sentences.findIndex((x) => global >= x.start && global < x.end);
          if (sIdx !== -1) setActiveSentence(sIdx);
        };
        u.onend = () => speakIdx(idx + 1, sentences[idx + 1]?.start ?? utterStart);
        u.onerror = () => {
          queueRef.current.speaking = false;
          setPlaying(false);
        };
        synth.speak(u);
        // Sentence-level fallback highlight (Firefox has no word events)
        setActiveOffset(utterStart);
      };

      speakIdx(startIdx, fromOffset);
    },
    [sentences, supported, voices]
  );

  function onPlayPause() {
    if (!supported) return;
    const synth = window.speechSynthesis;
    if (queueRef.current.speaking && playing) {
      if (synth.paused) synth.resume();
      else synth.pause();
      // reflect pause state; speaking continues on resume
      setPlaying(synth.paused ? false : true);
      if (!synth.paused && !synth.speaking) {
        // Chrome dropped the queue while paused -> restart
        speakSentenceRange(activeOffsetRef.current ?? 0);
      }
      return;
    }
    if (synth.paused) {
      synth.resume();
      setPlaying(true);
      return;
    }
    speakSentenceRange(activeOffsetRef.current ?? 0);
  }

  function onStop() {
    if (!supported) return;
    queueRef.current.speaking = false;
    window.speechSynthesis.cancel();
    setPlaying(false);
    setActiveOffset(null);
    setActiveSentence(null);
  }

  function onSeek(offset: number) {
    speakSentenceRange(offset);
  }

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
          {playing ? "⏸ Pause" : "▶ Listen"}
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
      </div>

      <div className="listen-text" role="article" aria-label="Sync text">
        {paragraphs.map((para, pi) => (
          <p key={pi}>
            {para.map((w) => {
              const isActive =
                activeOffset != null && activeOffset >= w.start && activeOffset < w.end;
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
