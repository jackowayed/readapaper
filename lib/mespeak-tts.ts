/**
 * mespeak-tts — lazy offline voice (eSpeak, bundled JS, no network TTS).
 *
 * The `mespeak` package (~5MB: ESpeak.js + config + voice data) is NEVER
 * imported at module top level: `ensureMespeakLoaded` dynamic-imports it on
 * first offline Play so the initial bundle, SSR, and the system-voice path
 * stay untouched. Synthesis is synchronous CPU work per sentence; the
 * component prefetches the next sentence during playback to hide latency.
 *
 * `speak(..., { rawdata: "array" })` returns the WAV bytes without touching
 * any audio API, so this module is DOM-free and unit-testable with an
 * injected `MeSpeakLike` (tests never parse the 5MB engine).
 */

import { estimateDurationSecForText, parseWavDurationSec } from "./wav";

/** Structural mespeak surface — satisfied by the real package. */
export interface MeSpeakLike {
  speak(text: string, opts?: Record<string, unknown>): unknown;
  loadConfig(data: unknown): void;
  loadVoice(data: unknown): void;
  isConfigLoaded(): boolean;
}

export type MespeakBundle = {
  mespeak: MeSpeakLike;
  config: unknown;
  voice: unknown;
};

export type MespeakLoader = () => Promise<MespeakBundle>;

export type SynthResult = {
  /** Raw WAV file bytes (uint8). */
  wav: number[];
  /** Natural duration in seconds (header-parsed, text-estimated fallback). */
  durationSec: number;
};

let cached: MeSpeakLike | null = null;
let inflight: Promise<MeSpeakLike> | null = null;

/** Test hook: drop the memoized engine between cases. */
export function resetMespeakCache(): void {
  cached = null;
  inflight = null;
}

/**
 * Default loader: dynamic-import the engine + bundled en-us voice data,
 * then synchronously register both (object form — no XHR/fetch, works
 * offline after the first chunk load).
 */
async function defaultLoader(): Promise<MespeakBundle> {
  const [engineMod, configMod, voiceMod] = await Promise.all([
    import("mespeak"),
    import("mespeak/src/mespeak_config.json"),
    import("mespeak/voices/en/en-us.json"),
  ]);
  const mespeak = ((engineMod as unknown as { default?: MeSpeakLike }).default ??
    engineMod) as unknown as MeSpeakLike;
  const config = (configMod as unknown as { default?: unknown }).default ?? configMod;
  const voice = (voiceMod as unknown as { default?: unknown }).default ?? voiceMod;
  return { mespeak, config, voice };
}

/**
 * Load (once, memoized, concurrent-safe) and return the offline engine.
 * Inject `loader` in tests to avoid parsing the real 5MB bundle.
 */
export async function ensureMespeakLoaded(loader?: MespeakLoader): Promise<MeSpeakLike> {
  if (cached) return cached;
  if (!inflight) {
    inflight = (async () => {
      const { mespeak, config, voice } = await (loader ?? defaultLoader)();
      if (!mespeak.isConfigLoaded()) mespeak.loadConfig(config);
      mespeak.loadVoice(voice);
      cached = mespeak;
      return mespeak;
    })();
  }
  try {
    return await inflight;
  } catch (err) {
    // Failed loads must be retryable (error status -> Retry re-enters here).
    inflight = null;
    throw err;
  }
}

function toWavArray(out: unknown): number[] | null {
  if (Array.isArray(out)) return out as number[];
  if (out instanceof ArrayBuffer) return Array.from(new Uint8Array(out));
  if (typeof Uint8Array !== "undefined" && out instanceof Uint8Array) return Array.from(out);
  return null;
}

/**
 * Synthesize one sentence slice to WAV bytes. Returns null for blank text
 * or when the engine yields nothing usable (caller surfaces an error state
 * and keeps the playhead — same contract as `u.onerror` on system TTS).
 */
export function synthesizeWavArray(
  mespeak: MeSpeakLike,
  text: string,
  speedWpm: number
): SynthResult | null {
  if (!text.trim()) return null;
  let out: unknown;
  try {
    out = mespeak.speak(text, { speed: speedWpm, rawdata: "array" });
  } catch {
    return null;
  }
  const wav = toWavArray(out);
  if (!wav || wav.length < 44) return null;
  const durationSec = parseWavDurationSec(wav) ?? estimateDurationSecForText(text, speedWpm);
  return { wav, durationSec };
}
