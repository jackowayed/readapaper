/**
 * voice-settings — per-browser memory for TTS rate + pitch + voice.
 *
 * localStorage is origin- + profile-scoped, so settings are naturally
 * per-browser with zero server state — and fully functional offline
 * (no fetch, no SW dependency; reads/writes work with the network off).
 */

export const VOICE_RATE_KEY = "readapaper:tts:rate";
export const VOICE_URI_KEY = "readapaper:tts:voiceURI";
export const VOICE_PITCH_KEY = "readapaper:tts:pitch";

export const ALLOWED_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const ALLOWED_PITCHES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type VoiceSettings = {
  rate: number;
  voiceURI: string;
  pitch: number;
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { rate: 1, voiceURI: "", pitch: 1 };

function storage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // private mode / SSR — fall through to null
  }
  return null;
}

export function normalizeRate(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  if (
    typeof n === "number" &&
    Number.isFinite(n) &&
    (ALLOWED_RATES as readonly number[]).includes(n)
  )
    return n;
  return DEFAULT_VOICE_SETTINGS.rate;
}

export function normalizeVoiceURI(raw: unknown): string {
  return typeof raw === "string" ? raw : DEFAULT_VOICE_SETTINGS.voiceURI;
}

export function normalizePitch(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  if (
    typeof n === "number" &&
    Number.isFinite(n) &&
    (ALLOWED_PITCHES as readonly number[]).includes(n)
  )
    return n;
  return DEFAULT_VOICE_SETTINGS.pitch;
}

/** Load persisted settings; unknown/missing values fall back to defaults. */
export function loadVoiceSettings(): VoiceSettings {
  const store = storage();
  if (!store) return { ...DEFAULT_VOICE_SETTINGS };
  let rate = DEFAULT_VOICE_SETTINGS.rate;
  let voiceURI = DEFAULT_VOICE_SETTINGS.voiceURI;
  let pitch = DEFAULT_VOICE_SETTINGS.pitch;
  try {
    rate = normalizeRate(store.getItem(VOICE_RATE_KEY));
    voiceURI = normalizeVoiceURI(store.getItem(VOICE_URI_KEY));
    pitch = normalizePitch(store.getItem(VOICE_PITCH_KEY));
  } catch {
    // corrupted storage — defaults
  }
  return { rate, voiceURI, pitch };
}

/** Persist settings; never throws (private-mode quota errors are swallowed). */
export function saveVoiceSettings(settings: VoiceSettings): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(VOICE_RATE_KEY, String(settings.rate));
    store.setItem(VOICE_URI_KEY, settings.voiceURI);
    store.setItem(VOICE_PITCH_KEY, String(settings.pitch));
  } catch {
    // ignore — memory-only fallback for this session
  }
}
