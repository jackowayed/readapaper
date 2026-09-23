import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Unified read/listen progress (docs/unified-progress.md Phase 4): one
// canonical char offset owned by ReaderClient, restored silently in read
// (scroll) + listen (highlight) modes, preserved across mode toggles, and
// queued offline / replayed on reconnect.
//
// Serial (workers: 1 in playwright.config.ts — the JSON store has no write
// mutex), unique URLs per run, and only a handful of requests per test so the
// suite stays far under the 30 req/min/IP limiter (no server override hook
// exists on the prod server, so e2e keeps volume low instead).

const DATA_FILE = path.join(process.cwd(), "data", "articles.json");
const PENDING_KEY = "readapaper:pending-progress";

let backup: { exists: boolean; content: string | null } = { exists: false, content: null };
const createdIds: string[] = [];

function nonce(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
}

// Long enough that 50% scroll is unambiguous (short fixtures barely scroll).
function longHtml(title: string): string {
  const para = `<p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(24)}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${title}</title></head><body><article><h1>${title}</h1>${para.repeat(120)}</article></body></html>`;
}

async function createArticle(
  request: import("@playwright/test").APIRequestContext,
  tag: string
): Promise<{ id: string; title: string; textLength: number }> {
  const title = `Progress Sync ${nonce(tag)}`;
  const post = await request.post("/api/articles", {
    data: { url: `https://example.com/${nonce(tag)}`, html: longHtml(title) },
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

async function scrollFraction(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    return h <= 0 ? 0 : window.scrollY / h;
  });
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

test("reload restores read scroll silently", async ({ page, request }) => {
  const { id, title } = await createArticle(request, "read-restore");
  const putRes = await request.put(`/api/articles/${id}/progress`, {
    data: { progress: 0.5 },
  });
  expect(putRes.status()).toBe(200);

  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  // Silent restore: scroll lands mid-article with no resume banner/dialog.
  await expect.poll(async () => scrollFraction(page), { timeout: 10_000 }).toBeGreaterThan(0.3);
  await expect.poll(async () => scrollFraction(page), { timeout: 10_000 }).toBeLessThan(0.7);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/resume/i)).toHaveCount(0);
});

test("reload restores finished (>=95%) articles near the bottom", async ({ page, request }) => {
  const { id, title } = await createArticle(request, "finished-restore");
  const putRes = await request.put(`/api/articles/${id}/progress`, {
    data: { progress: 0.97 },
  });
  expect(putRes.status()).toBe(200);

  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  // Finished articles restore too (previously >=95% dropped to top).
  await expect.poll(async () => scrollFraction(page), { timeout: 10_000 }).toBeGreaterThan(0.9);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("reload highlights listen offset silently (no autoplay)", async ({ page, request }) => {
  const { id, title, textLength } = await createArticle(request, "listen-restore");
  const mid = Math.floor(textLength / 2);
  const put = await request.put(`/api/articles/${id}/progress`, { data: { offset: mid } });
  expect(put.status()).toBe(200);

  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  if (!(await page.evaluate(() => "speechSynthesis" in window))) {
    test.skip(true, "speechSynthesis unavailable in this browser");
    return;
  }
  await page.getByRole("button", { name: "🎧 Listen in sync" }).click();
  // Saved word is highlighted immediately, without pressing play.
  const active = page.locator(".listen-text .w.active");
  await expect(active).toBeVisible({ timeout: 10_000 });
  const raw = await active.getAttribute("id");
  const wordStart = Number(raw?.replace("w-", ""));
  expect(wordStart).toBeLessThanOrEqual(mid);
  expect(mid - wordStart).toBeLessThan(500);
  // No autoplay: the player still offers Listen, never Pause.
  await expect(page.getByRole("button", { name: "▶ Listen" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Pause/ })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("mode toggle preserves the anchor both ways", async ({ page, request }) => {
  const { id, title, textLength } = await createArticle(request, "handoff");
  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  if (!(await page.evaluate(() => "speechSynthesis" in window))) {
    test.skip(true, "speechSynthesis unavailable in this browser");
    return;
  }

  // Read: scroll mid-article; the throttled (600ms) hook persists the offset.
  await page.evaluate(() => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, h * 0.5);
  });
  await expect.poll(async () => serverOffset(request, id), { timeout: 15_000 }).toBeGreaterThan(0);
  const saved = await serverOffset(request, id);

  // read -> listen: highlight lands on the saved word.
  await page.getByRole("button", { name: "🎧 Listen in sync" }).click();
  const active = page.locator(".listen-text .w.active");
  await expect(active).toBeVisible({ timeout: 10_000 });
  const wordStart = Number((await active.getAttribute("id"))?.replace("w-", ""));
  expect(wordStart).toBeLessThanOrEqual(saved);
  expect(saved - wordStart).toBeLessThan(500);

  // listen -> read: scroll returns to the saved offset's fraction.
  await page.getByRole("button", { name: "📖 Read" }).click();
  const expected = saved / Math.max(1, textLength);
  await expect
    .poll(async () => scrollFraction(page), { timeout: 10_000 })
    .toBeGreaterThan(expected - 0.12);
  await expect
    .poll(async () => scrollFraction(page), { timeout: 10_000 })
    .toBeLessThan(expected + 0.12);
});

test("offline scroll write replays on reconnect", async ({ page, request, context }) => {
  const { id, title, textLength } = await createArticle(request, "offline-replay");
  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await context.setOffline(true);
  let queuedOffset = 0;
  try {
    await page.evaluate(() => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, h * 0.6);
    });
    // The failed PUT is queued in localStorage (Phase 3 offline queue).
    await expect
      .poll(
        async () =>
          page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]").length, PENDING_KEY),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);
    // Read the queue while still offline: reconnecting navigates the
    // service-worker-controlled page, which would destroy this context.
    const queued = (await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
      PENDING_KEY
    )) as { offset?: number }[];
    queuedOffset = queued.find((e) => typeof e.offset === "number")?.offset ?? 0;
  } finally {
    await context.setOffline(false);
  }
  expect(queuedOffset).toBeGreaterThan(0);

  // Back online: the reconnect may reload the page; either way OfflineSupport
  // replays the queue on mount/online (legacy fraction fallback round-trips
  // the offset, plus layout/integer noise — hence the small tolerance).
  await page.waitForLoadState("load");
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect.poll(async () => serverOffset(request, id), { timeout: 15_000 }).toBeGreaterThan(0);
  const replayed = await serverOffset(request, id);
  expect(Math.abs(replayed - queuedOffset)).toBeLessThanOrEqual(
    Math.max(8, Math.round(textLength * 0.002))
  );
  await expect
    .poll(
      async () =>
        page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]").length, PENDING_KEY),
      { timeout: 15_000 }
    )
    .toBe(0);
});
