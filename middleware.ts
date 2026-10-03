import { NextResponse } from "next/server";
import { SW_DEV_STUB_JS, shouldServeDevStub } from "@/lib/sw-dev-stub";

// Only ever intercepts the worker script itself; every other route is
// untouched (and production passes /sw.js through to the real worker).
export const config = { matcher: ["/sw.js"] };

export function middleware() {
  if (!shouldServeDevStub(process.env.NODE_ENV)) return NextResponse.next();
  return new Response(SW_DEV_STUB_JS, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store",
    },
  });
}
