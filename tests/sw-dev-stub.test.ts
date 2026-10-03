import { describe, expect, it } from "vitest";
import { SW_DEV_STUB_JS, shouldServeDevStub } from "../lib/sw-dev-stub";

describe("dev service-worker stub", () => {
  it("serves the stub in every non-production environment", () => {
    expect(shouldServeDevStub("development")).toBe(true);
    expect(shouldServeDevStub("test")).toBe(true);
    expect(shouldServeDevStub(undefined)).toBe(true);
  });

  it("passes through to the real worker in production", () => {
    expect(shouldServeDevStub("production")).toBe(false);
  });

  it("takes over immediately so a stale prod worker is evicted", () => {
    expect(SW_DEV_STUB_JS).toContain("skipWaiting");
    expect(SW_DEV_STUB_JS).toContain("clients.claim");
  });

  it("never caches anything (passthrough by design)", () => {
    // Tripwire: if anyone adds caching to this stub, dev pages can go stale
    // again — that logic belongs in app/sw.ts (production only). Assert on
    // API usage (not prose) so the header comment can't trip it.
    expect(SW_DEV_STUB_JS).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    for (const api of ["caches.open", ".put(", ".add(", ".addAll(", "precache"]) {
      expect(SW_DEV_STUB_JS).not.toContain(api);
    }
  });
});
