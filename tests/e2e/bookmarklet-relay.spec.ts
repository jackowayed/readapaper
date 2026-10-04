import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Relay flow: the bookmarklet opens /bookmarklet#autosave in a new tab and
// postMessages { type: 'readapaper-save', url, html }. The page saves
// same-origin (no Local Network Access prompt, no CSP/CORS issue) and acks.

const DATA_FILE = path.join(process.cwd(), "data", "articles.json");
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "simple.html");

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
    if (id !== undefined) await request.delete(`/api/articles/${id}?permanent=1`);
  }
});

test("relay postMessage saves same-origin and shows the open link", async ({ page }) => {
  const html = await fs.readFile(FIXTURE, "utf8");
  const url = uniqueUrl("e2e-relay");

  await page.goto("/bookmarklet#autosave");
  await expect(page.getByText("Waiting for the article tab")).toBeVisible();

  await page.evaluate(
    ({ url, html }) => {
      window.postMessage({ type: "readapaper-save", url, html }, "*");
    },
    { url, html }
  );

  await expect(page.getByText("Saved to Readapaper.")).toBeVisible({ timeout: 10000 });
  const openLink = page.getByRole("link", { name: /Open in Readapaper/ });
  await expect(openLink.first()).toBeVisible();
  const href = (await openLink.first().getAttribute("href")) ?? "";
  const id = href.split("/").pop() ?? "";
  expect(id).toBeTruthy();
  createdIds.push(id);

  // The saved article renders.
  await page.goto(`/a/${id}`);
  await expect(
    page.getByRole("heading", { name: "The Quiet Science of Reading on Screens" })
  ).toBeVisible();
});
