import { spawnSync } from "node:child_process";
import withSerwistInit from "@serwist/next";

// Revision for the precached /offline fallback page.
const revision =
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim() ||
  crypto.randomUUID();

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  additionalPrecacheEntries: [{ url: "/offline", revision }],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: false },
  serverExternalPackages: ["jsdom", "@mozilla/readability", "isomorphic-dompurify"],
};

export default withSerwist(nextConfig);
