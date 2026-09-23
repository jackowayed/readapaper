import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Full user flow: save -> list -> read -> progress resume -> browser -> delete.
// Uses unique URLs per run so it never depends on pre-existing store contents.

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

test("save -> list -> read -> progress -> browser -> delete", async ({ page, request }) => {
  const html = await fs.readFile(FIXTURE, "utf8");
  const url = uniqueUrl("e2e-crud");

  // 1. POST /api/articles {url, html} -> 201, capture id.
  const post = await request.post("/api/articles", { data: { url, html } });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string; title: string };
  expect(saved.id).toBeTruthy();
  expect(saved.title).toBe(TITLE);
  createdIds.push(saved.id);

  // 2. List contains it; GET [id] -> 200 with title.
  const listRes = await request.get("/api/articles");
  expect(listRes.status()).toBe(200);
  const list = (await listRes.json()) as { id: string; title: string }[];
  expect(list.map((a) => a.id)).toContain(saved.id);

  const getRes = await request.get(`/api/articles/${saved.id}`);
  expect(getRes.status()).toBe(200);
  expect(((await getRes.json()) as { title: string }).title).toBe(TITLE);

  // 3. PUT progress -> {ok:true}; re-GET shows 0.5.
  const putRes = await request.put(`/api/articles/${saved.id}/progress`, {
    data: { progress: 0.5 },
  });
  expect(putRes.status()).toBe(200);
  expect(((await putRes.json()) as { ok: boolean }).ok).toBe(true);
  const reGet = await request.get(`/api/articles/${saved.id}`);
  expect(((await reGet.json()) as { progress: number }).progress).toBe(0.5);

  // 4. Browser: GET / renders the saved title; GET /a/[id] renders the article.
  const homeRes = await page.goto("/");
  expect(homeRes?.status()).toBe(200);
  await expect(page.getByRole("link", { name: TITLE })).toBeVisible();

  const articleRes = await page.goto(`/a/${saved.id}`);
  expect(articleRes?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();

  // 6. DELETE soft-deletes to trash -> 204; still GETtable, hidden from the
  // default list, visible via ?deleted=1.
  const del = await request.delete(`/api/articles/${saved.id}`);
  expect(del.status()).toBe(204);
  expect((await request.get(`/api/articles/${saved.id}`)).status()).toBe(200);
  const afterDel = (await (await request.get("/api/articles")).json()) as {
    id: string;
  }[];
  expect(afterDel.map((a) => a.id)).not.toContain(saved.id);
  const trash = (await (await request.get("/api/articles?deleted=1")).json()) as {
    id: string;
  }[];
  expect(trash.map((a) => a.id)).toContain(saved.id);

  // 7. Permanent delete -> 204; GET -> 404.
  const purge = await request.delete(`/api/articles/${saved.id}?permanent=1`);
  expect(purge.status()).toBe(204);
  createdIds.splice(createdIds.indexOf(saved.id), 1);
  expect((await request.get(`/api/articles/${saved.id}`)).status()).toBe(404);
});

test("unknown id returns 404", async ({ request }) => {
  const missing = `e2e-missing-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  expect((await request.get(`/api/articles/${missing}`)).status()).toBe(404);
  expect((await request.delete(`/api/articles/${missing}`)).status()).toBe(404);
  expect(
    (await request.put(`/api/articles/${missing}/progress`, { data: { progress: 0.5 } })).status()
  ).toBe(404);
});
