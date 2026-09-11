import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Offline PWA wiring: manifest + service worker + /offline fallback, plus a
// cached article that stays readable with the network cut.

const DATA_FILE = path.join(process.cwd(), "data", "articles.json");
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "simple.html");
const TITLE = "The Quiet Science of Reading on Screens";

let backup: { exists: boolean; content: string | null } = { exists: false, content: null };
const createdIds: string[] = [];

function uniqueUrl(prefix: string): string {
  return `https://example.com/${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
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

test("manifest, service worker, and offline page are served", async ({ page, request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(((await manifest.json()) as { short_name: string }).short_name).toBe("Readapaper");

  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(await sw.text()).toContain("readapaper-");

  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);

  const offlineRes = await page.goto("/offline");
  expect(offlineRes?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
});

test("cached article stays readable offline", async ({ page, request, context }) => {
  const html = await fs.readFile(FIXTURE, "utf8");
  const post = await request.post("/api/articles", {
    data: { url: uniqueUrl("e2e-offline"), html },
  });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string };
  createdIds.push(saved.id);

  // Load once online so the service worker caches the page + API responses.
  await page.goto(`/a/${saved.id}`);
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();

  // Cut the network: the cached article must still render.
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  createdIds.splice(createdIds.indexOf(saved.id), 1);
  expect((await request.delete(`/api/articles/${saved.id}`)).status()).toBe(204);
});

test("library warming caches unopened articles for offline", async ({ page, request, context }) => {
  const html = await fs.readFile(FIXTURE, "utf8");
  const post = await request.post("/api/articles", {
    data: { url: uniqueUrl("e2e-offline-warm"), html },
  });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string };
  createdIds.push(saved.id);

  // Open only the library: auto-warm caches the article without visiting it.
  await page.goto("/");
  await expect(page.getByRole("button", { name: /available offline/ })).toBeVisible({
    timeout: 20000,
  });

  // Cut the network and open the never-visited article.
  await context.setOffline(true);
  try {
    const articleRes = await page.goto(`/a/${saved.id}`);
    expect(articleRes?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  createdIds.splice(createdIds.indexOf(saved.id), 1);
  expect((await request.delete(`/api/articles/${saved.id}`)).status()).toBe(204);
});
