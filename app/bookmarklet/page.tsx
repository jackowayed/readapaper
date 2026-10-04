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
  const [isAutosave, setIsAutosave] = useState(false);
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayMsg, setRelayMsg] = useState<string | null>(null);
  const [relayLink, setRelayLink] = useState<string | null>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const relayBusyRef = useRef(false);

  const href = base ? buildBookmarklet(base) : "";

  useEffect(() => {
    setBase(window.location.origin);
    setIsAutosave(window.location.hash.startsWith("#autosave"));
  }, []);

  useEffect(() => {
    // Relay receiver: the bookmarklet opens `/bookmarklet#autosave` in a new
    // tab and postMessages { type: 'readapaper-save', url, html }. The save
    // POST then runs same-origin from this tab, so the article page never
    // fetches the local network directly — no Local Network Access prompt,
    // no connect-src CSP block, no CORS/mixed-content. Accept from any
    // article origin: POST /api/articles is already CORS `*` with no auth,
    // so this adds no new capability.
    try {
      if (window.opener && window.location.hash.startsWith("#autosave")) {
        window.opener.postMessage({ type: "readapaper-ready" }, "*");
      }
    } catch {
      // opener may be cross-origin-restricted; the bookmarklet polls anyway.
    }
    async function onMessage(ev: MessageEvent) {
      const d = ev.data as { type?: unknown; url?: unknown; html?: unknown } | null;
      if (!d || typeof d !== "object" || d.type !== "readapaper-save") return;
      if (typeof d.url !== "string" || typeof d.html !== "string") return;
      if (!d.url.trim() || !d.html.trim()) return;
      if (relayBusyRef.current) return;
      const reply = (msg: object) => {
        try {
          (ev.source as Window | null)?.postMessage(msg, ev.origin || "*");
        } catch {
          // opener gone — still show the result in this tab.
        }
      };
      if (d.html.length > 10_000_000) {
        setRelayMsg("Page HTML too large (>10MB). Try reader mode first.");
        reply({ type: "readapaper-error", error: "Page HTML too large (>10MB)" });
        return;
      }
      relayBusyRef.current = true;
      setRelayBusy(true);
      setRelayMsg(`Saving ${d.url} …`);
      setRelayLink(null);
      setIsAutosave(true);
      try {
        const res = await fetch("/api/articles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: d.url, html: d.html }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
        setRelayMsg(res.status === 200 ? "Already in Readapaper." : "Saved to Readapaper.");
        if (data.id) setRelayLink(`/a/${data.id}`);
        reply({ type: "readapaper-saved", id: data.id, status: res.status });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Save failed";
        setRelayMsg(msg);
        reply({ type: "readapaper-error", error: msg });
      } finally {
        relayBusyRef.current = false;
        setRelayBusy(false);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
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
        {(isAutosave || relayMsg) && (
          <section
            aria-live="polite"
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
            }}
          >
            <strong>{relayBusy ? "Saving…" : "Bookmarklet save"}</strong>
            <p className="muted" role="status" style={{ margin: "0.5rem 0 0" }}>
              {relayMsg ?? "Waiting for the article tab to send its HTML…"}
              {relayLink && (
                <>
                  {" "}
                  <a href={relayLink}>Open in Readapaper &rarr;</a>
                </>
              )}
            </p>
          </section>
        )}
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
          <li>
            Click the bookmark. It opens Readapaper in a new tab and hands the page HTML over — no
            local-network permission prompt, even on sites that ask for one with the old direct-save
            path.
          </li>
          <li>If it fails, you&apos;ll see the server error (e.g. extraction 422).</li>
        </ol>
        <p className="muted">
          Why a new tab? Chrome 142+ shows a “let this site access your local network?” prompt
          whenever a <em>public article page</em> fetches your <em>local Readapaper</em> directly —
          once per article site. A Tailscale <code>https://…ts.net</code> URL doesn&apos;t avoid it:
          it still resolves to <code>100.64/10</code>, which browsers treat as local. Opening
          Readapaper first and saving <em>same-origin from this tab</em> sidesteps the prompt
          (top-level navigations aren&apos;t gated), plus <code>connect-src</code> CSP blocks, CORS,
          and mixed-content. If popups are blocked the bookmarklet falls back to the direct save
          (which may prompt) and then to clipboard + manual save below. Reinstall the bookmarklet
          from this page after updating so you get the new flow.
        </p>

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
          The relay above already bypasses the two common direct-save blocks: strict{" "}
          <code>Content-Security-Policy: connect-src</code> (e.g. sfstandard.com — the page&apos;s
          CSP wins over CORS, so the browser never sends the request) and mixed-content on https
          article pages with an <code>http://</code> Readapaper base. If the relay tab never arrives
          (popup blocker) and the direct fallback is also blocked, the bookmarklet copies the page
          HTML to your clipboard automatically — paste it below.
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
