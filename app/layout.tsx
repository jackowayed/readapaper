import type { Metadata, Viewport } from "next";
import "./globals.css";
import OfflineSupport from "@/components/OfflineSupport";

export const metadata: Metadata = {
  title: "Readapaper",
  description: "Save articles, read cleanly, listen in sync — now with offline reading.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Readapaper", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
      { url: "/icons/icon-512.svg", sizes: "512x512", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/icon-192.svg", sizes: "192x192", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#2563eb",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Never worker-control non-production origins: dev self-heal for browsers
  // holding a production worker from a previous `next start` on the same
  // origin (localhost:3000). Inline on purpose — it must run at HTML parse,
  // before hydration: a page crashing on mixed-vintage chunks never runs
  // React effects, so the OfflineSupport cleanup alone can't rescue it.
  const devUnregister =
    'if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister()})}).catch(function(){})}';
  return (
    <html lang="en">
      <body>
        {process.env.NODE_ENV !== "production" && <script>{devUnregister}</script>}
        <div className="shell">
          <OfflineSupport />
          {children}
        </div>
      </body>
    </html>
  );
}
