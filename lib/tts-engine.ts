/**
 * tts-engine — which speech backend the reader uses.
 *
 * - `"system"`: OS/browser voices via `speechSynthesis` (default, best
 *   quality, word-exact highlight). Suspended by iOS when locked/backgrounded.
 * - `"offline"`: built-in eSpeak voice (mespeak, bundled JS, no network after
 *   first load) synthesized per sentence to WAV and played through a single
 *   `<audio>` element — the only client-side playback path iOS keeps alive
 *   on lock / in background. Robotic English, timing-estimated highlight.
 *
 * Persisted in localStorage (origin-scoped, offline-safe) next to the
 * rate/voice settings in `lib/voice-settings.ts`.
 */

export const TTS_ENGINE_KEY = "readapaper:tts:engine";

export type TtsEngine = "system" | "offline";

export const DEFAULT_TTS_ENGINE: TtsEngine = "system";

/** eSpeak speed (words/min) for the 1x rate. System rates scale off this. */
export const OFFLINE_BASE_WPM = 175;

/** eSpeak clamps gracefully, but keep requests in its sane band. */
export const OFFLINE_MIN_WPM = 80;
export const OFFLINE_MAX_WPM = 450;

function storage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // private mode / SSR — fall through to null
  }
  return null;
}

export function normalizeEngine(raw: unknown): TtsEngine {
  return raw === "offline" ? "offline" : "system";
}

export function loadTtsEngine(): TtsEngine {
  const store = storage();
  if (!store) return DEFAULT_TTS_ENGINE;
  try {
    return normalizeEngine(store.getItem(TTS_ENGINE_KEY));
  } catch {
    return DEFAULT_TTS_ENGINE;
  }
}

/** Persist the engine; never throws (private-mode quota errors swallowed). */
export function saveTtsEngine(engine: TtsEngine): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(TTS_ENGINE_KEY, engine);
  } catch {
    // ignore — memory-only fallback for this session
  }
}

/**
 * Map a UI speech rate (0.75..2, see ALLOWED_RATES) to an eSpeak speed.
 * Pure + clamped so seeks/replays synthesize identical audio for one rate.
 */
export function rateToWpm(rate: number): number {
  const wpm = Math.round(OFFLINE_BASE_WPM * rate);
  if (!Number.isFinite(wpm)) return OFFLINE_BASE_WPM;
  return Math.min(OFFLINE_MAX_WPM, Math.max(OFFLINE_MIN_WPM, wpm));
}
