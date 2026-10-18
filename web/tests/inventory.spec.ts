import { expect, test, type Page } from "@playwright/test";
import type { Asset, Party } from "../src/inventory-model.js";

const api = "https://api.example.invalid";
const identity = "00000000-0000-4000-8000-000000000001";
const personId = "00000000-0000-4000-8000-000000000011";
const teamId = "00000000-0000-4000-8000-000000000021";
const assetId = "00000000-0000-4000-8000-000000000031";
const newAssetId = "00000000-0000-4000-8000-000000000032";
const base: Asset = {
  id: assetId,
  version: 1,
  asset_code: "SB-000001",
  legacy_code: "00001-A",
  serial_number: null,
  name: "示例打印机",
  category: "printer",
  condition: "normal",
  brand: null,
  model: null,
  location: "示例房间",
  note: null,
  management_status: "managed",
  display_status: "in_use",
  invalidated_at: null,
  holder_party_id: teamId,
  holder_kind: "team",
  holder_name: "示例团队",
  responsible_person_id: personId,
  responsible_name: "示例人员",
  usage_kind: "temporary",
  started_on: null,
  due_on: "2030-01-01",
  followup_name: "示例经办人",
  last_flow_on: null,
  created_at: "2020-01-01T00:00:00Z",
};
async function fixture(
  page: Page,
  role = "operator",
  enabled: boolean | undefined = true,
) {
  let active = true;
  let listFailure = false;
  let duplicate = false;
  let uncertain = false;
  let release: (() => void) | undefined;
  let hold = false;
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const authCalls: string[] = [];
  const assets = [structuredClone(base)];
  let listResults: Asset[] | undefined;
  const parties: Party[] = [
    {
      id: personId,
      kind: "person",
      name: "示例人员",
      person_type: "staff",
      organization_name: "示例单位",
      default_responsible_id: null,
      note: null,
    },
    {
      id: teamId,
      kind: "team",
      name: "示例团队",
      person_type: null,
      organization_name: null,
      default_responsible_id: personId,
      note: null,
    },
  ];
  const saved = new Map<string, Asset>();
  const extensions = new Map<string, Asset>();
  const history: Record<string, unknown[]> = {};
  let extensionConflict = false;
  const user = {
    id: identity,
    email: "operator@example.invalid",
    email_confirmed_at: "2020-01-01T00:00:00Z",
    user_metadata: {},
    app_metadata: {},
    aud: "authenticated",
    role: "authenticated",
  };
  await page.route("**/runtime-config.json", (route) =>
    route.fulfill({
      json: {
        apiUrl: api,
        databaseSchema: "example_app_2026",
        publishableKey: "sb_publishable_example",
        accountsEnabled: true,
        recoveryEnabled: true,
        ...(enabled === undefined ? {} : { inventoryEnabled: enabled }),
      },
    }),
  );
  await page.route(api + "/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/auth/")) authCalls.push(path);
    if (path === "/auth/v1/token") {
      const encode = (v: unknown) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      return route.fulfill({
        json: {
          access_token: [
            encode({ alg: "HS256", typ: "JWT" }),
            encode({
              sub: identity,
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
            "example-signature",
          ].join("."),
          refresh_token: "example-refresh",
          expires_in: 3600,
          token_type: "bearer",
          user,
        },
      });
    }
    if (path === "/auth/v1/user") return route.fulfill({ json: { user } });
    if (path === "/auth/v1/logout") return route.fulfill({ status: 204 });
    expect(path.startsWith("/rest/v1/rpc/")).toBe(true);
    const name = path.split("/").at(-1)!;
    const body = request.postDataJSON() as Record<string, unknown>;
    expect(request.headers()["content-profile"]).toBe("example_app_2026");
    calls.push({ name, body });
    if (name === "get_my_membership")
      return route.fulfill({
        json: {
          email: user.email,
          email_verified: true,
          membership: {
            id: identity,
            display_name: "示例经办人",
            status: active ? "active" : "disabled",
            role: active ? role : null,
            version: 1,
            review_note: null,
          },
        },
      });
    if (name === "list_assets") {
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      if (listFailure)
        return route.fulfill({
          status: 503,
          json: { message: "private database diagnostic" },
        });
      return route.fulfill({
        json: {
          items: listResults ?? assets,
          matched: (listResults ?? assets).length,
          summary: {
            total: assets.length,
            in_use: assets.length,
            inventory_available: 0,
            inventory_faulty: 0,
            returned_upstream: 0,
            lost: 0,
            scrapped: 0,
            managed_faulty: 0,
          },
        },
      });
    }
    if (name === "list_parties") return route.fulfill({ json: parties });
    if (name === "create_party") {
      const created = {
        ...(body.details as object),
        id:
          "00000000-0000-4000-8000-" +
          String(100 + parties.length).padStart(12, "0"),
      } as Party;
      parties.push(created);
      return route.fulfill({ json: created });
    }
    if (name === "initialize_asset") {
      if (duplicate && !body.allow_legacy_duplicate)
        return route.fulfill({
          status: 400,
          json: { message: "legacy_code_duplicate", code: "22023" },
        });
      const key = String(body.request_id);
      let asset = saved.get(key);
      if (!asset) {
        const details = body.details as Partial<Asset>;
        const placement = body.placement as Record<string, string | null>;
        const holder = parties.find((p) => p.id === placement.holder_party_id);
        const person = parties.find(
          (p) => p.id === placement.responsible_person_id,
        );
        asset = {
          ...base,
          ...details,
          id: newAssetId,
          asset_code: "SB-000002",
          display_status: holder
            ? "in_use"
            : details.condition === "faulty"
              ? "inventory_faulty"
              : "inventory_available",
          holder_party_id: holder?.id || null,
          holder_kind: holder?.kind || null,
          holder_name: holder?.name || null,
          responsible_person_id: person?.id || null,
          responsible_name: person?.name || null,
          usage_kind: placement.usage_kind as "long_term" | "temporary" | null,
          started_on: placement.known_on,
          due_on: placement.due_on,
          last_flow_on: placement.known_on,
        };
        saved.set(key, asset);
        assets.push(asset);
      }
      if (uncertain) {
        uncertain = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: asset });
    }
    if (name === "get_asset") {
      const asset = assets.find((a) => a.id === body.asset_id);
      return asset
        ? route.fulfill({
            json: {
              asset,
              history: [
                ...(history[asset.id] || []),
                {
                  id: "1",
                  event_type: "asset_initialized",
                  occurred_on: asset.last_flow_on,
                  recorded_at: asset.created_at,
                  actor_label: "示例经办人",
                  reason: null,
                  after_data: asset,
                },
              ],
            },
          })
        : route.fulfill({ status: 400, json: { message: "asset_not_found" } });
    }
    if (name === "extend_assignment") {
      if (extensionConflict)
        return route.fulfill({
          status: 400,
          json: { message: "assignment_conflict" },
        });
      let result = extensions.get(String(body.request_id));
      const asset = assets.find((a) => a.id === body.asset_id)!;
      if (!result) {
        const previous = asset.due_on;
        asset.due_on = String(body.new_due_on);
        asset.version = (asset.version || 1) + 1;
        result = structuredClone(asset);
        extensions.set(String(body.request_id), result);
        history[asset.id] = [
          {
            id: "2",
            event_type: "assignment_extended",
            occurred_on: "2030-01-01",
            recorded_at: "2030-01-01T00:00:00Z",
            actor_label: "示例经办人",
            reason: body.reason,
            after_data: { ...asset, previous_due_on: previous },
          },
        ];
      }
      if (uncertain) {
        uncertain = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: result });
    }
    if (name === "list_due_assets") {
      if (listFailure)
        return route.fulfill({
          status: 503,
          json: { message: "private database diagnostic" },
        });
      const records = assets
        .filter(
          (a) =>
            a.usage_kind === "temporary" &&
            a.holder_party_id &&
            a.management_status === "managed",
        )
        .map((a) => ({
          ...a,
          due_state:
            a.due_on! < "2030-01-01"
              ? "overdue"
              : a.due_on === "2030-01-01"
                ? "today"
                : a.due_on! <= "2030-01-04"
                  ? "upcoming"
                  : "later",
        }));
      return route.fulfill({
        json: {
          business_on: "2030-01-01",
          notice_days: 3,
          items: records.filter(
            (a) => !body.state || body.state === a.due_state,
          ),
          summary: {
            total: records.length,
            ...Object.fromEntries(
              ["overdue", "today", "upcoming", "later"].map((state) => [
                state,
                records.filter((a) => a.due_state === state).length,
              ]),
            ),
          },
        },
      });
    }
    throw new Error("Unexpected inventory RPC: " + name);
  });
  return {
    calls,
    authCalls,
    assets,
    conflictExtension: (value: boolean) => (extensionConflict = value),
    filterResults: (items: Asset[] | undefined) => (listResults = items),
    failList: (value: boolean) => (listFailure = value),
    requireDuplicateAck: () => (duplicate = true),
    loseNextAcknowledgement: () => (uncertain = true),
    disable: () => (active = false),
    holdNextList: () => (hold = true),
    releaseList: () => release?.(),
  };
}
async function login(page: Page) {
  await page.goto("/#/login");
  await page
    .getByLabel("邮箱", { exact: true })
    .fill("operator@example.invalid");
  await page
    .getByLabel("密码", { exact: true })
    .fill("example-only-" + "x".repeat(16));
  await page.getByRole("button", { name: "登录", exact: true }).click();
}
async function fillAsset(page: Page, name = "待登记碎纸机") {
  await page.getByLabel("设备名称", { exact: true }).fill(name);
  await page
    .getByRole("combobox", { name: "设备分类", exact: true })
    .selectOption("shredder");
  await page
    .getByRole("combobox", { name: "设备状况", exact: true })
    .selectOption("normal");
}

function paginationAssets() {
  return Array.from({ length: 51 }, (_, index) => ({
    ...structuredClone(base),
    id: "00000000-0000-4000-8000-" + String(1000 + index).padStart(12, "0"),
    asset_code: "SB-" + String(index + 1).padStart(6, "0"),
  }));
}

test("ledger pages all fifty-one devices and supports each page size without refetching", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  state.assets.splice(0, state.assets.length, ...paginationAssets());
  await login(page);
  const nav = page.getByRole("navigation", { name: "设备分页" });
  const rows = page.locator(".inventory-table tbody tr");
  const size = nav.getByRole("combobox", { name: "每页显示", exact: true });
  await expect(rows).toHaveCount(20);
  await expect(size).toHaveValue("20");
  await expect(nav.getByRole("status")).toContainText(
    "显示第 1 至 20 条，共 51 条",
  );
  await expect(
    nav.getByRole("button", { name: "上一页", exact: true }),
  ).toBeDisabled();
  const requests = state.calls.filter((c) => c.name === "list_assets").length;
  await nav.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(rows.first()).toContainText("SB-000021");
  await expect(rows.last()).toContainText("SB-000040");
  await nav.getByRole("button", { name: "末页", exact: true }).click();
  await expect(rows).toHaveCount(11);
  await expect(rows.first()).toContainText("SB-000041");
  await expect(rows.last()).toContainText("SB-000051");
  await expect(
    nav.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  await nav.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(rows.first()).toContainText("SB-000021");
  await size.selectOption("10");
  await expect(rows).toHaveCount(10);
  await expect(nav.getByRole("status")).toContainText("第 1 / 6 页");
  await nav.getByRole("button", { name: "末页", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("SB-000051");
  await size.selectOption("50");
  await expect(rows).toHaveCount(50);
  await expect(nav.getByRole("status")).toContainText("第 1 / 2 页");
  await nav.getByRole("button", { name: "末页", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await nav.getByRole("button", { name: "首页", exact: true }).click();
  await expect(rows.first()).toContainText("SB-000001");
  await size.selectOption("100");
  await expect(rows).toHaveCount(51);
  await expect(nav.getByRole("status")).toContainText("第 1 / 1 页");
  await expect(
    nav.getByRole("button", { name: "末页", exact: true }),
  ).toBeDisabled();
  expect(state.calls.filter((c) => c.name === "list_assets")).toHaveLength(
    requests,
  );
});

test("a filtered ledger resets its page and keeps global counts for single and empty results", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  state.assets.splice(0, state.assets.length, ...paginationAssets());
  await login(page);
  const nav = page.getByRole("navigation", { name: "设备分页" });
  const rows = page.locator(".inventory-table tbody tr");
  await nav.getByRole("button", { name: "末页", exact: true }).click();
  await expect(nav.getByRole("status")).toContainText("第 3 / 3 页");
  state.filterResults([state.assets[50]]);
  await page.getByLabel("搜索设备", { exact: true }).fill("SB-000051");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(nav.getByRole("status")).toContainText(
    "第 1 / 1 页，显示第 1 至 1 条，共 1 条",
  );
  await expect(
    page.getByText("有效设备总数：51", { exact: true }),
  ).toBeVisible();
  state.filterResults([]);
  await page.getByLabel("搜索设备", { exact: true }).fill("没有匹配项");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(rows).toHaveCount(0);
  await expect(nav.getByRole("status")).toContainText("第 1 / 1 页，共 0 条");
  await expect(
    nav.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  await expect(
    nav.getByRole("button", { name: "上一页", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("没有符合当前条件的设备，请调整查询条件。", { exact: true }),
  ).toBeVisible();
  state.filterResults(undefined);
  await page.getByLabel("搜索设备", { exact: true }).fill("");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(nav.getByRole("status")).toContainText("第 1 / 3 页");
});

test("inventory is closed by default and never queries business RPCs", async ({
  page,
}) => {
  const state = await fixture(page, "operator", false);
  await login(page);
  await expect(
    page.getByText("账号已启用。设备台账将在下一步接入。"),
  ).toBeVisible();
  await page.goto("/#/assets");
  await expect(
    page.getByText("设备台账尚未开放。", { exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/new");
  await expect(
    page.getByRole("button", { name: "保存并查看设备" }),
  ).toHaveCount(0);
  expect(state.calls.every((c) => c.name === "get_my_membership")).toBe(true);
});

test("temporary extension retries the same request and shows old and new dates in history", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/" + assetId);
  const form = page.getByRole("region", { name: "临时使用延期" });
  await expect(form).toBeVisible();
  await form.getByLabel("新的预计归还日期", { exact: true }).fill("2030-02-01");
  await form.getByLabel("延期原因", { exact: true }).fill("示例挂职期限延长");
  state.loseNextAcknowledgement();
  await form.getByRole("button", { name: "确认延期", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByLabel("延期原因", { exact: true })).toHaveValue(
    "示例挂职期限延长",
  );
  await form.getByRole("button", { name: "确认延期", exact: true }).click();
  await expect(
    page.getByText("延期已记录，原分发单和签字件保留。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".asset-history")).toContainText(
    "原期限：2030-01-01；新期限：2030-02-01",
  );
  const calls = state.calls.filter((c) => c.name === "extend_assignment");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body).toEqual(calls[1]!.body);
  expect(calls[0]!.body).toMatchObject({
    asset_id: assetId,
    expected_version: 1,
    new_due_on: "2030-02-01",
    reason: "示例挂职期限延长",
  });
  expect(state.assets[0]!.version).toBe(2);
});

test("extension rejects an unchanged date and retains a conflicted form", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/" + assetId);
  const form = page.getByRole("region", { name: "临时使用延期" });
  await form.getByLabel("新的预计归还日期", { exact: true }).fill("2030-01-01");
  await form.getByLabel("延期原因", { exact: true }).fill("示例原因");
  await form.getByRole("button", { name: "确认延期", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("新期限须晚于原期限");
  expect(
    state.calls.filter((c) => c.name === "extend_assignment"),
  ).toHaveLength(0);
  state.conflictExtension(true);
  await form.getByLabel("新的预计归还日期", { exact: true }).fill("2030-02-01");
  await form.getByRole("button", { name: "确认延期", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("设备或期限已变化");
  await expect(form.getByLabel("延期原因", { exact: true })).toHaveValue(
    "示例原因",
  );
  expect(state.assets[0]!.due_on).toBe("2030-01-01");
});

test("due ledger uses server business date, pages and filters without conflating empty and failure", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  state.assets.splice(
    0,
    1,
    ...paginationAssets().map((a, i) => ({
      ...a,
      due_on: i === 0 ? "2029-12-31" : "2030-01-01",
    })),
  );
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "临时使用与到期", exact: true }).click();
  await expect(
    page.getByText("业务日期：2030-01-01（东八区）；提前 3 天提示。", {
      exact: false,
    }),
  ).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(20);
  await expect(page.getByLabel("临时使用统计")).toContainText("已逾期：1");
  await expect(page.getByLabel("临时使用统计")).toContainText("今天到期：50");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(
    page.getByLabel("临时使用分页").getByRole("status"),
  ).toContainText("第 2 / 3 页");
  await page
    .getByRole("combobox", { name: "每页显示", exact: true })
    .selectOption("10");
  await expect(rows).toHaveCount(10);
  await expect(
    page.getByLabel("临时使用分页").getByRole("status"),
  ).toContainText("第 1 / 6 页");
  await page
    .getByRole("combobox", { name: "到期情况", exact: true })
    .selectOption("overdue");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page
    .getByRole("link", { name: "SB-000001 · 示例打印机", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "设备详情", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "临时使用延期" })).toHaveCount(
    0,
  );
  await page.goto("/#/due");
  await page
    .getByRole("combobox", { name: "到期情况", exact: true })
    .selectOption("upcoming");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(
    page.getByText("当前条件下没有临时领用设备。", { exact: true }),
  ).toBeVisible();
  state.failList(true);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByText("当前条件下没有临时领用设备。", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    "private database diagnostic",
  );
  expect(
    state.calls.filter((c) => c.name === "extend_assignment"),
  ).toHaveLength(0);
});

test("revoking a current operator removes the extension form and private data", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/" + assetId);
  await expect(
    page.getByRole("region", { name: "临时使用延期" }),
  ).toBeVisible();
  state.disable();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("当前账号无法执行此操作，请登录或查看账号状态。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "临时使用延期" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "SB-000001 · 示例打印机", exact: true }),
  ).toHaveCount(0);
  expect(
    state.calls.filter((c) => c.name === "extend_assignment"),
  ).toHaveLength(0);
});

test("viewer lands on ledger, sends fixed filters, reads history and cannot open creation", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "登记已有设备" })).toHaveCount(0);
  await page.getByLabel("搜索设备", { exact: true }).fill("00001-A");
  await page
    .getByRole("combobox", { name: "分类", exact: true })
    .selectOption("printer");
  await page
    .getByRole("combobox", { name: "持有情况", exact: true })
    .selectOption("team");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(
    page.getByText("符合当前条件：1 件。日期按东八区显示。"),
  ).toBeVisible();
  expect(
    state.calls.filter((c) => c.name === "list_assets").at(-1)?.body,
  ).toEqual({
    search: "00001-A",
    category: "printer",
    state: null,
    holder_kind: "team",
  });
  await page
    .getByRole("link", { name: "SB-000001 · 示例打印机", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "当前情况" })).toBeVisible();
  await expect(page.getByText("00001-A", { exact: true })).toBeVisible();
  await expect(
    page.getByText("历史日期：未知，未补造日期", { exact: false }),
  ).toBeVisible();
  await page.goto("/#/assets/new");
  await expect(
    page.getByRole("button", { name: "保存并查看设备" }),
  ).toHaveCount(0);
  expect(
    state.calls.some(
      (c) => c.name === "list_parties" || c.name === "initialize_asset",
    ),
  ).toBe(false);
});

test("inventory initialization preserves leading zeroes and unknown dates; duplicate clicks submit once", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await page.getByRole("link", { name: "登记已有设备", exact: true }).click();
  await fillAsset(page);
  await page.getByLabel("原资产编号", { exact: true }).fill("00009 / 旧规则");
  await page
    .locator("form")
    .last()
    .evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
  await expect(
    page.getByRole("heading", { name: "设备详情", exact: true }),
  ).toBeVisible();
  const writes = state.calls.filter((c) => c.name === "initialize_asset");
  expect(writes).toHaveLength(1);
  expect(writes[0].body.placement).toEqual({
    holder_party_id: null,
    responsible_person_id: null,
    usage_kind: null,
    known_on: null,
    due_on: null,
  });
  expect(writes[0].body.details).toMatchObject({
    legacy_code: "00009 / 旧规则",
    name: "待登记碎纸机",
  });
  expect(writes[0].body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(writes[0].body)).not.toMatch(
    /actor_id|asset_code|created_by/,
  );
});

test("duplicate old numbers require explicit acknowledgement and preserve form fields", async ({
  page,
}) => {
  const state = await fixture(page);
  state.requireDuplicateAck();
  await login(page);
  await page.getByRole("link", { name: "登记已有设备", exact: true }).click();
  await fillAsset(page);
  await page.getByLabel("原资产编号", { exact: true }).fill("00001-A");
  await page
    .getByRole("button", { name: "保存并查看设备", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("已有设备使用相同旧编号");
  await expect(page.getByLabel("设备名称", { exact: true })).toHaveValue(
    "待登记碎纸机",
  );
  await expect(
    page.getByRole("button", { name: "保存并查看设备", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "已核对重复旧编号", exact: false })
    .check();
  await page
    .getByRole("button", { name: "保存并查看设备", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "设备详情", exact: true }),
  ).toBeVisible();
  expect(
    state.calls
      .filter((c) => c.name === "initialize_asset")
      .map((c) => c.body.allow_legacy_duplicate),
  ).toEqual([false, true]);
  expect(state.assets).toHaveLength(2);
});

test("lost acknowledgement keeps inputs and reuses the same request without creating again", async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseNextAcknowledgement();
  await login(page);
  await page.getByRole("link", { name: "登记已有设备", exact: true }).click();
  await fillAsset(page);
  await page
    .getByRole("button", { name: "保存并查看设备", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("设备名称", { exact: true })).toHaveValue(
    "待登记碎纸机",
  );
  await page
    .getByRole("button", { name: "保存并查看设备", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "设备详情", exact: true }),
  ).toBeVisible();
  const writes = state.calls.filter((c) => c.name === "initialize_asset");
  expect(writes).toHaveLength(2);
  expect(writes[0].body).toEqual(writes[1].body);
  expect(state.assets).toHaveLength(2);
});

test("create receivers without accounts and initialize temporary team use with a responsible person", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await page.getByRole("link", { name: "登记已有设备", exact: true }).click();
  await page.getByText("新增人员或团队", { exact: true }).click();
  await page.getByLabel("人员或团队名称", { exact: true }).fill("示例借调人员");
  await page
    .getByRole("combobox", { name: "人员类型", exact: true })
    .selectOption("seconded");
  await page
    .getByRole("button", { name: "添加人员或团队", exact: true })
    .click();
  await expect(page.getByText("已添加，可继续登记设备。")).toBeVisible();
  await page
    .getByRole("combobox", { name: "对象类型", exact: true })
    .selectOption("team");
  await page.getByLabel("人员或团队名称", { exact: true }).fill("示例新团队");
  await page
    .getByRole("combobox", { name: "团队默认负责人", exact: true })
    .selectOption({ label: "示例借调人员" });
  await page
    .getByRole("button", { name: "添加人员或团队", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "持有方", exact: true }),
  ).toHaveValue("00000000-0000-4000-8000-000000000103");
  await fillAsset(page, "示例团队设备");
  await page
    .getByRole("combobox", { name: "使用期限", exact: true })
    .selectOption("temporary");
  await page.getByLabel("预计归还日期", { exact: true }).fill("2030-03-04");
  await page
    .getByRole("button", { name: "保存并查看设备", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "设备详情", exact: true }),
  ).toBeVisible();
  expect(
    state.calls.filter((c) => c.name === "initialize_asset").at(-1)?.body
      .placement,
  ).toEqual({
    holder_party_id: "00000000-0000-4000-8000-000000000103",
    responsible_person_id: "00000000-0000-4000-8000-000000000102",
    usage_kind: "temporary",
    known_on: null,
    due_on: "2030-03-04",
  });
  expect(state.authCalls.some((path) => path.includes("signup"))).toBe(false);
});

test("query failure stays distinct from an empty ledger and raw diagnostics are hidden", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  state.failList(true);
  await login(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("尚未登记设备。", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("private database diagnostic")).toHaveCount(0);
  state.failList(false);
  await page.getByRole("button", { name: "重新查询", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "SB-000001 · 示例打印机", exact: true }),
  ).toBeVisible();
});

test("revoked access removes records and rejects a late ledger response", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  await login(page);
  await expect(
    page.getByRole("link", { name: "SB-000001 · 示例打印机", exact: true }),
  ).toBeVisible();
  state.holdNextList();
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("正在读取台账…")).toBeVisible();
  state.disable();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("账号已停用，如需恢复，请联系管理员。"),
  ).toBeVisible();
  state.releaseList();
  await expect(
    page.getByRole("link", { name: "SB-000001 · 示例打印机", exact: true }),
  ).toHaveCount(0);
});
