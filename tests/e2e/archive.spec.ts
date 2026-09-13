import { expect, test } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";

// Archive flow: save -> archive -> disappears from default list -> unarchive -> returns.
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

test("archive -> disappears -> unarchive -> returns", async ({ page, request }) => {
  const html = await fs.readFile(FIXTURE, "utf8");
  const url = uniqueUrl("e2e-archive");

  const post = await request.post("/api/articles", { data: { url, html } });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string };
  createdIds.push(saved.id);

  // Visible in the default (active) list.
  let list = (await (await request.get("/api/articles")).json()) as { id: string }[];
  expect(list.map((a) => a.id)).toContain(saved.id);

  // Archive via the PUT route.
  const archived = await request.put(`/api/articles/${saved.id}/archive`, {
    data: { archived: true },
  });
  expect(archived.status()).toBe(200);
  expect(await archived.json()).toEqual({ ok: true, archived: true });

  // Disappears from the default list, shows under ?archived=1.
  list = (await (await request.get("/api/articles")).json()) as { id: string }[];
  expect(list.map((a) => a.id)).not.toContain(saved.id);
  const archivedList = (await (await request.get("/api/articles?archived=1")).json()) as {
    id: string;
  }[];
  expect(archivedList.map((a) => a.id)).toContain(saved.id);

  // Progress writes to the archived article keep working.
  const put = await request.put(`/api/articles/${saved.id}/progress`, {
    data: { progress: 0.5 },
  });
  expect(put.status()).toBe(200);

  // Browser: home hides it, archived view shows it with an Unarchive button.
  await page.goto("/");
  await expect(page.locator(`a.title[href="/a/${saved.id}"]`)).toHaveCount(0);
  await page.goto("/?archived=1");
  await expect(page.locator(`a.title[href="/a/${saved.id}"]`)).toBeVisible();
  await expect(page.getByRole("button", { name: `Unarchive ${TITLE}` })).toBeVisible();

  // Unarchive -> returns to the default list.
  const unarchived = await request.put(`/api/articles/${saved.id}/archive`, {
    data: { archived: false },
  });
  expect(unarchived.status()).toBe(200);
  expect(await unarchived.json()).toEqual({ ok: true, archived: false });
  list = (await (await request.get("/api/articles")).json()) as { id: string }[];
  expect(list.map((a) => a.id)).toContain(saved.id);

  await page.goto("/");
  await expect(page.locator(`a.title[href="/a/${saved.id}"]`)).toBeVisible();
  await expect(page.getByRole("button", { name: `Archive ${TITLE}` }).first()).toBeVisible();
});

test("article page header has archive toggle", async ({ page, request }) => {
  const html = await fs.readFile(FIXTURE, "utf8");
  const url = uniqueUrl("e2e-archive-header");

  const post = await request.post("/api/articles", { data: { url, html } });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string };
  createdIds.push(saved.id);

  await page.goto(`/a/${saved.id}`);
  const header = page.locator("header.topbar");
  // NOTE: exact:true — "Archive <title>" is a substring of "Unarchive <title>".
  await expect(header.getByRole("button", { name: `Archive ${TITLE}`, exact: true })).toBeVisible();

  await header.getByRole("button", { name: `Archive ${TITLE}`, exact: true }).click();
  await expect(
    header.getByRole("button", { name: `Unarchive ${TITLE}`, exact: true })
  ).toBeVisible();

  let list = (await (await request.get("/api/articles")).json()) as { id: string }[];
  expect(list.map((a) => a.id)).not.toContain(saved.id);

  await header.getByRole("button", { name: `Unarchive ${TITLE}`, exact: true }).click();
  await expect(header.getByRole("button", { name: `Archive ${TITLE}`, exact: true })).toBeVisible();

  list = (await (await request.get("/api/articles")).json()) as { id: string }[];
  expect(list.map((a) => a.id)).toContain(saved.id);
});

test("archive route validates input", async ({ request }) => {
  const html = await fs.readFile(FIXTURE, "utf8");
  const url = uniqueUrl("e2e-archive-validation");
  const post = await request.post("/api/articles", { data: { url, html } });
  expect(post.status()).toBe(201);
  const saved = (await post.json()) as { id: string };
  createdIds.push(saved.id);

  expect((await request.put(`/api/articles/${saved.id}/archive`, { data: {} })).status()).toBe(400);
  expect(
    (
      await request.put(`/api/articles/${saved.id}/archive`, {
        data: { archived: "yes" },
      })
    ).status()
  ).toBe(400);
  const missing = `e2e-missing-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  expect(
    (await request.put(`/api/articles/${missing}/archive`, { data: { archived: true } })).status()
  ).toBe(404);
});
