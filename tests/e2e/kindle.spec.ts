import { expect, test } from "@playwright/test";

// Kindle button/status validation paths only — never sends real mail.
// The dev/CI server has no SMTP env, so /api/kindle/status reports
// configured:false and the library button stays disabled with a setup hint.

test("library shows a disabled Kindle button with a setup hint when unconfigured", async ({
  page,
  request,
}) => {
  const status = await request.get("/api/kindle/status");
  expect(status.status()).toBe(200);
  const body = (await status.json()) as { configured: boolean; activeCount: number };
  expect(typeof body.configured).toBe("boolean");
  expect(typeof body.activeCount).toBe("number");
  // No secrets ever leak through the status endpoint.
  const raw = JSON.stringify(body);
  expect(raw).not.toMatch(/SMTP_PASS|app-password/i);
  expect(body).not.toHaveProperty("kindleEmail");
  expect(body).not.toHaveProperty("fromEmail");

  // The Kindle control is injected by an inline script into a
  // hydration-exempt root — it must never trip React hydration (#418).
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto("/");
  const button = page.getByTestId("kindle-send");
  await expect(button).toBeVisible();
  await expect(button).toContainText("Send 50 latest to Kindle");
  if (!body.configured) {
    await expect(button).toBeDisabled();
    await expect(page.getByTestId("kindle-status")).toContainText(/SMTP/i);
  }
  expect(pageErrors.filter((m) => /hydrat|Minified React/i.test(m))).toEqual([]);
});

test("POST /api/kindle/send is 503 with a setup hint when unconfigured", async ({ request }) => {
  const status = (await (await request.get("/api/kindle/status")).json()) as {
    configured: boolean;
  };
  // Never send real mail: only exercise the send route when the server is
  // unconfigured (expecting the 503 validation path).
  test.skip(
    status.configured,
    "SMTP configured — skipping live-send validation to avoid real mail"
  );
  const send = await request.post("/api/kindle/send");
  expect(send.status()).toBe(503);
  const body = (await send.json()) as { error: string; setup: string };
  expect(body.error).toMatch(/not configured/i);
  expect(body.setup).toMatch(/SMTP_HOST/i);
  expect(JSON.stringify(body)).not.toMatch(/Error: |at .*\(.*:\d+:\d+\)/);
});
