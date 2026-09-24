import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Listen reliability Phases 1+2 (docs/listen-reliability.md §2+§4): listen
// failures are audible (status/error UI + retry), and the happy path is
// proven with a mocked speechSynthesis — never real audio.
//
// The mock is installed via addInitScript (no new devDeps): it records
// speak()/cancel() and fires scripted onboundary word events + onend per
// utterance, with pause() stalling the script and resume() continuing it.
// Tests assert: Listen click → status Playing → word highlight advances →
// pause/resume round-trips status → position persists on reload (silent
// restore, no autoplay). A second test forces onerror → error state with
// the message, position kept, Retry resumes.
//
// Serial (workers: 1), unique URLs per run, a handful of requests per test
// (well under the 30 req/min/IP limiter).

const DATA_FILE = path.join(process.cwd(), "data", "articles.json");

let backup: { exists: boolean; content: string | null } = { exists: false, content: null };
const createdIds: string[] = [];

// Mocked Web Speech: deterministic, no audio. Installed before page scripts
// so `"speechSynthesis" in window` is true at hydration.
const SPEECH_MOCK = `(() => {
  const st = (window.__mockSpeech = window.__mockSpeech || {
    speaks: 0,
    cancels: 0,
    errorNext: null,
    spoken: [],
    rates: [],
    pitches: [],
  });
  let gen = 0;
  const synth = {
    __isMock: true,
    _paused: false,
    _speaking: false,
    get paused() { return this._paused; },
    get speaking() { return this._speaking; },
    getVoices() { return []; },
    addEventListener() {},
    removeEventListener() {},
    cancel() { gen += 1; st.cancels += 1; this._speaking = false; this._paused = false; },
    pause() { this._paused = true; },
    resume() { this._paused = false; },
    speak(u) {
      const myGen = gen;
      st.speaks += 1;
      try { st.spoken.push(u.text); } catch {}
      try { st.rates.push(u.rate ?? 1); } catch {}
      try { st.pitches.push(u.pitch ?? 1); } catch {}
      this._speaking = true;
      this._paused = false;
      const err = st.errorNext;
      st.errorNext = null;
      const step = (fn, ms) => setTimeout(() => { if (myGen !== gen) return; fn(); }, ms);
      if (err) {
        step(() => {
          this._speaking = false;
          try { if (u.onerror) u.onerror({ error: err }); } catch {}
          step(() => { try { if (u.onend) u.onend(); } catch {} }, 5);
        }, 20);
        return;
      }
      const text = (u && u.text) || "";
      const idxs = [];
      const re = /\\S+/g;
      let m;
      while ((m = re.exec(text)) !== null) idxs.push(m.index);
      if (!idxs.length) idxs.push(0);
      let i = 0;
      const fireNext = () => {
        if (myGen !== gen) return;
        if (this._paused) { step(fireNext, 10); return; }
        if (i < idxs.length) {
          const ci = idxs[i++];
          try { if (u.onboundary) u.onboundary({ charIndex: ci, name: "word" }); } catch {}
          step(fireNext, 25);
        } else {
          this._speaking = false;
          try { if (u.onend) u.onend(); } catch {}
        }
      };
      step(fireNext, 20);
    },
  };
  window.speechSynthesis = synth;
  try {
    // Headless Chromium ships a native speechSynthesis getter on window
    // (direct assignment silently fails) — redefine it so the mock wins.
    Object.defineProperty(window, "speechSynthesis", {
      value: synth,
      configurable: true,
      writable: true,
    });
  } catch {}
  const MockUtterance = class {
    constructor(text) {
      this.text = text;
      this.rate = 1;
      this.pitch = 1;
      this.voice = null;
      this.onboundary = null;
      this.onend = null;
      this.onerror = null;
    }
  };
  try {
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: MockUtterance,
      configurable: true,
      writable: true,
    });
  } catch {}
  window.SpeechSynthesisUtterance = MockUtterance;
})();`;

function nonce(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
}

// Many short sentences so the mock queue keeps advancing for seconds.
function listenHtml(title: string): string {
  const sentences = Array.from(
    { length: 60 },
    (_, i) => `Sentence number ${i + 1} carries the story forward with steady words.`
  ).join(" ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${title}</title></head><body><article><h1>${title}</h1><p>${sentences}</p><p>${sentences}</p></article></body></html>`;
}

async function createArticle(
  request: import("@playwright/test").APIRequestContext,
  tag: string
): Promise<{ id: string; title: string; textLength: number }> {
  const title = `Listen ${nonce(tag)}`;
  const post = await request.post("/api/articles", {
    data: { url: `https://example.com/${nonce(tag)}`, html: listenHtml(title) },
  });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string };
  createdIds.push(saved.id);
  const get = await request.get(`/api/articles/${saved.id}`);
  expect(get.status()).toBe(200);
  const body = (await get.json()) as { text: string };
  return { id: saved.id, title, textLength: body.text.length };
}

async function serverOffset(
  request: import("@playwright/test").APIRequestContext,
  id: string
): Promise<number> {
  const res = await request.get(`/api/articles/${id}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { progressOffset: number }).progressOffset;
}

test.beforeAll(async () => {
  try {
    backup = { exists: true, content: await fs.readFile(DATA_FILE, "utf8") };
  } catch {
    backup = { exists: false, content: null };
  }
});

test.afterAll(async () => {
  if (backup.exists && backup.content !== null) {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, backup.content, "utf8");
  } else {
    await fs.rm(DATA_FILE, { force: true });
  }
});

test.afterEach(async ({ request }) => {
  while (createdIds.length > 0) {
    const id = createdIds.pop();
    if (id !== undefined) await request.delete(`/api/articles/${id}`);
  }
});

test("Listen advances highlight, pause/resume works, position persists on reload", async ({
  page,
  request,
}) => {
  const { id, title, textLength } = await createArticle(request, "happy");
  await page.addInitScript(SPEECH_MOCK);
  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  // Guard: headless Chromium ships a native speechSynthesis getter — the
  // mock must have won (else no scripted boundaries would fire).
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { speechSynthesis?: { __isMock?: boolean } }).speechSynthesis
          ?.__isMock
    )
  ).toBe(true);

  await page.getByRole("button", { name: "🎧 Listen in sync" }).click();
  const status = page.getByTestId("listen-status");
  await expect(status).toContainText("Idle");

  // No autoplay: highlight rests at the silent-restore offset until play.
  await expect(page.getByRole("button", { name: "▶ Listen" })).toBeVisible();

  await page.getByRole("button", { name: "▶ Listen" }).click();
  await expect(status).toContainText("Playing", { timeout: 10_000 });

  // Word highlight advances as the mock fires scripted onboundary events.
  const active = page.locator(".listen-text .w.active");
  await expect(active.first()).toBeVisible({ timeout: 10_000 });
  const firstId = await active.first().getAttribute("id");
  await expect
    .poll(async () => active.first().getAttribute("id"), { timeout: 15_000 })
    .not.toBe(firstId);

  // Pause flushes the playhead (throttled persist would otherwise lag ~2s).
  await page.getByRole("button", { name: "⏸ Pause" }).click();
  await expect(status).toContainText("Paused", { timeout: 10_000 });
  await expect.poll(async () => serverOffset(request, id), { timeout: 15_000 }).toBeGreaterThan(0);
  const saved = await serverOffset(request, id);
  expect(saved).toBeGreaterThan(0);
  expect(saved).toBeLessThanOrEqual(textLength);

  // Resume continues from the kept position.
  await page.getByRole("button", { name: "▶ Resume" }).click();
  await expect(status).toContainText("Playing", { timeout: 10_000 });

  // Reload: silent restore highlights the saved word with no autoplay.
  await page.reload();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "🎧 Listen in sync" }).click();
  const restored = page.locator(".listen-text .w.active");
  await expect(restored.first()).toBeVisible({ timeout: 10_000 });
  const wordStart = Number((await restored.first().getAttribute("id"))?.replace("w-", ""));
  expect(wordStart).toBeLessThanOrEqual(saved);
  expect(saved - wordStart).toBeLessThan(500);
  await expect(page.getByTestId("listen-status")).toContainText("Idle");
  await expect(page.getByRole("button", { name: "▶ Listen" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Pause/ })).toHaveCount(0);
});

test("Voice settings persist per browser, apply immediately, no Stop button", async ({
  page,
  request,
}) => {
  const { id, title } = await createArticle(request, "voicesettings");
  // Mock with two fake voices so the Voice select has options.
  const mockWithVoices = SPEECH_MOCK.replace(
    "getVoices() { return []; },",
    `getVoices() { return [{ voiceURI: "mock-voice-1", name: "Mock Voice One", lang: "en-US" }, { voiceURI: "mock-voice-2", name: "Mock Voice Two", lang: "en-GB" }]; },`
  );
  await page.addInitScript(mockWithVoices);
  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "🎧 Listen in sync" }).click();

  // No separate Stop control: single Play/Pause toggle only.
  await expect(page.getByRole("button", { name: /Stop/ })).toHaveCount(0);

  const rateSelect = page.getByLabel("Speech rate");
  // Exact match: the Archive button's aria-label ("Archive <title>") also
  // contains the word "Voice" (e.g. the "voicesettings" test title).
  const voiceSelect = page.getByLabel("Voice", { exact: true });
  const pitchSelect = page.getByLabel("Speech pitch");

  // Honest iOS limitation note is always visible under the voice controls.
  await expect(page.getByText(/only listed voices can play/)).toBeVisible();

  // Persist rate + pitch + voice (localStorage = per-browser, works offline).
  await rateSelect.selectOption("1.5");
  await pitchSelect.selectOption("1.5");
  await voiceSelect.selectOption("mock-voice-2");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("readapaper:tts:rate")))
    .toBe("1.5");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("readapaper:tts:pitch")))
    .toBe("1.5");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("readapaper:tts:voiceURI")))
    .toBe("mock-voice-2");

  // Start playback, then change rate mid-play: restarts from the playhead
  // (extra cancel) and stays Playing with the new setting applied.
  await page.getByRole("button", { name: "▶ Listen" }).click();
  const status = page.getByTestId("listen-status");
  await expect(status).toContainText("Playing", { timeout: 10_000 });
  const cancelsBefore = await page.evaluate(
    () => (window as unknown as { __mockSpeech: { cancels: number } }).__mockSpeech.cancels
  );
  await rateSelect.selectOption("1.25");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __mockSpeech: { cancels: number } }).__mockSpeech.cancels
        ),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(cancelsBefore);
  await expect(status).toContainText("Playing", { timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("readapaper:tts:rate")))
    .toBe("1.25");

  // Pause keeps the highlight (no destructive stop-reset); reload restores
  // the saved settings silently with no autoplay and still no Stop.
  await page.getByRole("button", { name: "⏸ Pause" }).click();
  await expect(status).toContainText("Paused", { timeout: 10_000 });
  await expect(page.locator(".listen-text .w.active").first()).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "🎧 Listen in sync" }).click();
  await expect(rateSelect).toHaveValue("1.25");
  await expect(pitchSelect).toHaveValue("1.5");
  await expect(voiceSelect).toHaveValue("mock-voice-2");
  await expect(page.getByTestId("listen-status")).toContainText("Idle");
  await expect(page.getByRole("button", { name: "▶ Listen" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toHaveCount(0);
});

test("Pitch change restarts playback, preview leaves playhead alone", async ({ page, request }) => {
  const { id, title } = await createArticle(request, "voicecustom");
  const mockWithVoices = SPEECH_MOCK.replace(
    "getVoices() { return []; },",
    `getVoices() { return [{ voiceURI: "mock-voice-1", name: "Mock Voice One", lang: "en-US" }, { voiceURI: "mock-voice-2", name: "Mock Voice Two", lang: "en-GB" }]; },`
  );
  await page.addInitScript(mockWithVoices);
  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "🎧 Listen in sync" }).click();

  const pitchSelect = page.getByLabel("Speech pitch");
  const previewBtn = page.getByRole("button", { name: "Preview voice" });
  const status = page.getByTestId("listen-status");
  await expect(status).toContainText("Idle");
  await expect(previewBtn).toBeEnabled();
  await expect(page.getByText(/only listed voices can play/)).toBeVisible();

  // Set a non-default pitch while idle — persists per browser.
  await pitchSelect.selectOption("1.5");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("readapaper:tts:pitch")))
    .toBe("1.5");

  // Preview while idle: one extra speak, no cancel (no restart), playhead
  // untouched, status stays Idle, sample text uses the current pitch.
  const active = page.locator(".listen-text .w.active");
  await expect(active.first()).toBeVisible({ timeout: 10_000 });
  const idleActiveId = await active.first().getAttribute("id");
  const idleStats = await page.evaluate(() => {
    const s = (window as unknown as { __mockSpeech: { speaks: number; cancels: number } })
      .__mockSpeech;
    return { speaks: s.speaks, cancels: s.cancels };
  });
  await previewBtn.click();
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __mockSpeech: { speaks: number } }).__mockSpeech.speaks
        ),
      { timeout: 10_000 }
    )
    .toBe(idleStats.speaks + 1);
  // No cancel → article queue was not restarted.
  expect(
    await page.evaluate(
      () => (window as unknown as { __mockSpeech: { cancels: number } }).__mockSpeech.cancels
    )
  ).toBe(idleStats.cancels);
  await expect(status).toContainText("Idle");
  expect(await active.first().getAttribute("id")).toBe(idleActiveId);
  const previewSample = await page.evaluate(() => {
    const s = (window as unknown as { __mockSpeech: { spoken: string[]; pitches: number[] } })
      .__mockSpeech;
    return { text: s.spoken[s.spoken.length - 1], pitch: s.pitches[s.pitches.length - 1] };
  });
  expect(previewSample.text).toBe("Hello from Readapaper");
  expect(previewSample.pitch).toBe(1.5);
  // Preview never persists position.
  expect(await serverOffset(request, id)).toBe(0);

  // Start playback — preview is disabled while playing so the article
  // utterance is never interrupted.
  await page.getByRole("button", { name: "▶ Listen" }).click();
  await expect(status).toContainText("Playing", { timeout: 10_000 });
  await expect(previewBtn).toBeDisabled();

  // Pitch change mid-play restarts from the playhead (extra cancel) with
  // the new pitch applied to subsequent utterances.
  const cancelsBefore = await page.evaluate(
    () => (window as unknown as { __mockSpeech: { cancels: number } }).__mockSpeech.cancels
  );
  await pitchSelect.selectOption("0.5");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __mockSpeech: { cancels: number } }).__mockSpeech.cancels
        ),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(cancelsBefore);
  await expect(status).toContainText("Playing", { timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("readapaper:tts:pitch")))
    .toBe("0.5");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const s = (window as unknown as { __mockSpeech: { pitches: number[] } }).__mockSpeech;
        return s.pitches[s.pitches.length - 1];
      })
    )
    .toBe(0.5);

  await page.getByRole("button", { name: "⏸ Pause" }).click();
  await expect(status).toContainText("Paused", { timeout: 10_000 });
});

test("Speech error surfaces with retry and keeps position", async ({ page, request }) => {
  const { id, title } = await createArticle(request, "error");
  await page.addInitScript(SPEECH_MOCK);
  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { speechSynthesis?: { __isMock?: boolean } }).speechSynthesis
          ?.__isMock
    )
  ).toBe(true);
  await page.getByRole("button", { name: "🎧 Listen in sync" }).click();

  // Force the next utterance to fail with a scripted error code.
  await page.evaluate(() => {
    (window as unknown as { __mockSpeech: { errorNext: string } }).__mockSpeech.errorNext =
      "synthesis-failed";
  });
  await page.getByRole("button", { name: "▶ Listen" }).click();

  const status = page.getByTestId("listen-status");
  await expect(status).toContainText("Error", { timeout: 10_000 });
  await expect(status).toContainText("synthesis-failed", { timeout: 10_000 });
  // Position is kept for retry: a word stays highlighted.
  await expect(page.locator(".listen-text .w.active").first()).toBeVisible({ timeout: 10_000 });

  // Retry from the kept position resumes playback.
  await page.getByRole("button", { name: "↻ Retry" }).click();
  await expect(status).toContainText("Playing", { timeout: 10_000 });
});
