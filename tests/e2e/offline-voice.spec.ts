import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Offline voice engine (client-side eSpeak -> <audio>): the only playback
// path iOS keeps alive on lock / in background. Proves the user-visible
// contract with REAL synthesis (no mocks — mespeak is bundled JS): select
// the Offline engine -> Listen -> an <audio> element plays blob audio and
// the highlight advances in place -> Pause works -> the engine choice
// persists across reload with no autoplay.
//
// Serial (workers: 1), unique URLs per run, a handful of requests per test
// (well under the 30 req/min/IP limiter).

const DATA_FILE = path.join(process.cwd(), "data", "articles.json");

let backup: { exists: boolean; content: string | null } = { exists: false, content: null };
const createdIds: string[] = [];

function nonce(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
}

// Short on purpose: each sentence synthesizes synchronously (~100-300ms),
// so three sentences keep the test well inside the 30s budget.
function offlineHtml(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${title}</title></head><body><article><h1>${title}</h1><p>Offline voice keeps playing when the screen locks. This is the second sentence for queue advance. A third sentence finishes the short test.</p></article></body></html>`;
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

test("Offline engine plays blob audio, highlights in place, persists across reload", async ({
  page,
  request,
}) => {
  const title = `Offline voice ${nonce("offline")}`;
  const post = await request.post("/api/articles", {
    data: { url: `https://example.com/${nonce("offline")}`, html: offlineHtml(title) },
  });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string };
  createdIds.push(saved.id);

  await page.goto(`/a/${saved.id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".article-body .w").first()).toBeVisible({ timeout: 10_000 });

  const engine = page.getByLabel("TTS engine");
  await expect(engine).toBeVisible();
  await expect(engine).toHaveValue("system");

  // Switch to the offline engine: note + background-capable player appear,
  // choice persists to localStorage (no 5MB download until first Play).
  await engine.selectOption("offline");
  await expect(page.getByTestId("offline-voice-note")).toBeVisible();
  await expect(page.getByTestId("offline-audio")).toHaveCount(1);
  expect(await page.evaluate(() => window.localStorage.getItem("readapaper:tts:engine"))).toBe(
    "offline"
  );

  // Play synthesizes the first sentence and drives the hidden <audio>.
  await page.getByRole("button", { name: "▶ Listen" }).click();
  const status = page.getByTestId("listen-status");
  await expect(status).toContainText("Playing", { timeout: 20_000 });

  const audioPlaying = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="offline-audio"]') as HTMLAudioElement | null;
    return el ? { hasSrc: (el.currentSrc || "").startsWith("blob:"), paused: el.paused } : null;
  });
  expect(audioPlaying).not.toBeNull();
  expect(audioPlaying?.hasSrc).toBe(true);
  expect(audioPlaying?.paused).toBe(false);

  // Highlight advances in place as timeupdate ticks interpolate the playhead.
  await expect(page.locator(".article-body .w.active").first()).toBeVisible({
    timeout: 15_000,
  });

  // Pause halts the element and keeps the position; reload restores the
  // engine with no autoplay.
  await page.getByRole("button", { name: "⏸ Pause" }).click();
  await expect(status).toContainText("Paused", { timeout: 10_000 });

  await page.reload();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByLabel("TTS engine")).toHaveValue("offline");
  await expect(page.getByTestId("listen-status")).toContainText("Idle");
});
