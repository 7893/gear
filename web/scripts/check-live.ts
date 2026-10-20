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

  const response = await page.goto(new URL("/#/diagnostics", base).toString(), {
    waitUntil: "networkidle",
  });
  assert.equal(response?.status(), 200);
  assert.match(response?.headers()["via"] || "", /cloudfront/i);
  assert.match(response?.headers()["x-robots-tag"] || "", /noindex/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/,
  );
  const robots = await page.request.get(
    new URL("/robots.txt", base).toString(),
  );
  assert.equal(robots.status(), 200);
  assert.match(await robots.text(), /User-agent: \*\s+Disallow: \//);
  const embedded = await page.locator("#gear-runtime-config").textContent();
  assert.ok(embedded, "Public startup configuration must travel with HTML");
  const startupConfig = JSON.parse(embedded) as {
    release?: string;
    databaseSchema?: string;
  };
  const apiPolicy = await page.evaluate(async () => {
    const config = (await (
      await fetch("/runtime-config.json", { cache: "no-store" })
    ).json()) as { apiUrl: string };
    const response = await fetch(
      config.apiUrl.replace(/\/$/, "") + "/robots.txt",
    );
    return { status: response.status, body: await response.text() };
  });
  assert.equal(apiPolicy.status, 200);
  assert.match(apiPolicy.body, /User-agent: \*\s+Disallow: \//);
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
  if (
    process.env.SMOKE_EXPECTED_REVISION ||
    process.env.SMOKE_EXPECTED_SCHEMA
  ) {
    const configuration = await page.evaluate(async () => {
      const response = await fetch("/runtime-config.json", {
        cache: "no-store",
      });
      return (await response.json()) as {
        release?: string;
        databaseSchema?: string;
      };
    });
    if (process.env.SMOKE_EXPECTED_REVISION)
      assert.equal(configuration.release, process.env.SMOKE_EXPECTED_REVISION);
    if (process.env.SMOKE_EXPECTED_SCHEMA)
      assert.equal(
        configuration.databaseSchema,
        process.env.SMOKE_EXPECTED_SCHEMA,
      );
    assert.equal(startupConfig.release, configuration.release);
    assert.equal(startupConfig.databaseSchema, configuration.databaseSchema);
  }
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
