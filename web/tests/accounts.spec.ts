import { test, expect, type Page, type Route } from "@playwright/test";

const api = "https://api.example.invalid";
const userId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const email = "person@example.invalid";
const examplePassword = "example-only-" + "x".repeat(16);
type Membership = {
  id: string;
  display_name: string;
  status: string;
  role: string | null;
  version: number;
  review_note: string | null;
};
const pending: Membership = {
  id: memberId,
  display_name: "Example applicant",
  status: "pending",
  role: null,
  version: 1,
  review_note: null,
};

function session() {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    access_token: [
      encode({ alg: "HS256", typ: "JWT" }),
      encode({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
      "example-signature",
    ].join("."),
    refresh_token: "example-refresh",
    token_type: "bearer",
    expires_in: 3600,
    user: {
      id: userId,
      email,
      aud: "authenticated",
      role: "authenticated",
      email_confirmed_at: "2030-01-01T00:00:00Z",
      user_metadata: {},
      app_metadata: {},
    },
  };
}

async function fixture(page: Page, enabled = true, recoveryEnabled = false) {
  let membership: Membership | null = null;
  let profileFailure = false;
  let registeredName: string | undefined;
  let listReads = 0;
  let verificationFailure = false;
  const verificationBodies: Record<string, unknown>[] = [];
  const passwordUpdates: Record<string, unknown>[] = [];
  const actions: Record<string, unknown>[] = [];
  const authPaths: string[] = [];
  const members = [
    { ...pending, email, email_verified: true, identity_exists: true },
  ];
  await page.route("**/runtime-config.json", (route) =>
    route.fulfill({
      json: {
        apiUrl: api,
        publishableKey: "sb_publishable_example",
        accountsEnabled: enabled,
        recoveryEnabled,
      },
    }),
  );
  await page.route(api + "/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.startsWith("/auth/")) authPaths.push(path);
    if (path === "/auth/v1/token" || path === "/auth/v1/verify") {
      if (path === "/auth/v1/verify") {
        verificationBodies.push(request.postDataJSON());
        if (verificationFailure)
          return route.fulfill({
            status: 403,
            headers: {
              "x-supabase-api-version": "2024-01-01",
              "Access-Control-Expose-Headers": "x-supabase-api-version",
            },
            json: {
              code: "otp_expired",
              message: "private verification diagnostic",
            },
          });
      }
      const value = session();
      if (registeredName)
        value.user.user_metadata = { gear_application_name: registeredName };
      return route.fulfill({ json: value });
    }
    if (path === "/auth/v1/recover") return route.fulfill({ json: {} });
    if (path === "/auth/v1/user") {
      if (request.method() === "PUT")
        passwordUpdates.push(request.postDataJSON());
      return route.fulfill({ json: { user: session().user } });
    }
    if (path === "/auth/v1/signup") {
      registeredName = request.postDataJSON().data.gear_application_name;
      return route.fulfill({ json: {} });
    }
    if (path === "/auth/v1/resend") return route.fulfill({ json: {} });
    if (path === "/auth/v1/logout") {
      expect(url.searchParams.get("scope")).toBe("local");
      return route.fulfill({ status: 204 });
    }
    // The UI must use fixed RPCs, never direct Auth admin endpoints or table writes.
    if (!path.startsWith("/rest/v1/rpc/"))
      throw new Error("Unexpected account request");
    expect(request.headers()["content-profile"]).toBe("gear");
    if (path.endsWith("/get_my_membership")) {
      if (profileFailure)
        return route.fulfill({
          status: 503,
          json: { message: "private diagnostic must not appear" },
        });
      return route.fulfill({
        json: { email, email_verified: true, membership },
      });
    }
    if (path.endsWith("/apply_for_access")) {
      membership = { ...pending };
      return route.fulfill({ json: membership });
    }
    if (path.endsWith("/list_members")) {
      listReads++;
      return route.fulfill({ json: members });
    }
    if (path.endsWith("/set_member_access")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      actions.push(body);
      members[0] = {
        ...members[0],
        status: String(body.new_status),
        role: body.new_role as string | null,
        version: 2,
      };
      return route.fulfill({ json: members[0] });
    }
    throw new Error("Unexpected RPC");
  });
  return {
    setMembership: (value: Membership | null) => {
      membership = value;
    },
    failProfile: () => {
      profileFailure = true;
    },
    actions,
    authPaths,
    listReads: () => listReads,
    verificationBodies,
    passwordUpdates,
    failVerification: () => {
      verificationFailure = true;
    },
  };
}

async function login(page: Page) {
  await page.goto("/#/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(examplePassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的账号", exact: true }),
  ).toBeVisible();
}

test("closed account service makes no Auth requests", async ({ page }) => {
  const state = await fixture(page, false);
  await page.goto("/#/register");
  await expect(
    page.getByRole("button", { name: "注册并验证邮箱" }),
  ).toBeDisabled();
  await page.goto("/#/login");
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeDisabled();
  expect(state.authPaths).toEqual([]);
});

test("register, verify and explicitly apply without assigning a role", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#/register");
  await page.getByLabel("姓名", { exact: true }).fill("Example applicant");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(examplePassword);
  const sent = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/auth/v1/signup",
  );
  await page.getByRole("button", { name: "注册并验证邮箱" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body.data).toEqual({ gear_application_name: "Example applicant" });
  await expect(page.getByRole("status")).toContainText("若该邮箱可以注册");
  await expect(
    page.getByRole("heading", { name: "验证邮箱", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("邮箱", { exact: true })).toHaveValue(email);
  await page.getByLabel("验证码", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "验证邮箱", exact: true }).click();
  await expect(
    page.getByText("申请已提交，等待管理员审核。审核前无法查看设备信息。"),
  ).toBeVisible();
  await page.goto("/#/members");
  await expect(
    page.getByText("仅管理员可以查看和处理使用申请。"),
  ).toBeVisible();
  expect(state.listReads()).toBe(0);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(
    page.getByRole("link", { name: "登录", exact: true }),
  ).toBeVisible();
});

test("verification requires exactly six ASCII digits and preserves leading zeroes", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#/verify");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  const input = page.getByLabel("验证码", { exact: true });
  await expect(input).toHaveAttribute("maxlength", "6");
  for (const code of ["12345", "1234567", "12a456", "１２３４５６"]) {
    await input.evaluate((element, value) => {
      const field = element as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, code);
    expect(
      await input.evaluate((element) =>
        (element as HTMLInputElement).checkValidity(),
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "验证邮箱", exact: true }).click();
  }
  expect(state.authPaths.filter((path) => path === "/auth/v1/verify")).toEqual(
    [],
  );
  await input.fill("000042");
  const verified = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/auth/v1/verify",
  );
  await page.getByRole("button", { name: "验证邮箱", exact: true }).click();
  expect((await verified).postDataJSON()).toMatchObject({
    email,
    token: "000042",
    type: "signup",
  });
});

test("an existing shared identity explicitly applies before membership is created", async ({
  page,
}) => {
  await fixture(page);
  await login(page);
  await page.getByLabel("姓名", { exact: true }).fill("Example existing user");
  await page.getByRole("button", { name: "提交使用申请" }).click();
  await expect(
    page.getByText("申请已提交，等待管理员审核。审核前无法查看设备信息。"),
  ).toBeVisible();
});

test("administrator approves with an idempotent fixed RPC and clears revoked access", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setMembership({
    ...pending,
    id: userId,
    display_name: "Example admin",
    status: "active",
    role: "admin",
  });
  await login(page);
  await page.getByRole("link", { name: "账号管理", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Example applicant", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "批准申请" }).click();
  await expect(page.getByText("账号处理已保存。")).toBeVisible();
  expect(state.actions).toHaveLength(1);
  expect(state.actions[0]).toMatchObject({
    target_member_id: memberId,
    expected_version: 1,
    new_status: "active",
    new_role: "viewer",
  });
  expect(state.actions[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
  state.setMembership({
    ...pending,
    id: userId,
    status: "disabled",
    role: null,
    version: 2,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("仅管理员可以查看和处理使用申请。"),
  ).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);
});

test("failed permission refresh removes old privileged data and redacts server errors", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setMembership({
    ...pending,
    id: userId,
    status: "active",
    role: "admin",
  });
  await login(page);
  await page.getByRole("link", { name: "账号管理", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Example applicant", exact: true }),
  ).toBeVisible();
  state.failProfile();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("仅管理员可以查看和处理使用申请。"),
  ).toBeVisible();
  await expect(
    page.getByText("private diagnostic must not appear"),
  ).toHaveCount(0);
});

test("callback codes are removed from the address before rendering", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/?code=example-sensitive-code#/login");
  await expect(
    page.getByRole("heading", { name: "我的账号", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain("example-sensitive-code");
});

test("recovery remains closed without its separate release flag", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#/login");
  await expect(page.getByRole("link", { name: "忘记密码" })).toHaveCount(0);
  await page.goto("/#/recover");
  await expect(
    page.getByRole("button", { name: "发送找回验证码" }),
  ).toBeDisabled();
  expect(state.authPaths).toEqual([]);
});

test("recovery verifies six digits before changing only the password and returning to login", async ({
  page,
}) => {
  const state = await fixture(page, true, true);
  state.setMembership({ ...pending, status: "active", role: "viewer" });
  await page.goto("/#/login");
  await page.getByRole("link", { name: "忘记密码" }).click();
  await page.getByLabel("注册邮箱").fill(email);
  const requested = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/auth/v1/recover",
  );
  await page.getByRole("button", { name: "发送找回验证码" }).click();
  expect(new URL((await requested).url()).searchParams.get("redirect_to")).toBe(
    new URL("/", page.url()).toString(),
  );
  await expect(page.getByRole("status")).toContainText(
    "若该邮箱对应已验证、已启用",
  );
  await expect(page.getByLabel("新密码", { exact: true })).toHaveCount(0);
  await page.getByLabel("验证码", { exact: true }).fill("000042");
  await page.getByRole("button", { name: "验证找回验证码" }).click();
  await expect(page.getByLabel("新密码", { exact: true })).toBeVisible();
  expect(state.verificationBodies[0]).toMatchObject({
    email,
    token: "000042",
    type: "recovery",
  });
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("gear.recovery"),
      ),
    ),
  ).toEqual([]);
  await page.evaluate(() => localStorage.setItem("unrelated.auth", "keep"));
  const newPassword = examplePassword + "-new";
  await page.getByLabel("新密码", { exact: true }).fill(newPassword);
  await page.getByLabel("再次输入新密码", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "设置新密码" }).click();
  expect(state.passwordUpdates).toEqual([]);
  await page.getByRole("checkbox").check();
  await page
    .getByLabel("再次输入新密码", { exact: true })
    .fill(newPassword + "-different");
  await page.getByRole("button", { name: "设置新密码" }).click();
  await expect(page.getByRole("alert")).toContainText("两次输入的新密码不一致");
  expect(state.passwordUpdates).toEqual([]);
  await page.getByLabel("新密码", { exact: true }).fill(newPassword);
  await page.getByLabel("再次输入新密码", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "设置新密码" }).click();
  await expect(page.getByRole("status")).toContainText("密码已更新");
  expect(state.passwordUpdates).toEqual([
    {
      password: newPassword,
      code_challenge: null,
      code_challenge_method: null,
    },
  ]);
  expect(state.actions).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.getItem("unrelated.auth")),
  ).toBe("keep");
  expect(
    await page.evaluate(() => localStorage.getItem("gear.auth.v1")),
  ).toBeNull();
  await page.getByRole("link", { name: "返回登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录设备簿" })).toBeVisible();
});

test("wrong recovery codes cannot reach password changes", async ({ page }) => {
  const state = await fixture(page, true, true);
  state.failVerification();
  await page.goto("/#/recover");
  await page.getByLabel("注册邮箱").fill(email);
  await page.getByRole("button", { name: "发送找回验证码" }).click();
  await page.getByLabel("验证码", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "验证找回验证码" }).click();
  await expect(page.getByRole("alert")).toContainText("验证码已失效");
  await expect(page.getByLabel("新密码", { exact: true })).toHaveCount(0);
  expect(state.passwordUpdates).toEqual([]);
});

test("membership is checked again if disabled after the recovery code was verified", async ({
  page,
}) => {
  const state = await fixture(page, true, true);
  state.setMembership({ ...pending, status: "active", role: "viewer" });
  await page.goto("/#/recover");
  await page.getByLabel("注册邮箱").fill(email);
  await page.getByRole("button", { name: "发送找回验证码" }).click();
  await page.getByLabel("验证码", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "验证找回验证码" }).click();
  await expect(page.getByLabel("新密码", { exact: true })).toBeVisible();
  state.setMembership({ ...pending, status: "disabled", role: null });
  await page
    .getByLabel("新密码", { exact: true })
    .fill(examplePassword + "-new");
  await page
    .getByLabel("再次输入新密码", { exact: true })
    .fill(examplePassword + "-new");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "设置新密码" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法完成密码找回");
  expect(state.passwordUpdates).toEqual([]);
});
