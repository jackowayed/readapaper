/**
 * Production-only service-worker sync.
 *
 * The Serwist worker (`public/sw.js`, built from `app/sw.ts`) precaches
 * production-hashed assets and runtime-caches documents + `/_next/static/*`.
 * `next dev` and `next start` share the default origin (localhost:3000), so a
 * worker registered by a production run would otherwise keep controlling dev
 * pages and serve mixed-vintage chunks — surfacing as cryptic webpack errors
 * (e.g. `Cannot read properties of undefined (reading 'call')`) on soft
 * refreshes, while hard refreshes (which bypass the worker) look fine.
 *
 * The browser `ServiceWorkerContainer` is passed in — rather than read off
 * `navigator` — and `nodeEnv` is `process.env.NODE_ENV` at the call site, so
 * unit tests can stub both without a DOM.
 */

export type SwRegistrationLike = {
  unregister(): Promise<boolean>;
};

export type SwContainerLike = {
  register(url: string): Promise<unknown>;
  getRegistrations(): Promise<readonly SwRegistrationLike[]>;
};

export type SwSyncResult = "registered" | "cleaned" | "unsupported";

/**
 * Register `/sw.js` in production; in any other environment unregister
 * whatever workers a previous production run left behind on this origin so
 * dev pages are never worker-controlled. Rejects on registration/lookup
 * failure — call sites swallow it (offline PWA is progressive enhancement).
 */
export async function syncServiceWorker(
  container: SwContainerLike | undefined,
  nodeEnv: string | undefined
): Promise<SwSyncResult> {
  if (!container) return "unsupported";
  if (nodeEnv === "production") {
    await container.register("/sw.js");
    return "registered";
  }
  const regs = await container.getRegistrations();
  await Promise.all(regs.map((r) => r.unregister()));
  return "cleaned";
}
