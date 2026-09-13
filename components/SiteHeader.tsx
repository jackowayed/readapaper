"use client";
import { useEffect, useRef, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <header className="topbar">
      <a className="brand" href={brandHref}>
        {brandLabel}
      </a>
      <div ref={wrapRef} className="menu-wrap">
        <button
          type="button"
          className="menu-button"
          aria-label="Menu"
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls="site-menu"
          onClick={() => setOpen((v) => !v)}
        >
          ☰
        </button>
        {open && (
          <div id="site-menu" className="menu-dropdown" role="menu">
            {showBookmarkletLink && (
              <a className="muted menu-link" href="/bookmarklet" role="menuitem">
                Bookmarklet
              </a>
            )}
            <div className="menu-section">
              <div className="menu-label">Theme</div>
              <ThemeControl />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
