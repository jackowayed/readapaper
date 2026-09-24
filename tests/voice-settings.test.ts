import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_PITCHES,
  DEFAULT_VOICE_SETTINGS,
  loadVoiceSettings,
  normalizePitch,
  normalizeRate,
  normalizeVoiceURI,
  saveVoiceSettings,
} from "../lib/voice-settings";

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => data.clear(),
    _data: data,
  };
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal("window", { localStorage: store });
  return store;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("voice-settings (per-browser localStorage memory, offline-safe)", () => {
  it("returns defaults when storage is empty or unavailable (SSR)", () => {
    stubStorage({});
    expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
    vi.unstubAllGlobals();
    // No window/localStorage at all — must not throw.
    expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it("round-trips rate + pitch + voiceURI", () => {
    const store = stubStorage({});
    saveVoiceSettings({ rate: 1.5, pitch: 0.75, voiceURI: "Google US English" });
    expect(store._data.get("readapaper:tts:rate")).toBe("1.5");
    expect(store._data.get("readapaper:tts:pitch")).toBe("0.75");
    expect(store._data.get("readapaper:tts:voiceURI")).toBe("Google US English");
    expect(loadVoiceSettings()).toEqual({ rate: 1.5, pitch: 0.75, voiceURI: "Google US English" });
  });

  it("falls back on invalid rate, keeps raw voiceURI for later voice-list match", () => {
    stubStorage({ "readapaper:tts:rate": "3", "readapaper:tts:voiceURI": "Some Voice" });
    expect(loadVoiceSettings()).toEqual({ rate: 1, pitch: 1, voiceURI: "Some Voice" });
  });

  it("pitch defaults to 1 and normalizes range 0.5–2 step 0.25", () => {
    expect(DEFAULT_VOICE_SETTINGS.pitch).toBe(1);
    expect(ALLOWED_PITCHES).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    expect(normalizePitch(1.5)).toBe(1.5);
    expect(normalizePitch("0.5")).toBe(0.5);
    expect(normalizePitch(2)).toBe(2);
    expect(normalizePitch("fast")).toBe(1);
    expect(normalizePitch(3)).toBe(1);
    expect(normalizePitch(0.6)).toBe(1);
    expect(normalizePitch(null)).toBe(1);
    expect(normalizePitch(undefined)).toBe(1);
  });

  it("falls back to default pitch on invalid stored value", () => {
    stubStorage({ "readapaper:tts:pitch": "3", "readapaper:tts:rate": "1.25" });
    expect(loadVoiceSettings()).toEqual({ rate: 1.25, pitch: 1, voiceURI: "" });
    stubStorage({ "readapaper:tts:pitch": "1.25" });
    expect(loadVoiceSettings().pitch).toBe(1.25);
  });

  it("normalize helpers reject garbage", () => {
    expect(normalizeRate("fast")).toBe(1);
    expect(normalizeRate(2)).toBe(2);
    expect(normalizeRate(null)).toBe(1);
    expect(normalizeVoiceURI(42)).toBe("");
    expect(normalizeVoiceURI("v")).toBe("v");
  });

  it("never throws when storage writes fail (private mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("denied");
      },
    });
    expect(() => saveVoiceSettings({ rate: 1.25, pitch: 1.5, voiceURI: "x" })).not.toThrow();
    expect(loadVoiceSettings().rate).toBe(1);
  });
});
