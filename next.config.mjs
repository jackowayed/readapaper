import { spawnSync } from "node:child_process";
import withSerwistInit from "@serwist/next";

// Revision for the precached /offline fallback page.
const revision =
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim() ||
  crypto.randomUUID();

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // Dev never builds the worker: `next dev` would otherwise overwrite the
  // production `public/sw.js` with a dev-mode bundle (defaultCache becomes
  // NetworkOnly, killing runtime caching -> offline e2e + offline reads
  // break). The worker is prod-only (`next start`, e2e runs).
  disable: process.env.NODE_ENV !== "production",
  additionalPrecacheEntries: [{ url: "/offline", revision }],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Isolate `next dev` from prod builds: both default to `.next/` with no
  // locking, so a `next build` (e.g. for e2e) while dev is running corrupts
  // dev's incremental cache (dangling vendor-chunk refs -> 500s). `npm run
  // dev` sets NEXT_DIST_DIR=.next-dev; build/start/e2e keep `.next/`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  eslint: { ignoreDuringBuilds: false },
  serverExternalPackages: ["jsdom", "@mozilla/readability", "isomorphic-dompurify"],
};

export default withSerwist(nextConfig);
