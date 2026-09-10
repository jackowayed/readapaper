import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Readapaper",
  description: "Save articles, read cleanly, listen in sync.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
