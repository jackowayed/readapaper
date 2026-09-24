/**
 * Offline flush wiring — the exact sender/resolver functions used by
 * `components/OfflineSupport.tsx` when replaying the pending-progress queue.
 *
 * Extracted here (instead of living inline in the component) so the wiring
 * stays unit-testable without a DOM: vitest runs in a node environment with
 * no testing-library harness. `OfflineSupport` imports these builders;
 * tests assert the request bodies without rendering the component.
 */

import type { OffsetProgressSender, TextLengthResolver } from "./offline-queue";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** `PUT /api/articles/:id/progress` with the canonical `{ offset }` body. */
export function buildOffsetSender(fetchFn: FetchFn = fetch): OffsetProgressSender {
  return (id, offset) =>
    fetchFn(`/api/articles/${id}/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset }),
    });
}

/**
 * Resolve `text.length` for legacy fraction-only entries via
 * `GET /api/articles/:id`. Best-effort: returns `undefined` on any failure
 * (non-ok, network error, missing/non-string text) so the flush falls back
 * to the legacy fraction path. Runs on reconnect (online), so a live fetch
 * is fine.
 */
export function buildTextLengthResolver(fetchFn: FetchFn = fetch): TextLengthResolver {
  return async (id) => {
    try {
      const res = await fetchFn(`/api/articles/${id}`);
      if (!res.ok) return undefined;
      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        typeof (data as { text?: unknown }).text === "string"
      ) {
        return (data as { text: string }).text.length;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
}
