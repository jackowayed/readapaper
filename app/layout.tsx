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
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <OfflineSupport />
          {children}
        </div>
      </body>
    </html>
  );
}
