import { test, expect, type Page, type Route } from "@playwright/test";
import { expectActionSpacing, layoutWidths } from "./layout.js";

const api = "https://api.example.invalid";
const userId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const email = "person@example.invalid";
const examplePassword = "example-only-" + "x".repeat(16);
type Membership = {
  id: string;
  display_name: string;
  contact_phone?: string | null;
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
  let registeredPhone: string | undefined;
  let listReads = 0;
  let verificationFailure = false;
  let reauthFailure = false;
  let wrongReauthIdentity = false;
  let passwordFailure = false;
  let holdReauth = false;
  let releaseReauth: (() => void) | undefined;
  let holdSettings = false;
  let releaseSettings: (() => void) | undefined;
  let settingsFailure = "";
  const recoveryRequests: Record<string, unknown>[] = [];
  const settingsWrites: Record<string, unknown>[] = [];
  const dueWrites: Record<string, unknown>[] = [];
  const dueSettings = {
    enabled: false,
    lead_days: 3,
    local_time: "09:00",
    mail_enabled: true,
  };
  let settingsReadFailure = false;
  let dueVersionDrift = false;
  const savedSettings = new Map<string, Record<string, unknown>>();
  const settings = {
    document_header: "示例原单位",
    version: 1,
    history: [] as Record<string, unknown>[],
  };
  let loseSettingsAck = false;
  const verificationBodies: Record<string, unknown>[] = [];
  const signupBodies: Record<string, unknown>[] = [];
  const applicationBodies: Record<string, unknown>[] = [];
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
        databaseSchema: "example_app_2026",
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
      if (path === "/auth/v1/token" && reauthFailure)
        return route.fulfill({
          status: 400,
          json: {
            code: "invalid_credentials",
            message: "private login diagnostic",
          },
        });
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
      if (path === "/auth/v1/token" && wrongReauthIdentity)
        value.user.id = "00000000-0000-4000-8000-000000000099";
      if (path === "/auth/v1/token" && holdReauth) {
        holdReauth = false;
        await new Promise<void>((resolve) => (releaseReauth = resolve));
      }
      if (registeredName)
        value.user.user_metadata = {
          gear_application_name: registeredName,
          gear_application_phone: registeredPhone,
        };
      return route.fulfill({ json: value });
    }
    if (path === "/auth/v1/recover") {
      recoveryRequests.push(request.postDataJSON());
      return route.fulfill({ json: {} });
    }
    if (path === "/auth/v1/user") {
      if (request.method() === "PUT") {
        passwordUpdates.push(request.postDataJSON());
        if (passwordFailure) return route.abort("failed");
      }
      return route.fulfill({ json: { user: session().user } });
    }
    if (path === "/auth/v1/signup") {
      const body = request.postDataJSON();
      signupBodies.push(body);
      registeredName = body.data.gear_application_name;
      registeredPhone = body.data.gear_application_phone;
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
    expect(request.headers()["content-profile"]).toBe("example_app_2026");
    if (
      path.endsWith("/get_app_settings") ||
      path.endsWith("/get_due_settings")
    ) {
      if (settingsReadFailure)
        return route.fulfill({
          status: 503,
          json: { message: "private settings diagnostic" },
        });
      return route.fulfill({
        json: path.endsWith("/get_app_settings")
          ? settings
          : {
              ...dueSettings,
              version: settings.version + (dueVersionDrift ? 1 : 0),
            },
      });
    }
    if (path.endsWith("/update_due_settings")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      dueWrites.push(body);
      if (settingsFailure)
        return route.fulfill({
          status: 400,
          json: { message: settingsFailure },
        });
      const key = String(body.request_id);
      let saved = savedSettings.get(key);
      if (!saved) {
        if (body.expected_version !== settings.version)
          return route.fulfill({
            status: 409,
            json: { message: "settings_conflict" },
          });
        Object.assign(dueSettings, {
          enabled: body.enabled,
          lead_days: body.lead_days,
          local_time: body.local_time,
        });
        settings.version++;
        saved = { ...dueSettings, version: settings.version };
        savedSettings.set(key, saved);
      }
      if (loseSettingsAck) {
        loseSettingsAck = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: saved });
    }
    if (path.endsWith("/update_document_header")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      settingsWrites.push(body);
      if (settingsFailure)
        return route.fulfill({
          status: 400,
          json: { message: settingsFailure },
        });
      const key = String(body.request_id);
      let saved = savedSettings.get(key);
      if (!saved) {
        if (body.expected_version !== settings.version)
          return route.fulfill({
            status: 409,
            json: { message: "settings_conflict" },
          });
        const before = settings.document_header;
        settings.document_header = String(body.document_header);
        settings.version++;
        settings.history.unshift({
          id: "1",
          recorded_at: "2026-01-02T00:00:00Z",
          actor_label: "示例管理员",
          reason: body.reason,
          before_header: before,
          after_header: settings.document_header,
        });
        saved = {
          document_header: settings.document_header,
          version: settings.version,
        };
        savedSettings.set(key, saved);
      }
      if (holdSettings) {
        holdSettings = false;
        await new Promise<void>((resolve) => (releaseSettings = resolve));
      }
      if (loseSettingsAck) {
        loseSettingsAck = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: saved });
    }
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
      const body = request.postDataJSON();
      applicationBodies.push(body);
      membership = { ...pending, ...body };
      return route.fulfill({ json: membership });
    }
    if (path.endsWith("/list_members")) {
      listReads++;
      return route.fulfill({ json: members });
    }
    if (path.endsWith("/notification_status")) {
      return route.fulfill({
        json: {
          enabled: false,
          counts: { failed: 1, unknown: 1 },
          recent: [
            {
              id: "example-notification",
              notification_type: "application_result",
              status: "unknown",
              attempt_count: 1,
              error_code: "submission_unknown",
              updated_at: "2030-01-01T00:00:00Z",
            },
          ],
        },
      });
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
    signupBodies,
    applicationBodies,
    passwordUpdates,
    members,
    settings,
    settingsWrites,
    dueWrites,
    dueSettings,
    failSettingsRead: (value: boolean) => (settingsReadFailure = value),
    driftSettingsVersion: (value: boolean) => (dueVersionDrift = value),
    recoveryRequests,
    failReauth: () => (reauthFailure = true),
    wrongReauthIdentity: () => (wrongReauthIdentity = true),
    failPassword: () => (passwordFailure = true),
    holdReauth: () => (holdReauth = true),
    releaseReauth: () => releaseReauth?.(),
    holdSettings: () => (holdSettings = true),
    releaseSettings: () => releaseSettings?.(),
    failSettings: (message: string) => (settingsFailure = message),
    loseSettingsAck: () => (loseSettingsAck = true),
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

const activeMember: Membership = {
  ...pending,
  status: "active",
  role: "viewer",
};
const adminMember: Membership = { ...activeMember, role: "admin" };

test("account and administration actions keep responsive spacing", async ({
  page,
}) => {
  const f = await fixture(page, true, true);
  f.setMembership(adminMember);
  await login(page);
  for (const [path, heading] of [
    ["/account", "我的账号"],
    ["/account/password", "修改密码"],
    ["/members", "账号管理"],
    ["/settings", "单位设置"],
    ["/login", "登录设备簿"],
    ["/register", "申请使用设备簿"],
    ["/verify", "验证邮箱"],
    ["/recover", "找回密码"],
  ]) {
    await page.goto("/#" + path);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: /正在读取|正在加载/ }),
    ).toHaveCount(0);
    for (const width of layoutWidths) {
      await page.setViewportSize({ width, height: 1000 });
      await expectActionSpacing(page);
    }
  }
});

async function fillPasswordChange(page: Page) {
  await page.goto("/#/account/password");
  await page.getByLabel("当前密码", { exact: true }).fill(examplePassword);
  await page
    .getByLabel("新密码", { exact: true })
    .fill(examplePassword + "-new");
  await page
    .getByLabel("再次输入新密码", { exact: true })
    .fill(examplePassword + "-new");
  await page.getByRole("checkbox").check();
}

test("signed-in password change reauthenticates without replacing stored session and changes only password", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(activeMember);
  await login(page);
  await page.evaluate(() => localStorage.setItem("unrelated.auth", "keep"));
  await fillPasswordChange(page);
  await page.getByRole("button", { name: "确认修改密码", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("密码已更新");
  await expect(
    page.getByRole("link", { name: "前往登录", exact: true }),
  ).toBeVisible();
  expect(f.passwordUpdates).toEqual([
    {
      password: examplePassword + "-new",
      code_challenge: null,
      code_challenge_method: null,
    },
  ]);
  expect(f.authPaths.filter((p) => p === "/auth/v1/token")).toHaveLength(2);
  expect(f.actions).toEqual([]);
  expect(f.recoveryRequests).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.getItem("gear.auth.v1")),
  ).toBeNull();
  expect(
    await page.evaluate(() => localStorage.getItem("unrelated.auth")),
  ).toBe("keep");
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith("gear.password-change"),
      ),
    ),
  ).toEqual([]);
});

for (const failure of [
  "wrong password",
  "wrong identity",
  "changed membership",
]) {
  test(`password change refuses ${failure} before updating credentials`, async ({
    page,
  }) => {
    const f = await fixture(page);
    f.setMembership(activeMember);
    await login(page);
    await fillPasswordChange(page);
    if (failure === "wrong password") f.failReauth();
    if (failure === "wrong identity") f.wrongReauthIdentity();
    if (failure === "changed membership")
      f.setMembership({ ...pending, status: "disabled" });
    await page
      .getByRole("button", { name: "确认修改密码", exact: true })
      .click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(f.passwordUpdates).toEqual([]);
    await expect(page.getByLabel("当前密码", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("新密码", { exact: true })).toHaveValue("");
    expect(
      await page.evaluate(() => localStorage.getItem("gear.auth.v1")),
    ).not.toBeNull();
  });
}

test("password form validates shared impact and matching passwords before reauthentication", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(activeMember);
  await login(page);
  await fillPasswordChange(page);
  await page.getByRole("checkbox").uncheck();
  await page.getByRole("button", { name: "确认修改密码", exact: true }).click();
  expect(f.authPaths.filter((p) => p === "/auth/v1/token")).toHaveLength(1);
  await page.getByRole("checkbox").check();
  await page
    .getByLabel("再次输入新密码", { exact: true })
    .fill(examplePassword + "-different");
  await page.getByRole("button", { name: "确认修改密码", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("两次输入的新密码不一致");
  expect(f.authPaths.filter((p) => p === "/auth/v1/token")).toHaveLength(1);
  expect(f.passwordUpdates).toEqual([]);
});

test("leaving during reauthentication never updates the password or clears a normal session", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(activeMember);
  await login(page);
  await fillPasswordChange(page);
  f.holdReauth();
  await page.getByRole("button", { name: "确认修改密码", exact: true }).click();
  await expect
    .poll(() => f.authPaths.filter((p) => p === "/auth/v1/token").length)
    .toBe(2);
  await page.getByRole("link", { name: "返回我的账号", exact: true }).click();
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/auth/v1/token",
  );
  f.releaseReauth();
  await (await response).finished();
  await expect(
    page.getByRole("heading", { name: "我的账号", exact: true }),
  ).toBeVisible();
  expect(f.passwordUpdates).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.getItem("gear.auth.v1")),
  ).not.toBeNull();
});

test("an uncertain password update is not automatically retried", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(activeMember);
  await login(page);
  await fillPasswordChange(page);
  f.failPassword();
  await page.getByRole("button", { name: "确认修改密码", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(f.passwordUpdates).toHaveLength(1);
  await expect(
    page.getByText("若提交时连接中断", { exact: false }),
  ).toBeVisible();
});

test("administrator requests the existing recovery flow without changing a password or approval", async ({
  page,
}) => {
  const f = await fixture(page, true, true);
  f.setMembership(adminMember);
  Object.assign(f.members[0], { status: "active", role: "viewer" });
  await login(page);
  await page.goto("/#/members");
  const oldSession = await page.evaluate(() =>
    localStorage.getItem("gear.auth.v1"),
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "发送找回验证码", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("已提交找回验证码请求");
  expect(f.recoveryRequests).toHaveLength(1);
  expect(f.recoveryRequests[0]).toMatchObject({ email });
  expect(f.passwordUpdates).toEqual([]);
  expect(f.actions).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("gear.auth.v1"))).toBe(
    oldSession,
  );
  await page.goto("/#/recover");
  await page.getByLabel("注册邮箱", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "已有找回验证码", exact: true })
    .click();
  expect(f.recoveryRequests).toHaveLength(1);
  await page.getByLabel("验证码", { exact: true }).fill("000042");
  await page
    .getByRole("button", { name: "验证找回验证码", exact: true })
    .click();
  await expect(page.getByLabel("新密码", { exact: true })).toBeVisible();
  expect(f.verificationBodies.at(-1)).toMatchObject({
    email,
    token: "000042",
    type: "recovery",
  });
});

test("administrator recovery rechecks target version before sending", async ({
  page,
}) => {
  const f = await fixture(page, true, true);
  f.setMembership(adminMember);
  Object.assign(f.members[0], { status: "active", role: "viewer" });
  await login(page);
  await page.goto("/#/members");
  await expect(
    page.getByRole("button", { name: "发送找回验证码", exact: true }),
  ).toBeVisible();
  f.members[0].version++;
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "发送找回验证码", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "请刷新账号列表" }),
  ).toBeVisible();
  expect(f.recoveryRequests).toEqual([]);
});

test("administrator edits heading with retry and history without changing original documents", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(adminMember);
  await login(page);
  await page.goto("/#/settings");
  await page.getByLabel("单位抬头", { exact: true }).fill("示例更新单位");
  await page.getByLabel("修改原因", { exact: true }).fill("示例核对单位名称");
  f.loseSettingsAck();
  await page.getByRole("button", { name: "保存单位抬头", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("单位抬头", { exact: true })).toHaveValue(
    "示例更新单位",
  );
  await page.getByRole("button", { name: "保存单位抬头", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "单位抬头已更新" }),
  ).toBeVisible();
  expect(f.settingsWrites).toHaveLength(2);
  expect(f.settingsWrites[0]).toEqual(f.settingsWrites[1]);
  await expect(
    page.getByText("示例原单位 → 示例更新单位", { exact: true }),
  ).toBeVisible();
  expect(f.actions).toEqual([]);
});

test("heading conflicts keep input and late writes disappear after administrator revocation", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(adminMember);
  await login(page);
  await page.goto("/#/settings");
  await page.getByLabel("单位抬头", { exact: true }).fill("示例冲突名称");
  await page.getByLabel("修改原因", { exact: true }).fill("示例冲突核对");
  f.failSettings("settings_conflict");
  await page.getByRole("button", { name: "保存单位抬头", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("设置已变化");
  await expect(page.getByLabel("单位抬头", { exact: true })).toHaveValue(
    "示例冲突名称",
  );
  f.failSettings("");
  f.holdSettings();
  await page.getByRole("button", { name: "保存单位抬头", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "正在保存…", exact: true }),
  ).toBeDisabled();
  f.setMembership({ ...pending, status: "disabled" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("仅有效管理员可以查看和修改单位设置。", { exact: true }),
  ).toBeVisible();
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/update_document_header"),
  );
  f.releaseSettings();
  await (await response).finished();
  await expect(page.getByText("单位抬头已更新", { exact: false })).toHaveCount(
    0,
  );
});

for (const role of ["operator", "viewer"]) {
  test(`${role} can change own password but cannot read unit settings or reset another account`, async ({
    page,
  }) => {
    const f = await fixture(page, true, true);
    f.setMembership({ ...activeMember, role });
    await login(page);
    await expect(
      page.getByRole("link", { name: "修改密码", exact: true }),
    ).toBeVisible();
    await page.goto("/#/settings");
    await expect(
      page.getByText("仅有效管理员可以查看和修改单位设置。", { exact: true }),
    ).toBeVisible();
    expect(f.settingsWrites).toEqual([]);
    expect(f.listReads()).toBe(0);
    expect(f.recoveryRequests).toEqual([]);
  });
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
  await page.getByLabel("手机号", { exact: true }).fill("13800000000");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(examplePassword);
  const sent = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/auth/v1/signup",
  );
  await page.getByRole("button", { name: "注册并验证邮箱" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body.data).toEqual({
    gear_application_name: "Example applicant",
    gear_application_phone: "13800000000",
  });
  expect(body).not.toHaveProperty("phone");
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
  expect(state.applicationBodies).toEqual([
    { display_name: "Example applicant", contact_phone: "13800000000" },
  ]);
  await expect(
    page.getByText("联系手机号：13800000000（未验证）"),
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

test("registration rejects invalid mainland contacts while editing, before any signup", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#/register");
  await page.getByLabel("姓名", { exact: true }).fill("赵明");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(examplePassword);
  const phone = page.getByLabel("手机号", { exact: true });
  await expect(phone).toHaveAttribute("type", "tel");
  await expect(phone).toHaveAttribute("required", "");
  for (const value of [
    "",
    "1380000000",
    "138000000000",
    "12800000000",
    "23800000000",
    "+8613800000000",
    "１３８００００００００",
    "138 0000000",
    "1380000000x",
    " 13800000000",
  ]) {
    await phone.evaluate((element, text) => {
      const field = element as HTMLInputElement;
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("blur"));
    }, value);
    await expect(phone).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toContainText(
      "中国大陆 11 位手机号码",
    );
    await page.getByRole("button", { name: "注册并验证邮箱" }).click();
    expect(state.signupBodies).toEqual([]);
    expect(state.applicationBodies).toEqual([]);
  }
  await phone.fill("19900000000");
  await expect(phone).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "注册并验证邮箱" }).click();
  await expect(
    page.getByRole("heading", { name: "验证邮箱", exact: true }),
  ).toBeVisible();
  expect(state.signupBodies).toHaveLength(1);
  expect(state.authPaths.filter((path) => /sms|phone/.test(path))).toEqual([]);
});

test("registration checks names inline and accepts compound and ethnic names", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#/register");
  await page.getByLabel("手机号", { exact: true }).fill("13800000000");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(examplePassword);
  const name = page.getByLabel("姓名", { exact: true });
  for (const value of [
    "张三",
    "测试",
    "TEST USER",
    "12345",
    "王1",
    "王😀",
    "<script>",
    "张  明",
    "A",
  ]) {
    await name.fill(value);
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toContainText("本人姓名");
    await page.getByRole("button", { name: "注册并验证邮箱" }).click();
    expect(state.signupBodies).toEqual([]);
  }
  for (const value of [
    "张三丰",
    "欧阳晓",
    "阿卜杜拉·艾力",
    "Anne Marie",
    "Élodie Martin",
    "O'Neil",
    "Jean-Luc",
  ]) {
    await name.fill(value);
    await expect(name).not.toHaveAttribute("aria-invalid", "true");
  }
  await name.fill("阿卜杜拉·艾力");
  await page.getByRole("button", { name: "注册并验证邮箱" }).click();
  await expect(
    page.getByRole("heading", { name: "验证邮箱", exact: true }),
  ).toBeVisible();
  expect(state.signupBodies[0].data).toEqual({
    gear_application_name: "阿卜杜拉·艾力",
    gear_application_phone: "13800000000",
  });
});

test("an existing shared identity must supply valid contacts for a Gear application", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  const submit = page.getByRole("button", {
    name: "提交使用申请",
    exact: true,
  });
  await page.getByLabel("姓名", { exact: true }).fill("赵明");
  await submit.click();
  expect(state.applicationBodies).toEqual([]);
  await page.getByLabel("手机号", { exact: true }).fill("13800000000");
  await submit.click();
  await expect(
    page.getByText("申请已提交，等待管理员审核。审核前无法查看设备信息。"),
  ).toBeVisible();
  expect(state.applicationBodies).toEqual([
    { display_name: "赵明", contact_phone: "13800000000" },
  ]);
  expect(state.signupBodies).toEqual([]);
});

test("only the account administrator sees applicants' contact phones", async ({
  page,
}) => {
  const state = await fixture(page);
  state.members[0] = { ...state.members[0], contact_phone: "13800000000" };
  state.setMembership(adminMember);
  await login(page);
  await page.goto("/#/members");
  await expect(
    page.getByText("联系手机号：13800000000（未验证）"),
  ).toBeVisible();
  state.setMembership(activeMember);
  await page.goto("/#/account");
  await page.getByRole("button", { name: "刷新账号状态", exact: true }).click();
  await page.goto("/#/members");
  await expect(
    page.getByText("仅管理员可以查看和处理使用申请。"),
  ).toBeVisible();
  await expect(page.getByText("联系手机号：13800000000（未验证）")).toHaveCount(
    0,
  );
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
  await page.getByLabel("手机号", { exact: true }).fill("13800000000");
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
  const mailStatus = page.getByRole("region", { name: "审核邮件通知" });
  await expect(mailStatus).toContainText("审核通知尚未开启。");
  await expect(mailStatus).toContainText("发送结果不明");
  await expect(mailStatus).toContainText("系统不会自动重发");
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
  await expect(mailStatus).toHaveCount(0);
});

test("notification diagnostics failure does not block review or reveal provider errors", async ({
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
  await page.route(api + "/rest/v1/rpc/notification_status", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "private provider diagnostic must not appear" },
    }),
  );
  await login(page);
  await page.getByRole("link", { name: "账号管理", exact: true }).click();
  await expect(
    page.getByText("通知状态暂时无法读取，请稍后刷新。"),
  ).toBeVisible();
  await expect(
    page.getByText("private provider diagnostic must not appear"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "批准申请" }).click();
  await expect(page.getByText("账号处理已保存。")).toBeVisible();
  expect(state.actions).toHaveLength(1);
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

test("admin configures digest explicitly with East-eight time; other settings remain separate", async ({
  page,
}) => {
  const f = await fixture(page, true, true);
  f.setMembership(adminMember);
  await login(page);
  await page.goto("/#/settings");
  const region = page.getByRole("region", {
    name: "到期邮件提醒",
    exact: true,
  });
  await expect(region).toContainText("提前提醒一次，到期当天提醒一次");
  await expect(region).toContainText("从逾期第 3 天起每隔 3 天提醒一次");
  await expect(region.getByLabel("发送时间")).toHaveValue("09:00");
  await region.getByLabel("启用到期提醒邮件").check();
  await region.getByLabel("提前提醒天数").fill("5");
  await region.getByLabel("发送时间").fill("10:30");
  await region.getByLabel("调整原因").fill("示例跟进时间调整");
  await region
    .getByRole("button", { name: "保存到期提醒规则", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "提醒设置已保存" }),
  ).toBeVisible();
  expect(f.dueWrites).toHaveLength(1);
  expect(f.dueWrites[0]).toMatchObject({
    expected_version: 1,
    enabled: true,
    lead_days: 5,
    local_time: "10:30",
    reason: "示例跟进时间调整",
  });
  expect(f.settingsWrites).toEqual([]);
});

test("unit settings share current versions, serialize saves and retain the other form's draft", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(adminMember);
  await login(page);
  await page.goto("/#/settings");
  const title = page.getByLabel("单位抬头", { exact: true }),
    headerReason = page.getByLabel("修改原因", { exact: true });
  const due = page.getByRole("region", { name: "到期邮件提醒", exact: true });
  const saveHeader = page.getByRole("button", {
      name: "保存单位抬头",
      exact: true,
    }),
    saveDue = due.getByRole("button", {
      name: "保存到期提醒规则",
      exact: true,
    });
  await expect(saveHeader).toBeEnabled();
  await title.fill("示例保留抬头草稿");
  await headerReason.fill("示例名称更正");
  await due.getByLabel("提前提醒天数").fill("5");
  await due.getByLabel("调整原因").fill("示例提醒调整");
  await saveDue.click();
  await expect(saveHeader).toBeEnabled();
  await expect(title).toHaveValue("示例保留抬头草稿");
  await expect(headerReason).toHaveValue("示例名称更正");
  await due.getByLabel("提前提醒天数").fill("7");
  await due.getByLabel("调整原因").fill("示例尚未提交的提醒草稿");
  f.holdSettings();
  await saveHeader.click();
  await expect(saveDue).toBeDisabled();
  await due.locator("form").dispatchEvent("submit");
  expect(f.dueWrites).toHaveLength(1);
  f.releaseSettings();
  await expect(saveHeader).toBeEnabled();
  await expect(due.getByLabel("提前提醒天数")).toHaveValue("7");
  await expect(due.getByLabel("调整原因")).toHaveValue(
    "示例尚未提交的提醒草稿",
  );
  await saveDue.click();
  await expect(saveDue).toBeEnabled();
  expect(f.settingsWrites[0].expected_version).toBe(2);
  expect(f.dueWrites.map((w) => w.expected_version)).toEqual([1, 3]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("lost reminder replies reuse a nonce; inconsistent read snapshots cannot be edited", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(adminMember);
  await login(page);
  await page.goto("/#/settings");
  const due = page.getByRole("region", { name: "到期邮件提醒", exact: true }),
    save = due.getByRole("button", { name: "保存到期提醒规则", exact: true });
  await expect(save).toBeEnabled();
  await due.getByLabel("调整原因").fill("示例提醒核对");
  f.loseSettingsAck();
  await save.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await save.click();
  await expect(save).toBeEnabled();
  expect(f.dueWrites).toHaveLength(2);
  expect(f.dueWrites[0]).toEqual(f.dueWrites[1]);
  f.driftSettingsVersion(true);
  await page.getByRole("button", { name: "刷新设置", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("设置已变化");
  await expect(page.getByLabel("单位抬头", { exact: true })).toHaveCount(0);
  f.driftSettingsVersion(false);
  await page.getByRole("button", { name: "刷新设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存单位抬头", exact: true }),
  ).toBeEnabled();
});

test("failed settings refresh retains the other draft and blocks stale-version writes", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setMembership(adminMember);
  await login(page);
  await page.goto("/#/settings");
  const title = page.getByLabel("单位抬头", { exact: true });
  const saveHeader = page.getByRole("button", {
    name: "保存单位抬头",
    exact: true,
  });
  const due = page.getByRole("region", { name: "到期邮件提醒", exact: true });
  const saveDue = due.getByRole("button", {
    name: "保存到期提醒规则",
    exact: true,
  });
  await expect(saveHeader).toBeEnabled();
  await title.fill("示例未提交名称");
  await page.getByLabel("修改原因", { exact: true }).fill("示例保留草稿");
  await due.getByLabel("调整原因").fill("示例提醒调整");
  f.failSettingsRead(true);
  await saveDue.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).not.toContainText(
    "private settings diagnostic",
  );
  await expect(title).toHaveValue("示例未提交名称");
  await expect(saveHeader).toBeDisabled();
  await expect(saveDue).toBeDisabled();
  await due.locator("form").dispatchEvent("submit");
  expect(f.dueWrites).toHaveLength(1);
  expect(f.settingsWrites).toHaveLength(0);
  f.failSettingsRead(false);
  await page.getByRole("button", { name: "刷新设置", exact: true }).click();
  await expect(saveHeader).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
