import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMediaSession, setupMediaSession } from "../lib/media-session";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media session helper", () => {
  it("no-ops (false) without the Media Session API", () => {
    expect(setupMediaSession("Title", { onPlay: () => {}, onPause: () => {} })).toBe(false);
    expect(() => clearMediaSession()).not.toThrow();
  });

  it("sets metadata + play/pause/stop handlers", () => {
    const handlers = new Map<string, (() => void) | null>();
    const setActionHandler = vi.fn((a: string, h: (() => void) | null) => {
      handlers.set(a, h);
    });
    const session = { metadata: undefined as unknown, setActionHandler };
    vi.stubGlobal("navigator", { mediaSession: session });
    vi.stubGlobal(
      "MediaMetadata",
      class {
        title: string;
        constructor(m: { title: string }) {
          this.title = m.title;
        }
      }
    );

    const onPlay = vi.fn();
    const onPause = vi.fn();
    const onStop = vi.fn();
    expect(setupMediaSession("My Article", { onPlay, onPause, onStop })).toBe(true);
    expect((session.metadata as { title: string }).title).toBe("My Article");
    handlers.get("play")?.();
    handlers.get("pause")?.();
    handlers.get("stop")?.();
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);

    clearMediaSession();
    expect(setActionHandler).toHaveBeenCalledWith("play", null);
  });
});
