/**
 * Development service-worker stub.
 *
 * `next dev` and `next start` share the default origin (localhost:3000), so a
 * production worker (precached prod assets, runtime-cached `/_next/static/*`)
 * would otherwise keep controlling dev pages and serve mixed-vintage chunks.
 * Outside production, `middleware.ts` serves this stub at `/sw.js` instead:
 * it takes over immediately (`skipWaiting` + `clientsClaim`, evicting any
 * stale production worker) and then handles nothing — with no `fetch`
 * handler every request passes straight through to the network, so dev pages
 * can never be served stale assets. Production is untouched (the real
 * Serwist worker is served there).
 */

export const SW_DEV_STUB_JS = `/* Readapaper dev stub: intentionally empty so no worker ever caches dev responses. See lib/sw-dev-stub.ts. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
`;

/** Serve the stub for every non-production environment (dev, test, CI). */
export function shouldServeDevStub(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
