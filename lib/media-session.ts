/**
 * Media Session helper — lock-screen / background controls for listening mode.
 * No-op where the Media Session API is unavailable (desktop Safari, etc.).
 */

export type MediaSessionHandlers = {
  onPlay: () => void;
  onPause: () => void;
  onStop?: () => void;
};

type MaybeMediaSession = {
  metadata?: unknown;
  setActionHandler?: (action: string, handler: (() => void) | null) => void;
} | null;

function getSession(): MaybeMediaSession {
  try {
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      return navigator.mediaSession as unknown as MaybeMediaSession;
    }
  } catch {
    // ignore
  }
  return null;
}

export function setupMediaSession(title: string, handlers: MediaSessionHandlers): boolean {
  const session = getSession();
  if (!session) return false;
  try {
    const Ctor = (globalThis as unknown as { MediaMetadata?: new (m: object) => unknown })
      .MediaMetadata;
    if (Ctor) {
      session.metadata = new Ctor({
        title,
        artist: "Readapaper",
        album: "Readapaper listening",
      });
    }
    session.setActionHandler?.("play", handlers.onPlay);
    session.setActionHandler?.("pause", handlers.onPause);
    if (handlers.onStop) session.setActionHandler?.("stop", handlers.onStop);
    return true;
  } catch {
    return false;
  }
}

export function clearMediaSession(): void {
  const session = getSession();
  if (!session) return;
  try {
    session.metadata = undefined;
    session.setActionHandler?.("play", null);
    session.setActionHandler?.("pause", null);
    session.setActionHandler?.("stop", null);
  } catch {
    // ignore
  }
}
