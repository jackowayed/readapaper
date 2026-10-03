import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Unified read/listen progress: one article view, one canonical char offset.
// Scrolling persists while idle/paused; the playhead persists while playing
// (same endpoint, last-writer-wins). Reload restores scroll + highlight
// silently in that same view — no mode toggle, no handoff trip.
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

test("reload highlights the saved position silently in the same view (no autoplay)", async ({
  page,
  request,
}) => {
  const { id, title } = await createArticle(request, "listen-restore");
  const put = await request.put(`/api/articles/${id}/progress`, {
    data: { progress: 0.5 },
  });
  expect(put.status()).toBe(200);
  const mid = await serverOffset(request, id);

  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  // The saved word is highlighted in the article itself, without pressing play.
  const active = page.locator(".article-body .w.active");
  await expect(active.first()).toBeVisible({ timeout: 10_000 });
  // No autoplay: the player still offers Listen, never Pause.
  await expect(page.getByRole("button", { name: "▶ Listen" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Pause/ })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Single view: there is no mode toggle anymore.
  await expect(page.getByRole("button", { name: "🎧 Listen in sync" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "📖 Read" })).toHaveCount(0);
  expect(mid).toBeGreaterThan(0);
});

test("reading then listening keeps the same position (no handoff trip)", async ({
  page,
  request,
}) => {
  const { id, title } = await createArticle(request, "handoff");
  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".article-body .w").first()).toBeVisible({ timeout: 10_000 });

  // Read: scroll mid-article; the throttled hook persists the offset.
  await page.evaluate(() => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, h * 0.5);
  });
  await expect.poll(async () => serverOffset(request, id), { timeout: 15_000 }).toBeGreaterThan(0);
  const saved = await serverOffset(request, id);
  const beforeFraction = await scrollFraction(page);

  // Press Play in place: the highlight lands near the saved read position
  // and the page does not jump (same view, no remount).
  await page.getByRole("button", { name: "▶ Listen" }).click();
  await expect(page.getByTestId("listen-status")).toContainText(/Playing|Error/, {
    timeout: 15_000,
  });
  const active = page.locator(".article-body .w.active");
  await expect(active.first()).toBeVisible({ timeout: 10_000 });
  const afterFraction = await scrollFraction(page);
  expect(Math.abs(afterFraction - beforeFraction)).toBeLessThan(0.25);
  expect(saved).toBeGreaterThan(0);

  // Pause and keep reading where the voice left off: scroll stays put.
  const pause = page.getByRole("button", { name: /Pause|Retry/ });
  if (await pause.isVisible()) await pause.click();
  await page.waitForTimeout(1200);
  const restFraction = await scrollFraction(page);
  expect(Math.abs(restFraction - afterFraction)).toBeLessThan(0.25);
});

test("listen controls stay visible mid-article without losing progress", async ({
  page,
  request,
}) => {
  const { id, title } = await createArticle(request, "sticky-controls");
  await page.goto(`/a/${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".article-body .w").first()).toBeVisible({ timeout: 10_000 });

  // Scroll mid-article and let the throttled hook persist the anchor.
  await page.evaluate(() => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, h * 0.5);
  });
  await expect.poll(async () => serverOffset(request, id), { timeout: 15_000 }).toBeGreaterThan(0);
  const saved = await serverOffset(request, id);

  // The sticky listen bar stays in the viewport mid-article — no
  // scroll-to-top trip that would persist ~0.
  const play = page.getByRole("button", { name: "▶ Listen" });
  await expect(play).toBeVisible();
  const inViewport = await play.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  expect(inViewport).toBe(true);

  // Highlight restores near the saved offset in the same view, and the
  // stored offset is not clobbered back to the top.
  const active = page.locator(".article-body .w.active");
  await expect(active.first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  expect(await serverOffset(request, id)).toBeGreaterThan(saved * 0.5);
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
