import { test, expect } from "@playwright/test";

const config = {
  apiUrl: "https://api.example.invalid",
  databaseSchema: "example_app_2026",
  publishableKey: "sb_publishable_example",
  accountsEnabled: true,
};

test("the login shell renders before configuration and shares its preload with diagnostics", async ({
  page,
}) => {
  let release!: () => void;
  let reads = 0;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/runtime-config.json", async (route) => {
    reads++;
    await held;
    await route.fulfill({ json: config });
  });
  await page.route(config.apiUrl + "/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/healthz")
        ? { status: "ready" }
        : { external: {} },
    }),
  );
  await page.goto("/#/login", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".site-header")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "登录设备簿", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("账号服务尚未开放，暂不能注册或登录。"),
  ).toHaveCount(0);
  release();
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeEnabled();
  await page.goto("/#/diagnostics");
  await expect(page.locator("#gateway-status")).toHaveAttribute(
    "data-state",
    "success",
  );
  await expect(page.locator("#supabase-status")).toHaveAttribute(
    "data-state",
    "success",
  );
  expect(reads).toBe(1);
});

test("an invalid initial configuration remains retryable", async ({ page }) => {
  let valid = false;
  await page.route("**/runtime-config.json", (route) =>
    route.fulfill({
      json: valid
        ? config
        : { ...config, apiUrl: "http://api.example.invalid" },
    }),
  );
  await page.route(config.apiUrl + "/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/healthz")
        ? { status: "ready" }
        : { external: {} },
    }),
  );
  await page.goto("/#/diagnostics");
  await expect(page.locator("#gateway-status")).toHaveAttribute(
    "data-state",
    "failure",
  );
  valid = true;
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.locator("#gateway-status")).toHaveAttribute(
    "data-state",
    "success",
  );
  await expect(page.locator("#supabase-status")).toHaveAttribute(
    "data-state",
    "success",
  );
});

test("embedded public configuration starts without a separate config request", async ({
  page,
}) => {
  let reads = 0;
  const unexpected: string[] = [];
  page.on("pageerror", (error) => unexpected.push(error.message));
  await page.route("**/runtime-config.json", (route) => {
    reads++;
    return route.abort();
  });
  await page.route("http://127.0.0.1:4175/", async (route) => {
    const response = await route.fetch();
    const embedded = JSON.stringify({
      ...config,
      publishableKey:
        "sb_publishable_example</script><script>throw new Error('injection')</script>",
    }).replaceAll("<", "\\u003c");
    const html = (await response.text())
      .replace(/<link[^>]*href="\/runtime-config.json"[^>]*>/, "")
      .replace(
        "</head>",
        '<script id="gear-runtime-config" type="application/json">' +
          embedded +
          "</script></head>",
      );
    await route.fulfill({ response, body: html });
  });
  await page.goto("/#/login");
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeEnabled();
  expect(reads).toBe(0);
  expect(unexpected).toEqual([]);
});
