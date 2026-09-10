import type { ReactNode } from "react";
import ThemeControl from "./ThemeControl";

export default function SiteHeader({
  brandLabel,
  brandHref = "/",
  showBookmarkletLink = true,
}: {
  brandLabel: ReactNode;
  brandHref?: string;
  showBookmarkletLink?: boolean;
}) {
  return (
    <header className="topbar">
      <a className="brand" href={brandHref}>
        {brandLabel}
      </a>
      <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
        {showBookmarkletLink && (
          <a className="muted" href="/bookmarklet">
            Bookmarklet
          </a>
        )}
        <ThemeControl />
      </div>
    </header>
  );
}
