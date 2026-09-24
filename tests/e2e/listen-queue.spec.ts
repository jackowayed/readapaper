import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Listen queue (queue → continuous TTS): two articles are enqueued from the
// library UI, reordered via move up/down, then played — the mocked
// speechSynthesis drains the first item's sentence queue, `onEnded` advances
// to the second title, and autoplay resumes without another tap. Remove +
// clear are asserted last.
//
// Mock + isolation follow tests/e2e/listen.spec.ts: addInitScript mock with
// scripted onboundary/onend per utterance, backup/restore of
// data/articles.json, unique URLs per run, serial workers (1), a handful of
// requests (well under the 30 req/min/IP limiter, no overrides needed).

const DATA_FILE = path.join(process.cwd(), "data", "articles.json");

let backup: { exists: boolean; content: string | null } = { exists: false, content: null };
const createdIds: string[] = [];

// Same deterministic no-audio mock as listen.spec.ts.
const SPEECH_MOCK = `(() => {
  const st = (window.__mockSpeech = window.__mockSpeech || {
    speaks: 0,
    cancels: 0,
    errorNext: null,
    spoken: [],
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

// Short but Readability-reliable body (~10 sentences): drains in seconds so
// the mock onend chain advances quickly. Each article carries a distinctive
// word (Alfa/Bravo) to assert which item was actually spoken.
function queueHtml(title: string, word: string): string {
  const sentences = Array.from(
    { length: 10 },
    (_, i) => `Queue tale ${word} sentence ${i + 1} carries the story forward steadily.`
  ).join(" ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${title}</title></head><body><article><h1>${title}</h1><p>${sentences}</p><p>${sentences}</p></article></body></html>`;
}

async function createArticle(
  request: import("@playwright/test").APIRequestContext,
  tag: string,
  word: string
): Promise<{ id: string; title: string }> {
  const title = `Queue ${nonce(tag)}`;
  const post = await request.post("/api/articles", {
    data: { url: `https://example.com/${nonce(tag)}`, html: queueHtml(title, word) },
  });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string };
  createdIds.push(saved.id);
  return { id: saved.id, title };
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

test("Listen queue: enqueue two, reorder, continuous playback advances + autoplays, remove/clear", async ({
  page,
  request,
}) => {
  const a = await createArticle(request, "qa", "Alfa");
  const b = await createArticle(request, "qb", "Bravo");

  await page.addInitScript(SPEECH_MOCK);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { speechSynthesis?: { __isMock?: boolean } }).speechSynthesis
          ?.__isMock
    )
  ).toBe(true);

  // Enqueue both articles from the library UI.
  await page.getByRole("button", { name: `Add to queue ${a.title}` }).click();
  await page.getByRole("button", { name: `Add to queue ${b.title}` }).click();
  const queueLink = page.getByRole("link", { name: "Listen queue, 2 articles" });
  await expect(queueLink).toBeVisible();
  await queueLink.click();
  await expect(page.getByRole("heading", { name: "▶ Listen queue" })).toBeVisible();

  const list = page.locator('ol[aria-label="Listen queue"]');
  await expect(list.locator("li").nth(0)).toContainText(a.title);
  await expect(list.locator("li").nth(1)).toContainText(b.title);
  // First item is current by default.
  await expect(list.locator('li[aria-current="true"]')).toContainText(a.title);

  // Reorder: B up (B, A), then back down (A, B). Current stays on A.
  await page.getByRole("button", { name: `Move up ${b.title}` }).click();
  await expect(list.locator("li").nth(0)).toContainText(b.title);
  await expect(list.locator("li").nth(1)).toContainText(a.title);
  await expect(list.locator('li[aria-current="true"]')).toContainText(a.title);
  await page.getByRole("button", { name: `Move down ${b.title}` }).click();
  await expect(list.locator("li").nth(0)).toContainText(a.title);
  await expect(list.locator("li").nth(1)).toContainText(b.title);

  // Play once: the mock drains A's sentences, onEnded advances to B and
  // autoplay resumes with no second tap.
  await expect(page.getByRole("heading", { name: a.title, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "▶ Listen" }).click();
  const status = page.getByTestId("listen-status");
  await expect(status).toContainText("Playing", { timeout: 10_000 });

  // Advance: the player switches to the second title…
  await expect(page.getByRole("heading", { name: b.title, exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(list.locator('li[aria-current="true"]')).toContainText(b.title);
  // …and keeps playing without another tap (no clicks since ▶ Listen).
  await expect(status).toContainText("Playing", { timeout: 10_000 });
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            () => (window as unknown as { __mockSpeech: { spoken: string[] } }).__mockSpeech.spoken
          )
        ).some((t) => t.includes("Bravo")),
      { timeout: 15_000 }
    )
    .toBe(true);

  // Remove the finished head; the queue keeps the current item.
  await page.getByRole("button", { name: `Remove ${a.title}` }).click();
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list.locator("li").nth(0)).toContainText(b.title);

  // Clear empties the queue entirely.
  await page.getByRole("button", { name: "Clear queue" }).click();
  await expect(page.getByText("Your listen queue is empty.")).toBeVisible();
});
