import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureMespeakLoaded,
  resetMespeakCache,
  synthesizeWavArray,
  type MeSpeakLike,
  type MespeakLoader,
} from "../lib/mespeak-tts";
import { parseWavDurationSec } from "../lib/wav";

/** 44-byte header + 4410 data bytes -> 0.1s at 44100 B/s. */
function cannedWav(dataSize = 4410): number[] {
  const h = new Array(44).fill(0);
  const tag = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  tag(8, "WAVE");
  const u32 = (off: number, v: number) => {
    h[off] = v & 0xff;
    h[off + 1] = (v >> 8) & 0xff;
    h[off + 2] = (v >> 16) & 0xff;
    h[off + 3] = (v >> 24) & 0xff;
  };
  u32(28, 44100);
  u32(40, dataSize);
  return h.concat(new Array(dataSize).fill(7));
}

function mockEngine(overrides?: Partial<MeSpeakLike>): MeSpeakLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    speak: () => cannedWav(),
    loadConfig: () => {
      calls.push("config");
    },
    loadVoice: () => {
      calls.push("voice");
    },
    isConfigLoaded: () => true,
    ...overrides,
  };
}

function loaderFor(engine: MeSpeakLike): MespeakLoader {
  return () => Promise.resolve({ mespeak: engine, config: {}, voice: {} });
}

beforeEach(() => {
  resetMespeakCache();
});

describe("ensureMespeakLoaded", () => {
  it("loads once and memoizes (concurrent-safe)", async () => {
    const engine = mockEngine();
    let loaderCalls = 0;
    const loader: MespeakLoader = () => {
      loaderCalls += 1;
      return loaderFor(engine)();
    };
    const [a, b] = await Promise.all([ensureMespeakLoaded(loader), ensureMespeakLoaded(loader)]);
    expect(a).toBe(engine);
    expect(b).toBe(engine);
    expect(loaderCalls).toBe(1);
    expect(engine.calls).toEqual(["voice"]);
  });

  it("loads config only when missing, then memoizes the engine", async () => {
    const engine = mockEngine({ isConfigLoaded: () => false });
    const first = await ensureMespeakLoaded(loaderFor(engine));
    const second = await ensureMespeakLoaded(loaderFor(engine));
    expect(first).toBe(second);
    expect(engine.calls).toEqual(["config", "voice"]);
  });

  it("retries after a failed load", async () => {
    const failing: MespeakLoader = () => Promise.reject(new Error("net down"));
    await expect(ensureMespeakLoaded(failing)).rejects.toThrow("net down");
    const engine = mockEngine();
    await expect(ensureMespeakLoaded(loaderFor(engine))).resolves.toBe(engine);
  });
});

describe("synthesizeWavArray", () => {
  it("returns wav bytes with a header-parsed duration", () => {
    const res = synthesizeWavArray(mockEngine(), "Hello world.", 175);
    expect(res).not.toBeNull();
    expect(res?.wav.length).toBeGreaterThan(44);
    expect(res?.durationSec).toBeCloseTo(0.1, 6);
  });

  it("accepts ArrayBuffer output and falls back to a text estimate", () => {
    const buf = new ArrayBuffer(100);
    new Uint8Array(buf).fill(1);
    const engine = mockEngine({ speak: () => buf });
    const res = synthesizeWavArray(engine, "one two three", 175);
    expect(res).not.toBeNull();
    expect(res?.durationSec).toBeGreaterThan(0);
  });

  it("returns null for blank text, short output, or throwing engines", () => {
    expect(synthesizeWavArray(mockEngine(), "   ", 175)).toBeNull();
    expect(synthesizeWavArray(mockEngine({ speak: () => [1, 2, 3] }), "hi", 175)).toBeNull();
    expect(
      synthesizeWavArray(
        mockEngine({
          speak: () => {
            throw new Error("boom");
          },
        }),
        "hi",
        175
      )
    ).toBeNull();
    expect(synthesizeWavArray(mockEngine({ speak: () => null }), "hi", 175)).toBeNull();
  });
});

describe("real mespeak bundle (integration)", () => {
  it("synthesizes speech to a valid WAV", async () => {
    const engineMod = await import("mespeak");
    const configMod = await import("mespeak/src/mespeak_config.json");
    const voiceMod = await import("mespeak/voices/en/en-us.json");
    const mespeak = ((engineMod as unknown as { default?: MeSpeakLike }).default ??
      engineMod) as unknown as MeSpeakLike;
    const config = (configMod as unknown as { default?: unknown }).default ?? configMod;
    const voice = (voiceMod as unknown as { default?: unknown }).default ?? voiceMod;
    const engine = await ensureMespeakLoaded(() => Promise.resolve({ mespeak, config, voice }));
    const res = synthesizeWavArray(engine, "Hello world.", 175);
    expect(res).not.toBeNull();
    expect(parseWavDurationSec(res?.wav ?? [])).not.toBeNull();
    expect(res?.durationSec).toBeGreaterThan(0.2);
  });
});
