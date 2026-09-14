"use client";
import { useEffect, useRef, useState } from "react";
import { buildBookmarklet } from "@/lib/bookmarklet";
import SiteHeader from "@/components/SiteHeader";

export default function BookmarkletPage() {
  const [base, setBase] = useState("");
  const [copied, setCopied] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [manualHtml, setManualHtml] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMsg, setManualMsg] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);

  const href = base ? buildBookmarklet(base) : "";

  useEffect(() => {
    setBase(window.location.origin);
  }, []);

  useEffect(() => {
    // React 19 sanitizes `javascript:` hrefs into a throwing URL, which
    // breaks drag-to-bookmark install. Set the real URL imperatively.
    if (href && linkRef.current) {
      linkRef.current.setAttribute("href", href);
    }
  }, [href]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be blocked; user can copy manually from the textarea
    }
  }

  async function manualSave(e: React.FormEvent) {
    e.preventDefault();
    setManualMsg(null);
    setManualLink(null);
    if (!manualUrl.trim() || !manualHtml.trim()) {
      setManualMsg("Paste both the article URL and the page HTML.");
      return;
    }
    setManualBusy(true);
    try {
      const res = await fetch("/api/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: manualUrl.trim(), html: manualHtml }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      setManualMsg(res.status === 200 ? "Already in Readapaper." : "Saved to Readapaper.");
      if (data.id) setManualLink(`/a/${data.id}`);
      setManualHtml("");
    } catch (err) {
      setManualMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setManualBusy(false);
    }
  }

  return (
    <>
      <SiteHeader brandLabel="📚 Readapaper" showBookmarkletLink={false} />
      <main className="narrow">
        <h1>Save bookmarklet</h1>
        <p className="muted">
          For paywalled, login-gated, or bot-blocked pages, the server fetch can&apos;t see the
          article. The bookmarklet runs <strong>inside the page</strong>, grabs the live DOM (with
          your cookies, rendered JS, and unlocked text), and posts it to <code>/api/articles</code>{" "}
          where it goes through the normal Readability + sanitize pipeline.
        </p>

        <h2>1. Install</h2>
        <p>Drag this button to your bookmarks bar:</p>
        <p>
          {href ? (
            <a
              ref={linkRef}
              href="#"
              onClick={(e) => e.preventDefault()}
              title="Drag me to your bookmarks bar"
              style={{
                display: "inline-block",
                padding: "0.6rem 1rem",
                background: "var(--accent)",
                color: "#fff",
                borderRadius: 8,
                textDecoration: "none",
                fontFamily: "system-ui, sans-serif",
                cursor: "grab",
              }}
            >
              📚 Save to Readapaper
            </a>
          ) : (
            <span className="muted">Loading…</span>
          )}
        </p>
        <p className="muted">
          It&apos;s locked to this instance (<code>{base || "…"}</code>). If you self-host
          elsewhere, reinstall from that server&apos;s <code>/bookmarklet</code> page.
        </p>

        <h2>2. Use</h2>
        <ol className="muted">
          <li>Open the article (logged in, paywall unlocked, full text visible).</li>
          <li>Click the bookmark. A toast says “Saving…” then “Saved” with an Open link.</li>
          <li>If it fails, you&apos;ll see the server error (e.g. extraction 422).</li>
        </ol>

        <h2>3. Manual copy</h2>
        <p className="muted">Bookmarks bar hidden? Copy the URL into a new bookmark:</p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <textarea
            readOnly
            rows={4}
            value={href}
            placeholder="Bookmarklet code…"
            style={{ flex: 1, fontSize: "0.75rem", fontFamily: "monospace" }}
            onFocus={(e) => e.target.select()}
          />
          <button type="button" onClick={copy} disabled={!href}>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>

        <h2 id="manual">4. Site blocked the save? Manual save</h2>
        <p className="muted">
          Some sites (e.g. sfstandard.com) send a strict{" "}
          <code>Content-Security-Policy: connect-src</code> that blocks the bookmarklet&apos;s{" "}
          <code>fetch(BASE + &apos;/api/articles&apos;)</code> — you&apos;ll see a console error
          like “Connecting to &apos;http://localhost:3000/api/articles&apos; violates …
          connect-src”. The page&apos;s CSP wins over CORS: even with{" "}
          <code>Access-Control-Allow-Origin: *</code> the browser never sends the request. Two extra
          traps on https article pages: an <code>http://</code> Readapaper base is mixed-content
          (plus <code>upgrade-insecure-requests</code> / <code>block-all-mixed-content</code>), and
          a bare <code>localhost:3000</code> CSP entry only covers the page&apos;s own scheme
          (https), not http. Fix: serve Readapaper over <strong>https</strong> (tunnel/deploy) and
          reinstall the bookmarklet from that origin — sfstandard&apos;s <code>connect-src</code>{" "}
          allows any <code>https:</code> host. When the direct save is blocked, the bookmarklet now
          copies the page HTML to your clipboard automatically — paste it below.
        </p>
        <form onSubmit={manualSave}>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            <input
              type="url"
              required
              placeholder="Article URL…"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              aria-label="Article URL for manual save"
            />
            <textarea
              rows={6}
              required
              placeholder="Paste page HTML here (bookmarklet copies it on CSP block)…"
              value={manualHtml}
              onChange={(e) => setManualHtml(e.target.value)}
              aria-label="Page HTML for manual save"
              style={{ fontSize: "0.75rem", fontFamily: "monospace" }}
            />
            <div>
              <button className="primary" type="submit" disabled={manualBusy}>
                {manualBusy ? "Saving…" : "Save pasted HTML"}
              </button>
            </div>
          </div>
        </form>
        {manualMsg && (
          <p className="muted" role="status">
            {manualMsg} {manualLink && <a href={manualLink}>Open in Readapaper &rarr;</a>}
          </p>
        )}

        <h2>Why it beats scraping protection</h2>
        <ul className="muted">
          <li>
            <strong>No server fetch:</strong> bot/WAF rules see a normal browser, not a scraper IP +
            headless UA.
          </li>
          <li>
            <strong>Cookies + sessions:</strong> subscriber logins and soft-paywall unlocks travel
            with the DOM automatically.
          </li>
          <li>
            <strong>Rendered content:</strong> SPA / lazy-load / infinite-scroll text is already in
            the DOM; server HTML-only fetch would miss it.
          </li>
          <li>
            <strong>Same pipeline:</strong> posted HTML is Readability-extracted and DOMPurify
            sanitized server-side, so reader/word-count/TTS behave identically.
          </li>
        </ul>
        <p className="muted">
          Note: hard paywalls that never render text in the DOM can&apos;t be saved — the
          bookmarklet can only send what your browser actually displays.
        </p>
      </main>
    </>
  );
}
