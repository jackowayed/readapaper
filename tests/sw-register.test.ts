import { describe, expect, it, vi } from "vitest";
import {
  syncServiceWorker,
  type SwContainerLike,
  type SwRegistrationLike,
} from "../lib/sw-register";

function stubRegistration(): SwRegistrationLike & { calls: number } {
  return {
    calls: 0,
    unregister: async function (this: { calls: number }) {
      this.calls += 1;
      return true;
    },
  };
}

function stubContainer(regs: SwRegistrationLike[] = []): SwContainerLike & {
  registered: string[];
} {
  const c = {
    registered: [] as string[],
    register: async (url: string) => {
      c.registered.push(url);
      return undefined;
    },
    getRegistrations: async () => regs,
  };
  return c;
}

describe("syncServiceWorker", () => {
  it("reports unsupported without touching anything when SW is unavailable", async () => {
    expect(await syncServiceWorker(undefined, "production")).toBe("unsupported");
    expect(await syncServiceWorker(undefined, "development")).toBe("unsupported");
  });

  it("registers /sw.js in production and leaves existing registrations alone", async () => {
    const regs = [stubRegistration()];
    const c = stubContainer(regs);
    const getSpy = vi.spyOn(c, "getRegistrations");
    expect(await syncServiceWorker(c, "production")).toBe("registered");
    expect(c.registered).toEqual(["/sw.js"]);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("unregisters leftover workers outside production", async () => {
    for (const env of ["development", "test", undefined]) {
      const a = stubRegistration();
      const b = stubRegistration();
      const c = stubContainer([a, b]);
      const regSpy = vi.spyOn(c, "register");
      expect(await syncServiceWorker(c, env)).toBe("cleaned");
      expect(regSpy).not.toHaveBeenCalled();
      expect(a.calls).toBe(1);
      expect(b.calls).toBe(1);
    }
  });

  it("is a no-op clean when nothing is registered", async () => {
    const c = stubContainer([]);
    expect(await syncServiceWorker(c, "development")).toBe("cleaned");
    expect(c.registered).toEqual([]);
  });

  it("propagates registration failures for the call site to swallow", async () => {
    const c = stubContainer();
    c.register = async () => {
      throw new Error("denied");
    };
    await expect(syncServiceWorker(c, "production")).rejects.toThrow("denied");
  });
});
