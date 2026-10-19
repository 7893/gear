import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
  let holdParty = false;
  let releaseParty: (() => void) | undefined;
  let holdDetail = false;
  let releaseDetail: (() => void) | undefined;
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
  const createdParties = new Map<string, Party>();
  const partyEdits = new Map<string, Party>();
  const lifecycleEdits = new Map<string, Asset>();
  const partyHistory: Record<string, unknown[]> = {};
  let maintenanceFailure = "";
  const extensions = new Map<string, Asset>();
  const conditionChanges = new Map<string, Asset>();
  const detailChanges = new Map<string, Asset>();
  let detailFailure = "";
  let holdUpdate = false;
  let releaseUpdate: (() => void) | undefined;
  const history: Record<string, unknown[]> = {};
  let extensionConflict = false;
  let conditionConflict = false;
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
      const resultItems = structuredClone(listResults ?? assets);
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
          items: resultItems,
          matched: resultItems.length,
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
    if (name === "list_parties")
      return route.fulfill({
        json: parties.filter((p) => p.is_active !== false),
      });
    if (name === "list_party_records")
      return route.fulfill({
        json: parties.map((p) => ({
          ...p,
          version: p.version || 1,
          is_active: p.is_active !== false,
          current_asset_count: assets.filter(
            (a) =>
              a.holder_party_id === p.id || a.responsible_person_id === p.id,
          ).length,
          default_team_count: parties.filter(
            (t) => t.default_responsible_id === p.id && t.is_active !== false,
          ).length,
        })),
      });
    if (name === "get_party") {
      const p = parties.find((p) => p.id === body.party_id)!;
      return route.fulfill({
        json: {
          party: {
            ...p,
            version: p.version || 1,
            is_active: p.is_active !== false,
          },
          history: partyHistory[p.id] || [],
        },
      });
    }
    if (name === "update_party") {
      if (maintenanceFailure)
        return route.fulfill({
          status: 400,
          json: { message: maintenanceFailure },
        });
      const key = String(body.request_id);
      let result = partyEdits.get(key);
      const p = parties.find((p) => p.id === body.party_id)!;
      if (!result) {
        const before = structuredClone(p);
        Object.assign(p, body.details, {
          is_active: body.active,
          version: (p.version || 1) + 1,
        });
        result = structuredClone(p);
        partyEdits.set(key, result);
        partyHistory[p.id] = [
          {
            id: "8",
            event_type: "party_updated",
            recorded_at: "2026-01-02T00:00:00Z",
            actor_label: "示例经办人",
            reason: body.reason,
            before_data: before,
            after_data: result,
          },
          ...(partyHistory[p.id] || []),
        ];
      }
      if (holdUpdate) {
        holdUpdate = false;
        await new Promise<void>((resolve) => (releaseUpdate = resolve));
      }
      if (uncertain) {
        uncertain = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: result });
    }
    if (name === "change_asset_lifecycle") {
      if (maintenanceFailure)
        return route.fulfill({
          status: 400,
          json: { message: maintenanceFailure },
        });
      const key = String(body.request_id);
      let result = lifecycleEdits.get(key);
      const asset = assets.find((a) => a.id === body.asset_id)!;
      if (!result) {
        const before = structuredClone(asset);
        const details = body.details as Record<string, string | null>;
        asset.management_status =
          body.action === "found"
            ? "managed"
            : body.action === "invalidate"
              ? "managed"
              : String(body.action);
        asset.version = (asset.version || 1) + 1;
        asset.holder_party_id =
          body.action === "found" ? details.holder_party_id : null;
        const holder = parties.find((p) => p.id === asset.holder_party_id);
        asset.holder_name = holder?.name || null;
        asset.holder_kind = holder?.kind || null;
        asset.responsible_person_id =
          body.action === "found" ? details.responsible_person_id : null;
        asset.responsible_name =
          parties.find((p) => p.id === asset.responsible_person_id)?.name ||
          null;
        asset.due_on = body.action === "found" ? details.due_on : null;
        asset.usage_kind = (
          body.action === "found" ? details.usage_kind : null
        ) as Asset["usage_kind"];
        if (body.action === "found") {
          asset.condition = details.condition as Asset["condition"];
          asset.location = details.location;
          asset.started_on = String(body.occurred_on);
        }
        if (body.action === "invalidate")
          asset.invalidated_at = "2026-01-02T00:00:00Z";
        asset.display_status =
          asset.management_status === "managed"
            ? asset.holder_party_id
              ? "in_use"
              : asset.condition === "normal"
                ? "inventory_available"
                : "inventory_faulty"
            : (asset.management_status as Asset["display_status"]);
        result = structuredClone(asset);
        lifecycleEdits.set(key, result);
        history[asset.id] = [
          {
            id: "10",
            event_type:
              body.action === "invalidate"
                ? "asset_invalidated"
                : "asset_" + String(body.action),
            occurred_on: body.occurred_on,
            recorded_at: "2026-01-02T00:00:00Z",
            actor_label: "示例管理员",
            reason: body.reason,
            before_data: before,
            after_data: result,
          },
          ...(history[asset.id] || []),
        ];
      }
      if (holdUpdate) {
        holdUpdate = false;
        await new Promise<void>((resolve) => (releaseUpdate = resolve));
      }
      if (uncertain) {
        uncertain = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: result });
    }
    if (name === "create_party") {
      const requestId = String(body.request_id);
      let created = createdParties.get(requestId);
      if (!created) {
        created = {
          ...(body.details as object),
          id:
            "00000000-0000-4000-8000-" +
            String(100 + parties.length).padStart(12, "0"),
        } as Party;
        parties.push(created);
        createdParties.set(requestId, created);
      }
      if (holdParty) {
        holdParty = false;
        await new Promise<void>((resolve) => (releaseParty = resolve));
      }
      if (uncertain) {
        uncertain = false;
        return route.abort("failed");
      }
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
      const asset = structuredClone(assets.find((a) => a.id === body.asset_id));
      if (holdDetail) {
        holdDetail = false;
        await new Promise<void>((resolve) => (releaseDetail = resolve));
      }
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
    if (name === "update_asset_details") {
      if (detailFailure)
        return route.fulfill({ status: 400, json: { message: detailFailure } });
      if (duplicate && !body.allow_legacy_duplicate)
        return route.fulfill({
          status: 400,
          json: { message: "legacy_code_duplicate" },
        });
      let result = detailChanges.get(String(body.request_id));
      const asset = assets.find((a) => a.id === body.asset_id)!;
      if (!result) {
        const before = structuredClone(asset);
        Object.assign(asset, body.details);
        asset.version = (asset.version || 1) + 1;
        result = structuredClone(asset);
        detailChanges.set(String(body.request_id), result);
        history[asset.id] = [
          {
            id: "9",
            event_type: "asset_updated",
            occurred_on: "2030-01-02",
            recorded_at: "2030-01-02T00:00:00Z",
            actor_label: "示例经办人",
            reason: body.reason,
            after_data: { ...result, previous_details: before },
          },
          ...(history[asset.id] || []),
        ];
      }
      if (holdUpdate) {
        holdUpdate = false;
        await new Promise<void>((resolve) => (releaseUpdate = resolve));
      }
      if (uncertain) {
        uncertain = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: result });
    }
    if (name === "change_asset_condition") {
      if (conditionConflict)
        return route.fulfill({
          status: 400,
          json: { message: "asset_condition_conflict" },
        });
      let result = conditionChanges.get(String(body.request_id));
      const asset = assets.find((a) => a.id === body.asset_id)!;
      if (!result) {
        asset.condition = body.target_condition as Asset["condition"];
        asset.display_status = asset.holder_party_id
          ? "in_use"
          : asset.condition === "faulty"
            ? "inventory_faulty"
            : "inventory_available";
        asset.version = (asset.version || 1) + 1;
        result = structuredClone(asset);
        conditionChanges.set(String(body.request_id), result);
        history[asset.id] = [
          {
            id: String(asset.version),
            event_type:
              asset.condition === "faulty"
                ? "asset_fault_reported"
                : "asset_repaired",
            occurred_on: body.occurred_on,
            recorded_at: "2030-01-01T00:00:00Z",
            actor_label: "示例经办人",
            reason: body.reason,
            after_data: result,
          },
          ...(history[asset.id] || []),
        ];
      }
      if (uncertain) {
        uncertain = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: result });
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
    parties,
    failMaintenance: (message: string) => (maintenanceFailure = message),
    conflictExtension: (value: boolean) => (extensionConflict = value),
    conflictCondition: (value: boolean) => (conditionConflict = value),
    filterResults: (items: Asset[] | undefined) => (listResults = items),
    failList: (value: boolean) => (listFailure = value),
    requireDuplicateAck: () => (duplicate = true),
    loseNextAcknowledgement: () => (uncertain = true),
    disable: () => (active = false),
    holdNextList: () => (hold = true),
    releaseList: () => release?.(),
    holdNextParty: () => (holdParty = true),
    releaseParty: () => releaseParty?.(),
    holdNextDetail: () => (holdDetail = true),
    releaseDetail: () => releaseDetail?.(),
    failDetails: (message: string) => (detailFailure = message),
    holdUpdate: () => (holdUpdate = true),
    releaseUpdate: () => releaseUpdate?.(),
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

async function openPartyEditor(page: Page, id = teamId) {
  await page.goto("/#/parties/" + id);
  await page
    .getByRole("button", { name: "修改资料或启用状态", exact: true })
    .click();
}
async function openLifecycle(page: Page) {
  await page.goto("/#/assets/" + assetId);
  await page
    .getByRole("button", { name: "办理遗失、报废或找回", exact: true })
    .click();
  return page.getByRole("region", { name: "设备退出与找回", exact: true });
}
async function loginReady(page: Page) {
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
}

test("recipient editor shares fields and retries identical updates without reassigning devices", async ({
  page,
}) => {
  const f = await fixture(page);
  await loginReady(page);
  const before = structuredClone(f.assets);
  await openPartyEditor(page);
  await expect(
    page.getByRole("combobox", { name: "对象类型", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("对象名称", { exact: true }).fill("示例更新团队");
  await page.getByLabel("联系方式", { exact: true }).fill("示例联系方式");
  await page.getByLabel("修改原因", { exact: true }).fill("示例核对团队资料");
  f.loseNextAcknowledgement();
  await page
    .getByRole("button", { name: "保存人员或团队", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("对象名称", { exact: true })).toHaveValue(
    "示例更新团队",
  );
  await page
    .getByRole("button", { name: "保存人员或团队", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "修改已记录" }),
  ).toBeVisible();
  const calls = f.calls.filter((c) => c.name === "update_party");
  expect(calls).toHaveLength(2);
  expect(calls[0].body).toEqual(calls[1].body);
  expect(f.assets).toEqual(before);
  await expect(
    page.getByText("示例团队 → 示例更新团队", { exact: false }),
  ).toBeVisible();
});

test("recipient disable and restore stay separate from equipment return", async ({
  page,
}) => {
  const f = await fixture(page);
  await loginReady(page);
  const before = structuredClone(f.assets);
  for (const active of ["false", "true"]) {
    await openPartyEditor(page);
    await page
      .getByRole("combobox", { name: "启用状态", exact: true })
      .selectOption(active);
    await page.getByLabel("修改原因", { exact: true }).fill("示例启用状态核对");
    await page
      .getByRole("button", { name: "保存人员或团队", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "修改已记录" }),
    ).toBeVisible();
    expect(f.assets).toEqual(before);
  }
  expect(f.parties.find((p) => p.id === teamId)?.is_active).toBe(true);
});

test("recipient version conflicts retain entered details and show actionable reason", async ({
  page,
}) => {
  const f = await fixture(page);
  await loginReady(page);
  await openPartyEditor(page);
  await page.getByLabel("对象名称", { exact: true }).fill("示例待核对团队");
  await page.getByLabel("修改原因", { exact: true }).fill("示例冲突检查");
  f.failMaintenance("party_conflict");
  await page
    .getByRole("button", { name: "保存人员或团队", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("资料已变化");
  await expect(page.getByLabel("对象名称", { exact: true })).toHaveValue(
    "示例待核对团队",
  );
});

test("recipient listing paginates, includes inactive records on request and stays read-only for viewers", async ({
  page,
}) => {
  const f = await fixture(page, "viewer");
  f.parties.push(
    ...Array.from({ length: 50 }, (_, i) => ({
      ...f.parties[0]!,
      id: String(i),
      name: "示例扩展人员" + i,
      is_active: i !== 0,
    })),
  );
  await loginReady(page);
  await page.goto("/#/parties");
  await expect(
    page.getByRole("navigation", { name: "人员与团队分页", exact: true }),
  ).toContainText("共 51 条");
  await page
    .getByRole("combobox", { name: "对象状态", exact: true })
    .selectOption("");
  await expect(
    page.getByRole("navigation", { name: "人员与团队分页", exact: true }),
  ).toContainText("共 52 条");
  await page.getByRole("button", { name: "末页", exact: true }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(13);
  await page.goto("/#/parties/" + teamId);
  await expect(
    page.getByRole("heading", { name: "人员或团队详情", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "修改资料或启用状态" }),
  ).toHaveCount(0);
  expect(
    f.calls.some((c) => c.name === "update_party" || c.name === "create_party"),
  ).toBe(false);
});

for (const operation of ["lost", "scrapped", "invalidate"] as const) {
  test(`administrator records ${operation} with explicit acknowledgement and stable retry`, async ({
    page,
  }) => {
    const f = await fixture(page, "admin");
    await loginReady(page);
    const region = await openLifecycle(page);
    await region
      .getByRole("combobox", { name: "处理类型", exact: true })
      .selectOption(operation);
    await region
      .getByLabel("处理原因", { exact: true })
      .fill("示例实际情况核对");
    const save = region.getByRole("button", { name: /^确认/ });
    await expect(save).toBeDisabled();
    await region.getByRole("checkbox").check();
    f.loseNextAcknowledgement();
    await save.click();
    await expect(region.getByRole("alert")).toBeVisible();
    await save.click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "已记录，内部编号和历史单据保留" }),
    ).toBeVisible();
    const writes = f.calls.filter((c) => c.name === "change_asset_lifecycle");
    expect(writes).toHaveLength(2);
    expect(writes[0].body).toEqual(writes[1].body);
    expect(f.assets[0].asset_code).toBe(base.asset_code);
    expect(f.assets[0].holder_party_id).toBeNull();
    if (operation !== "invalidate")
      await expect(
        page.getByText("退出前持有方：", { exact: false }),
      ).toBeVisible();
    else
      await expect(
        page.getByText("此建账记录已标记无效，保留历史供核对。", {
          exact: true,
        }),
      ).toBeVisible();
  });
}

test("recovered device requires fresh placement and supports faulty temporary team use", async ({
  page,
}) => {
  const f = await fixture(page, "admin");
  Object.assign(f.assets[0], {
    management_status: "lost",
    display_status: "lost",
    holder_party_id: null,
    responsible_person_id: null,
    holder_name: null,
    due_on: null,
  });
  await loginReady(page);
  const region = await openLifecycle(page);
  await expect(
    region.getByRole("combobox", { name: "当前持有情况", exact: true }),
  ).toHaveValue("inventory");
  await region
    .getByRole("combobox", { name: "找回时状况", exact: true })
    .selectOption("faulty");
  await region
    .getByRole("combobox", { name: "当前持有情况", exact: true })
    .selectOption("team");
  await region
    .getByRole("combobox", { name: "持有方", exact: true })
    .selectOption(teamId);
  await region
    .getByRole("combobox", { name: "使用期限", exact: true })
    .selectOption("temporary");
  await expect(region.getByLabel("预计归还日期", { exact: true })).toHaveValue(
    "",
  );
  await region.getByLabel("预计归还日期", { exact: true }).fill("2099-01-01");
  await region
    .getByLabel("处理原因", { exact: true })
    .fill("示例确认同一实物和新使用期限");
  await region.getByRole("checkbox").check();
  await region
    .getByRole("button", { name: "确认登记找回", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "登记找回已记录" }),
  ).toBeVisible();
  const details = f.calls.find((c) => c.name === "change_asset_lifecycle")!.body
    .details;
  expect(details).toMatchObject({
    condition: "faulty",
    holder_party_id: teamId,
    responsible_person_id: personId,
    usage_kind: "temporary",
    due_on: "2099-01-01",
  });
});

for (const role of ["operator", "viewer"]) {
  test(`${role} cannot open asset exit or recovery actions`, async ({
    page,
  }) => {
    const f = await fixture(page, role);
    await loginReady(page);
    await page.goto("/#/assets/" + assetId);
    await expect(
      page.getByRole("heading", { name: "设备详情", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "设备退出与找回", exact: true }),
    ).toHaveCount(0);
    expect(f.calls.some((c) => c.name === "change_asset_lifecycle")).toBe(
      false,
    );
  });
}

for (const feature of ["party", "lifecycle"]) {
  test(`late ${feature} update is discarded after account revocation`, async ({
    page,
  }) => {
    const f = await fixture(page, "admin");
    await loginReady(page);
    if (feature === "party") {
      await openPartyEditor(page);
      await page.getByLabel("对象名称", { exact: true }).fill("示例迟到资料");
      await page.getByLabel("修改原因", { exact: true }).fill("示例异步检查");
      f.holdUpdate();
      await page
        .getByRole("button", { name: "保存人员或团队", exact: true })
        .click();
    } else {
      const region = await openLifecycle(page);
      await region.getByLabel("处理原因", { exact: true }).fill("示例迟到处置");
      await region.getByRole("checkbox").check();
      f.holdUpdate();
      await region
        .getByRole("button", { name: "确认登记遗失", exact: true })
        .click();
    }
    await expect(
      page.getByRole("button", {
        name: feature === "party" ? "正在保存…" : "正在记录…",
        exact: true,
      }),
    ).toBeDisabled();
    f.disable();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByText("当前账号无法执行此操作，请登录或查看账号状态。", {
        exact: true,
      }),
    ).toBeVisible();
    const response = page.waitForResponse((r) =>
      r
        .url()
        .endsWith(
          "/rpc/" +
            (feature === "party" ? "update_party" : "change_asset_lifecycle"),
        ),
    );
    f.releaseUpdate();
    await (await response).finished();
    await expect(page.getByText("示例迟到资料", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("status").filter({ hasText: "已记录" }),
    ).toHaveCount(0);
  });
}

function paginationAssets() {
  return Array.from({ length: 51 }, (_, index) => ({
    ...structuredClone(base),
    id: "00000000-0000-4000-8000-" + String(1000 + index).padStart(12, "0"),
    asset_code: "SB-" + String(index + 1).padStart(6, "0"),
  }));
}

for (const role of ["admin", "operator", "viewer"]) {
  test(`${role} exports all filtered equipment instead of the current page using a fresh read`, async ({
    page,
  }) => {
    const state = await fixture(page, role);
    state.assets.splice(0, 1, ...paginationAssets());
    state.assets[0].legacy_code = "00007";
    state.assets[0].note = '=HYPERLINK("https://example.invalid")';
    await login(page);
    await expect(page.locator("tbody tr")).toHaveCount(20);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    const before = state.calls.filter((c) => c.name === "list_assets").length;
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^设备台账-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    const bytes = await readFile((await download.path())!);
    expect([...bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
    const csv = bytes.toString("utf8");
    expect(csv).toContain('"SB-000001","00007"');
    expect(csv).toContain('"SB-000051"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"');
    expect(csv).toContain('"临时使用","","2030-01-01"');
    expect(csv.split("\r\n")).toHaveLength(53);
    expect(state.calls.filter((c) => c.name === "list_assets")).toHaveLength(
      before + 1,
    );
    await expect(page.getByLabel("清单导出").getByRole("status")).toContainText(
      "51 条记录",
    );
    await expect(
      page.getByRole("navigation", { name: "设备分页" }).getByRole("status"),
    ).toContainText("第 2 / 3 页");

    // Filters changed without pressing query still apply to the export's fresh request.
    await page.getByLabel("搜索设备", { exact: true }).fill("新条件");
    await page
      .getByRole("combobox", { name: "分类", exact: true })
      .selectOption("printer");
    state.filterResults([state.assets[50]]);
    const filteredPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
    const filtered = (
      await readFile((await (await filteredPromise).path())!)
    ).toString("utf8");
    expect(filtered).toContain('"SB-000051"');
    expect(filtered).not.toContain('"SB-000001"');
    expect(state.calls.at(-1)).toEqual({
      name: "list_assets",
      body: {
        search: "新条件",
        category: "printer",
        state: null,
        holder_kind: null,
      },
    });
    expect(
      state.calls.every((c) =>
        ["get_my_membership", "list_assets"].includes(c.name),
      ),
    ).toBe(true);
  });
}

test("due export uses server business date and the selected state, including an empty result", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  state.assets.splice(
    0,
    1,
    ...paginationAssets().map((asset, i) => ({
      ...asset,
      due_on: i === 0 ? "2029-12-31" : "2030-01-01",
    })),
  );
  await login(page);
  await page.getByRole("link", { name: "临时使用与到期", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(20);
  await page
    .getByRole("combobox", { name: "到期情况", exact: true })
    .selectOption("today");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("临时使用清单-2030-01-01.csv");
  const csv = (await readFile((await download.path())!)).toString("utf8");
  expect(csv).not.toContain('"SB-000001"');
  expect(csv).toContain('"SB-000051"');
  expect(csv).toContain('"今天到期","2030-01-01","3"');
  expect(csv.split("\r\n")).toHaveLength(52);
  expect(state.calls.at(-1)).toEqual({
    name: "list_due_assets",
    body: { state: "today" },
  });
  await page
    .getByRole("combobox", { name: "到期情况", exact: true })
    .selectOption("later");
  const emptyPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const empty = (await readFile((await (await emptyPromise).path())!)).toString(
    "utf8",
  );
  expect(empty.split("\r\n")).toHaveLength(2);
  await expect(page.getByLabel("清单导出").getByRole("status")).toContainText(
    "0 条记录",
  );
});

test("failed exports show safe errors and revoked access discards a late export without downloading", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  let downloads = 0;
  page.on("download", () => downloads++);
  await login(page);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  state.failList(true);
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await expect(page.getByLabel("清单导出").getByRole("alert")).toContainText(
    "导出失败",
  );
  await expect(page.getByText("private database diagnostic")).toHaveCount(0);
  expect(downloads).toBe(0);
  state.failList(false);
  state.holdNextList();
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "正在导出…", exact: true }),
  ).toBeDisabled();
  state.disable();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("账号已停用，如需恢复，请联系管理员。"),
  ).toBeVisible();
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/rpc/list_assets"),
  );
  state.releaseList();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.getByRole("button", { name: "导出 CSV", exact: true }),
  ).toHaveCount(0);
  expect(downloads).toBe(0);
});

test("leaving a page discards its pending export", async ({ page }) => {
  const state = await fixture(page, "viewer");
  let downloads = 0;
  page.on("download", () => downloads++);
  await login(page);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  state.holdNextList();
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "正在导出…", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "临时使用与到期", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "临时使用与到期", exact: true }),
  ).toBeVisible();
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/rpc/list_assets"),
  );
  state.releaseList();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(downloads).toBe(0);
});

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

test("account actions keep consistent spacing and wrap without overlapping", async ({
  page,
}) => {
  await fixture(page, "admin");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "我的账号", exact: true }).click();
  const group = page.getByRole("group", { name: "账号操作", exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(
      group.getByRole("link", { name: "查看设备台账", exact: true }),
    ).toBeVisible();
    await expect(
      group.getByRole("link", { name: "管理使用申请", exact: true }),
    ).toBeVisible();
    const boxes = await group.locator("a, button").evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        };
      }),
    );
    expect(boxes).toHaveLength(3);
    for (let i = 1; i < boxes.length; i++) {
      const previous = boxes[i - 1]!,
        current = boxes[i]!;
      expect(
        current.left - previous.right >= 11.5 ||
          current.top - previous.bottom >= 11.5,
      ).toBe(true);
    }
  }
  await group
    .getByRole("button", { name: "刷新账号状态", exact: true })
    .click();
  await expect(group).toBeVisible();
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

test("fault and repair preserve assignment, retry after lost acknowledgement and retain history", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2030-01-02T00:00:00Z"));
  const state = await fixture(page);
  const original = structuredClone(state.assets[0]!);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/" + assetId);
  const form = page.getByRole("region", { name: "故障与维修", exact: true });
  await expect(
    form.getByRole("heading", { name: "登记故障", exact: true }),
  ).toBeVisible();
  await form.getByLabel("故障发生日期", { exact: true }).fill("2030-01-01");
  await form.getByLabel("故障说明", { exact: true }).fill("示例打印时卡纸");
  state.loseNextAcknowledgement();
  await form.getByRole("button", { name: "确认登记故障", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByLabel("故障说明", { exact: true })).toHaveValue(
    "示例打印时卡纸",
  );
  await form.getByRole("button", { name: "确认登记故障", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "故障已记录" }),
  ).toBeVisible();
  await expect(
    form.getByRole("heading", { name: "恢复正常", exact: true }),
  ).toBeVisible();
  expect(state.assets[0]!.version).toBe(2);
  const calls = state.calls.filter((c) => c.name === "change_asset_condition");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body).toEqual(calls[1]!.body);
  expect(calls[0]!.body).toMatchObject({
    asset_id: assetId,
    expected_version: 1,
    target_condition: "faulty",
    occurred_on: "2030-01-01",
    reason: "示例打印时卡纸",
  });
  await expect(
    form.getByLabel("恢复正常日期", { exact: true }),
  ).toHaveAttribute("min", "2030-01-01");
  await expect(
    form.getByLabel("恢复正常日期", { exact: true }),
  ).toHaveAttribute("max", "2030-01-02");
  await form.getByLabel("恢复正常日期", { exact: true }).fill("2030-01-02");
  await form
    .getByLabel("维修处理结果", { exact: true })
    .fill("示例清理进纸组件并试打正常");
  await form.getByRole("button", { name: "确认恢复正常", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "维修恢复已记录" }),
  ).toBeVisible();
  await expect(
    form.getByRole("heading", { name: "登记故障", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".asset-history")).toContainText("维修恢复正常");
  await expect(page.locator(".asset-history")).toContainText("示例打印时卡纸");
  await expect(page.locator(".asset-history")).toContainText(
    "示例清理进纸组件并试打正常",
  );
  const { version, ...current } = state.assets[0]!;
  const { version: initialVersion, ...before } = original;
  expect(version).toBe(initialVersion! + 2);
  expect(current).toEqual(before);
});

test("fault form rejects blank explanation and retains inputs on stale-version conflicts", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2030-01-02T00:00:00Z"));
  const state = await fixture(page);
  state.assets[0]!.last_flow_on = "2030-01-01";
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/" + assetId);
  const form = page.getByRole("region", { name: "故障与维修", exact: true });
  await expect(
    form.getByLabel("故障发生日期", { exact: true }),
  ).toHaveAttribute("min", "2030-01-01");
  await form.getByLabel("故障说明", { exact: true }).fill("  ");
  await form.getByRole("button", { name: "确认登记故障", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText(
    "请填写故障说明或维修结果",
  );
  expect(
    state.calls.filter((c) => c.name === "change_asset_condition"),
  ).toHaveLength(0);
  state.conflictCondition(true);
  await form.getByLabel("故障说明", { exact: true }).fill("示例电源故障");
  await form.getByRole("button", { name: "确认登记故障", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("设备情况已变化");
  await expect(form.getByLabel("故障说明", { exact: true })).toHaveValue(
    "示例电源故障",
  );
  await page.getByRole("button", { name: "刷新设备情况", exact: true }).click();
  await expect(form.getByLabel("故障说明", { exact: true })).toHaveValue("");
  expect(state.assets[0]!.condition).toBe("normal");
});

test("fault actions require current write access and a managed valid asset", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  state.assets[0]!.management_status = "returned_upstream";
  await page.goto("/#/assets/" + assetId);
  await expect(
    page.getByRole("heading", { name: "设备详情", exact: true }),
  ).toBeVisible();
  const form = page.getByRole("region", { name: "故障与维修", exact: true });
  await expect(form).toHaveCount(0);
  state.assets[0]!.management_status = "managed";
  state.assets[0]!.invalidated_at = "2030-01-01T00:00:00Z";
  await page.getByRole("button", { name: "刷新设备情况", exact: true }).click();
  await expect(
    page.getByText("此建账记录已标记无效，保留历史供核对。", { exact: true }),
  ).toBeVisible();
  await expect(form).toHaveCount(0);
  state.assets[0]!.invalidated_at = null;
  await page.getByRole("button", { name: "刷新设备情况", exact: true }).click();
  await expect(form).toBeVisible();
  state.disable();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(form).toHaveCount(0);
  expect(
    state.calls.filter((c) => c.name === "change_asset_condition"),
  ).toHaveLength(0);
});

test("viewer can read fault history without repair controls", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  state.assets[0]!.condition = "faulty";
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/" + assetId);
  await expect(
    page.getByRole("heading", { name: "设备详情", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".asset-fields")).toContainText("使用中 / 故障");
  await expect(
    page.getByRole("region", { name: "故障与维修", exact: true }),
  ).toHaveCount(0);
  expect(
    state.calls.filter((c) => c.name === "change_asset_condition"),
  ).toHaveLength(0);
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
  await page.getByText("新增个人或团队", { exact: true }).click();
  await page.getByLabel("对象名称", { exact: true }).fill("示例借调人员");
  await page
    .getByRole("combobox", { name: "人员类型", exact: true })
    .selectOption("seconded");
  await page.getByRole("button", { name: "新增接收对象", exact: true }).click();
  await expect(page.getByText("已新增接收对象，请选择后继续。")).toBeVisible();
  await page
    .getByRole("combobox", { name: "对象类型", exact: true })
    .selectOption("team");
  await page.getByLabel("对象名称", { exact: true }).fill("示例新团队");
  await page
    .getByRole("combobox", { name: "团队默认负责人", exact: true })
    .selectOption({ label: "示例借调人员" });
  await page.getByRole("button", { name: "新增接收对象", exact: true }).click();
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

test("shared receiver form works without flows and retries the original request", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await page.getByRole("link", { name: "登记已有设备", exact: true }).click();
  await page.getByText("新增个人或团队", { exact: true }).click();
  await page.getByLabel("对象名称", { exact: true }).fill("示例临时人员");
  state.loseNextAcknowledgement();
  await page.getByRole("button", { name: "新增接收对象", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("对象名称", { exact: true })).toHaveValue(
    "示例临时人员",
  );
  await page.getByRole("button", { name: "新增接收对象", exact: true }).click();
  await expect(
    page.getByText("已新增接收对象，请选择后继续。", { exact: true }),
  ).toBeVisible();
  const calls = state.calls.filter((c) => c.name === "create_party");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body).toEqual(calls[1]!.body);
  await expect(
    page.getByRole("combobox", { name: "持有方", exact: true }),
  ).toHaveValue("00000000-0000-4000-8000-000000000102");
  await expect(
    page
      .getByRole("combobox", { name: "持有方", exact: true })
      .getByRole("option", { name: "示例临时人员", exact: true }),
  ).toHaveCount(1);
  expect(state.calls.filter((c) => c.name.endsWith("document"))).toHaveLength(
    0,
  );
});

test("pending receiver creation blocks asset save and cannot restore a form after access loss", async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await page.getByRole("link", { name: "登记已有设备", exact: true }).click();
  await page.getByText("新增个人或团队", { exact: true }).click();
  await page.getByLabel("对象名称", { exact: true }).fill("示例迟到人员");
  state.holdNextParty();
  await page.getByRole("button", { name: "新增接收对象", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "添加中…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存并查看设备", exact: true }),
  ).toBeDisabled();
  state.disable();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("当前账号无法执行此操作，请登录或查看账号状态。", {
      exact: true,
    }),
  ).toBeVisible();
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/rpc/create_party"),
  );
  state.releaseParty();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    page.getByText("已新增接收对象，请选择后继续。", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("对象名称", { exact: true })).toHaveCount(0);
  expect(state.calls.filter((c) => c.name === "initialize_asset")).toHaveLength(
    0,
  );
});

test("permission refresh loads a new query and discards the older in-flight ledger", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  await login(page);
  await expect(
    page.getByRole("link", { name: "SB-000001 · 示例打印机", exact: true }),
  ).toBeVisible();
  state.holdNextList();
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("正在读取台账…", { exact: true })).toBeVisible();
  state.filterResults([
    {
      ...base,
      id: newAssetId,
      name: "示例新查询结果",
      asset_code: "SB-000002",
    },
  ]);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const fresh = page.getByRole("link", {
    name: "SB-000002 · 示例新查询结果",
    exact: true,
  });
  await expect(fresh).toBeVisible();
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/rpc/list_assets"),
  );
  state.releaseList();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(fresh).toBeVisible();
  await expect(
    page.getByRole("link", { name: "SB-000001 · 示例打印机", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("正在读取台账…", { exact: true })).toHaveCount(0);
});

test("switching device routes discards the previous detail response", async ({
  page,
}) => {
  const state = await fixture(page, "viewer");
  state.assets.push({
    ...base,
    id: newAssetId,
    asset_code: "SB-000002",
    name: "示例第二台设备",
  });
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  state.holdNextDetail();
  await page.goto("/#/assets/" + assetId);
  await expect(page.getByText("正在读取设备…", { exact: true })).toBeVisible();
  await page.goto("/#/assets/" + newAssetId);
  const fresh = page.getByRole("heading", {
    name: "SB-000002 · 示例第二台设备",
    exact: true,
  });
  await expect(fresh).toBeVisible();
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/rpc/get_asset"),
  );
  state.releaseDetail();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(fresh).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "SB-000001 · 示例打印机", exact: true }),
  ).toHaveCount(0);
  await page.goto("/#/assets");
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  expect(
    state.calls
      .filter((c) => c.name === "get_asset")
      .every((c) => [assetId, newAssetId].includes(String(c.body.asset_id))),
  ).toBe(true);
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

for (const role of ["admin", "operator"]) {
  test(`${role} corrects shared equipment fields with audited history and a stable retry request`, async ({
    page,
  }) => {
    const f = await fixture(page, role);
    const before = structuredClone(f.assets[0]);
    await login(page);
    await expect(
      page.getByRole("heading", { name: "设备台账", exact: true }),
    ).toBeVisible();
    await page.goto("/#/assets/" + assetId);
    const region = page.getByRole("region", {
      name: "设备资料更正",
      exact: true,
    });
    await region
      .getByRole("button", { name: "更正基本资料", exact: true })
      .click();
    await expect(region.getByLabel("原资产编号", { exact: true })).toHaveValue(
      "00001-A",
    );
    await expect(region.getByLabel("设备状况", { exact: true })).toHaveCount(0);
    await expect(
      region.getByLabel("当前持有情况", { exact: true }),
    ).toHaveCount(0);
    await region
      .getByLabel("设备名称", { exact: true })
      .fill("示例核对后的打印机");
    await region.getByLabel("原资产编号", { exact: true }).fill("000007/旧");
    await region.getByLabel("型号", { exact: true }).fill("示例型号甲");
    await region
      .getByLabel("设备备注", { exact: true })
      .fill("<script>示例原样备注</script>");
    await region.getByLabel("更正原因", { exact: true }).fill("示例核对铭牌");
    f.loseNextAcknowledgement();
    await region
      .getByRole("button", { name: "保存资料更正", exact: true })
      .click();
    await expect(region.getByRole("alert")).toBeVisible();
    await expect(region.getByLabel("设备名称", { exact: true })).toHaveValue(
      "示例核对后的打印机",
    );
    await region
      .getByRole("button", { name: "保存资料更正", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "设备资料更正已记录" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "SB-000001 · 示例核对后的打印机",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".asset-history")).toContainText(
      "设备名称：示例打印机 → 示例核对后的打印机",
    );
    await expect(page.locator(".asset-history")).toContainText(
      "原资产编号：00001-A → 000007/旧",
    );
    await expect(page.locator(".asset-history")).toContainText(
      "<script>示例原样备注</script>",
    );
    expect(
      await page.evaluate(
        () => document.querySelectorAll(".asset-history script").length,
      ),
    ).toBe(0);
    const writes = f.calls.filter((c) => c.name === "update_asset_details");
    expect(writes).toHaveLength(2);
    expect(writes[0].body).toEqual(writes[1].body);
    expect(Object.keys(writes[0].body.details as object).sort()).toEqual([
      "brand",
      "category",
      "legacy_code",
      "location",
      "model",
      "name",
      "note",
      "serial_number",
    ]);
    for (const key of [
      "holder_party_id",
      "responsible_person_id",
      "usage_kind",
      "started_on",
      "due_on",
      "condition",
      "asset_code",
    ] as const)
      expect(f.assets[0][key]).toBe(before[key]);
    expect(f.assets[0].version).toBe(2);
  });
}

test("equipment correction retains duplicate acknowledgement boundaries and conflicted inputs", async ({
  page,
}) => {
  const f = await fixture(page);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/" + assetId);
  const region = page.getByRole("region", {
    name: "设备资料更正",
    exact: true,
  });
  await region
    .getByRole("button", { name: "更正基本资料", exact: true })
    .click();
  await region.getByLabel("设备名称", { exact: true }).fill("示例待核对资料");
  await region
    .getByLabel("更正原因", { exact: true })
    .fill("示例重复旧编号核对");
  f.requireDuplicateAck();
  await region
    .getByRole("button", { name: "保存资料更正", exact: true })
    .click();
  await expect(region.getByRole("alert")).toContainText("相同旧编号");
  await expect(
    region.getByRole("button", { name: "保存资料更正", exact: true }),
  ).toBeDisabled();
  await region.getByRole("checkbox").check();
  await region.getByLabel("原资产编号", { exact: true }).fill("000009");
  await expect(region.getByRole("checkbox")).toHaveCount(0);
  await region
    .getByRole("button", { name: "保存资料更正", exact: true })
    .click();
  await expect(region.getByRole("checkbox")).toBeVisible();
  await region.getByRole("checkbox").check();
  for (const message of ["asset_details_conflict", "asset_details_unchanged"]) {
    f.failDetails(message);
    await region
      .getByRole("button", { name: "保存资料更正", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText(
      message === "asset_details_conflict"
        ? "设备资料或流转情况已变化"
        : "设备资料没有变化",
    );
    await expect(region.getByLabel("设备名称", { exact: true })).toHaveValue(
      "示例待核对资料",
    );
  }
  f.failDetails("");
  await region
    .getByRole("button", { name: "保存资料更正", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "SB-000001 · 示例待核对资料",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    f.calls.filter((c) => c.name === "update_asset_details").at(-1)?.body
      .allow_legacy_duplicate,
  ).toBe(true);
});

for (const mode of ["viewer", "invalidated"]) {
  test(`${mode} cannot open equipment correction`, async ({ page }) => {
    const f = await fixture(page, mode === "viewer" ? "viewer" : "admin");
    if (mode === "invalidated")
      f.assets[0].invalidated_at = "2030-01-01T00:00:00Z";
    await login(page);
    await expect(
      page.getByRole("heading", { name: "设备台账", exact: true }),
    ).toBeVisible();
    await page.goto("/#/assets/" + assetId);
    await expect(
      page.getByRole("heading", { name: "设备详情", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "设备资料更正", exact: true }),
    ).toHaveCount(0);
    expect(f.calls.some((c) => c.name === "update_asset_details")).toBe(false);
  });
}

test("exited equipment permits descriptive correction without reopening management", async ({
  page,
}) => {
  const f = await fixture(page, "admin");
  f.assets[0].management_status = "scrapped";
  f.assets[0].display_status = "scrapped";
  f.assets[0].holder_party_id = null;
  await login(page);
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
  await page.goto("/#/assets/" + assetId);
  const region = page.getByRole("region", {
    name: "设备资料更正",
    exact: true,
  });
  await region
    .getByRole("button", { name: "更正基本资料", exact: true })
    .click();
  await region.getByLabel("型号", { exact: true }).fill("示例历史型号");
  await region.getByLabel("更正原因", { exact: true }).fill("示例核对历史铭牌");
  await region
    .getByRole("button", { name: "保存资料更正", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "设备资料更正已记录" }),
  ).toBeVisible();
  expect(f.assets[0].management_status).toBe("scrapped");
});

for (const cause of ["revoked", "route changed"]) {
  test(`late equipment correction response is discarded when ${cause}`, async ({
    page,
  }) => {
    const f = await fixture(page);
    await login(page);
    await expect(
      page.getByRole("heading", { name: "设备台账", exact: true }),
    ).toBeVisible();
    await page.goto("/#/assets/" + assetId);
    const region = page.getByRole("region", {
      name: "设备资料更正",
      exact: true,
    });
    await region
      .getByRole("button", { name: "更正基本资料", exact: true })
      .click();
    await region
      .getByLabel("设备名称", { exact: true })
      .fill("示例后台已保存但响应未到");
    await region.getByLabel("更正原因", { exact: true }).fill("示例异步核对");
    f.holdUpdate();
    await region
      .getByRole("button", { name: "保存资料更正", exact: true })
      .click();
    await expect(
      region.getByRole("button", { name: "正在保存…", exact: true }),
    ).toBeDisabled();
    if (cause === "revoked") {
      f.disable();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByText("当前账号无法执行此操作，请登录或查看账号状态。"),
      ).toBeVisible();
    } else {
      await page
        .getByRole("link", { name: "返回设备台账", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "设备台账", exact: true }),
      ).toBeVisible();
    }
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/rpc/update_asset_details"),
    );
    f.releaseUpdate();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.getByText("设备资料更正已记录，原单快照和持有关系保持不变。", {
        exact: true,
      }),
    ).toHaveCount(0);
  });
}
