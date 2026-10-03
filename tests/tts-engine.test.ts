import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TTS_ENGINE,
  loadTtsEngine,
  normalizeEngine,
  OFFLINE_BASE_WPM,
  rateToWpm,
  saveTtsEngine,
  TTS_ENGINE_KEY,
} from "../lib/tts-engine";

/** Map-backed localStorage stub (node env has neither window nor storage). */
function stubStorage() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
  vi.stubGlobal("localStorage", stub);
  return store;
}

describe("normalizeEngine", () => {
  it("accepts only 'offline', everything else is 'system'", () => {
    expect(normalizeEngine("offline")).toBe("offline");
    expect(normalizeEngine("system")).toBe("system");
    expect(normalizeEngine("")).toBe("system");
    expect(normalizeEngine(null)).toBe("system");
    expect(normalizeEngine(undefined)).toBe("system");
    expect(normalizeEngine(42)).toBe("system");
  });
});

describe("load/save engine", () => {
  beforeEach(() => {
    stubStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to system with empty storage", () => {
    expect(loadTtsEngine()).toBe(DEFAULT_TTS_ENGINE);
    expect(DEFAULT_TTS_ENGINE).toBe("system");
  });

  it("round-trips the offline engine", () => {
    saveTtsEngine("offline");
    expect(localStorage.getItem(TTS_ENGINE_KEY)).toBe("offline");
    expect(loadTtsEngine()).toBe("offline");
  });

  it("falls back to system on unknown stored values", () => {
    localStorage.setItem(TTS_ENGINE_KEY, "neural");
    expect(loadTtsEngine()).toBe("system");
  });

  it("never throws when storage is unavailable", () => {
    vi.unstubAllGlobals();
    expect(loadTtsEngine()).toBe("system");
    expect(() => saveTtsEngine("offline")).not.toThrow();
  });
});

describe("rateToWpm", () => {
  it("scales the 1x base rate", () => {
    expect(rateToWpm(1)).toBe(OFFLINE_BASE_WPM);
    expect(rateToWpm(2)).toBe(OFFLINE_BASE_WPM * 2);
    expect(rateToWpm(0.75)).toBe(Math.round(OFFLINE_BASE_WPM * 0.75));
  });

  it("clamps into the sane eSpeak band", () => {
    expect(rateToWpm(0)).toBeGreaterThanOrEqual(80);
    expect(rateToWpm(100)).toBeLessThanOrEqual(450);
    expect(rateToWpm(Number.NaN)).toBe(OFFLINE_BASE_WPM);
  });
});
