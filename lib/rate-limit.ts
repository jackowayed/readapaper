// Minimal in-memory sliding-window rate limiter (v0, single instance).
//
// Each key maps to the timestamps (ms) of recent hits inside the current
// window. A request is allowed when fewer than `limit` hits fall inside
// (now - windowMs, now]; otherwise it is rejected with a `retryAfterSec`
// derived from the oldest hit in the window.
//
// Module scope is intentional: route modules import this module, so
// `vi.resetModules` re-imports (see tests/store.test.ts pattern) get a
// fresh bucket, and unit tests can call `resetRateLimits()` directly.

const hits = new Map<string, number[]>();

/** Production policy: 30 requests per minute per IP, per route (routes namespace their keys). */
export const DEFAULT_RATE_LIMIT = 30;
export const DEFAULT_RATE_WINDOW_MS = 60_000;

/** Per-key limit/window overrides. Only used by tests for small-limit injection. */
const overrides = new Map<string, { limit: number; windowMs: number }>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterSec: number } {
  const override = overrides.get(key);
  if (override) {
    limit = override.limit;
    windowMs = override.windowMs;
  }
  const now = Date.now();
  const cutoff = now - windowMs;
  const prev = hits.get(key) ?? [];
  const recent = prev.filter((t) => t > cutoff);
  if (recent.length < limit) {
    recent.push(now);
    hits.set(key, recent);
    return { ok: true, retryAfterSec: 0 };
  }
  hits.set(key, recent);
  const oldest = recent[0] ?? now;
  return {
    ok: false,
    retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
  };
}

/** Clear all buckets. Test hook — production code never calls this. */
export function resetRateLimits(): void {
  hits.clear();
}

/**
 * Test hook: force a small limit/window for one bucket key (e.g.
 * `setRateLimitOverride("articles:1.2.3.4", 2, 60_000)`), so route-level
 * tests can prove 429s without issuing 30+ requests. Production code
 * never calls this.
 */
export function setRateLimitOverride(key: string, limit: number, windowMs: number): void {
  overrides.set(key, { limit, windowMs });
}

/** Test hook: drop all overrides set via `setRateLimitOverride`. */
export function clearRateLimitOverrides(): void {
  overrides.clear();
}

/** Client IP for rate-limit keys: x-forwarded-for first entry, else x-real-ip, else "local". */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "local";
}
