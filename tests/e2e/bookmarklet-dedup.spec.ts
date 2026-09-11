import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Bookmarklet flow: the bookmarklet POSTs {url, html} extracted from the live
// page DOM. Re-saving the same URL must dedup (200, same id) instead of
// creating a duplicate (201), and the response must carry the CORS header the
// cross-origin bookmarklet needs.

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
  // Restore the pre-run store so the suite leaves zero residue even on failure.
  if (backup.exists && backup.content !== null) {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, backup.content, "utf8");
  } else {
    await fs.rm(DATA_FILE, { force: true });
  }
});

test.afterEach(async ({ request }) => {
  // Best-effort per-test cleanup; the afterAll restore is the backstop.
  while (createdIds.length > 0) {
    const id = createdIds.pop();
    if (id !== undefined) await request.delete(`/api/articles/${id}`);
  }
});

test("bookmarklet re-save dedups to 200 with CORS and the same id", async ({ page, request }) => {
  const html = await fs.readFile(FIXTURE, "utf8");
  const url = uniqueUrl("e2e-bookmarklet");

  // First save -> 201.
  const first = await request.post("/api/articles", { data: { url, html } });
  expect(first.status()).toBe(201);
  const saved = (await first.json()) as { id: string; title: string };
  expect(saved.id).toBeTruthy();
  expect(saved.title).toBe(TITLE);
  createdIds.push(saved.id);

  // 5. Bookmarklet/dedup flow: POST the same {url, html} again -> 200 (not 201).
  const second = await request.post("/api/articles", { data: { url, html } });
  expect(second.status()).toBe(200);
  expect(second.headers()["access-control-allow-origin"]).toBe("*");
  expect(((await second.json()) as { id: string }).id).toBe(saved.id);

  // Trailing-slash variant normalizes to the same article.
  const slashed = await request.post("/api/articles", { data: { url: `${url}/`, html } });
  expect(slashed.status()).toBe(200);
  expect(((await slashed.json()) as { id: string }).id).toBe(saved.id);

  // No duplicate created: exactly one list entry carries this id
  // (without assuming anything else about store contents).
  const list = (await (await request.get("/api/articles")).json()) as { id: string }[];
  expect(list.filter((a) => a.id === saved.id)).toHaveLength(1);

  // Browser: the deduped article still renders.
  const articleRes = await page.goto(`/a/${saved.id}`);
  expect(articleRes?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();

  // 6. DELETE -> 204; GET -> 404.
  expect((await request.delete(`/api/articles/${saved.id}`)).status()).toBe(204);
  createdIds.splice(createdIds.indexOf(saved.id), 1);
  expect((await request.get(`/api/articles/${saved.id}`)).status()).toBe(404);
});

test("CORS preflight allows the bookmarklet cross-origin POST", async ({ request }) => {
  const preflight = await request.fetch("/api/articles", {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.com",
      "Access-Control-Request-Method": "POST",
    },
  });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()["access-control-allow-origin"]).toBe("*");
});
