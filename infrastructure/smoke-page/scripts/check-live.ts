import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const base = process.env.SMOKE_BASE_URL;
if (!base || new URL(base).protocol !== "https:") {
  throw new Error(
    "Provide an HTTPS SMOKE_BASE_URL through private configuration",
  );
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  const calls: { path: string; status: number }[] = [];
  page.on("pageerror", () => errors.push("browser_script_error"));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (["/healthz", "/auth/v1/settings"].includes(path))
      calls.push({ path, status: response.status() });
  });

  const response = await page.goto(base, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200);
  assert.match(response?.headers()["via"] || "", /cloudfront/i);
  await expect(page.locator("#page-status")).toHaveAttribute(
    "data-state",
    "success",
  );
  await expect(page.locator("#gateway-status")).toHaveAttribute(
    "data-state",
    "success",
    { timeout: 15000 },
  );
  await expect(page.locator("#supabase-status")).toHaveAttribute(
    "data-state",
    "success",
    { timeout: 15000 },
  );
  await expect(page.locator("#checked-at")).toContainText("UTC");
  await page.getByRole("button", { name: "重新检测" }).click();
  await expect(page.locator("#retry")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#gateway-status")).toHaveAttribute(
    "data-state",
    "success",
  );
  await expect(page.locator("#supabase-status")).toHaveAttribute(
    "data-state",
    "success",
  );
  assert.equal(errors.length, 0);
  for (const path of ["/healthz", "/auth/v1/settings"])
    assert.ok(
      calls.filter((call) => call.path === path && call.status === 200)
        .length >= 2,
    );
  console.log(
    JSON.stringify({
      browser: "Chromium",
      page: "passed",
      backend: "passed",
      supabase: "passed",
      retry: "passed",
      scriptErrors: errors.length,
      requests: calls,
    }),
  );
  await context.close();
} finally {
  await browser.close();
}
