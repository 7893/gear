import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  blankDetails,
  type FlowDocument,
  type FlowItem,
} from "../src/flows-model.js";
import type { Asset, Party } from "../src/inventory-model.js";

const api = "https://api.example.invalid";
const id = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const person: Party = {
  id: id(11),
  kind: "person",
  name: "示例人员",
  person_type: "seconded",
  organization_name: "示例单位",
  default_responsible_id: null,
  note: null,
};
const team: Party = {
  id: id(12),
  kind: "team",
  name: "示例团队",
  person_type: null,
  organization_name: null,
  default_responsible_id: person.id,
  note: null,
};
const nextPerson: Party = { ...person, id: id(13), name: "示例新负责人" };
function asset(n: number, held = false): Asset {
  return {
    id: id(100 + n),
    version: 2,
    asset_code: "SB-" + String(n).padStart(6, "0"),
    name: "Item " + String(n).padStart(3, "0"),
    category: "printer",
    condition: "normal",
    legacy_code: "0000" + n,
    serial_number: null,
    brand: "示例品牌",
    model: "示例型号",
    location: "示例位置",
    note: null,
    management_status: "managed",
    display_status: held ? "in_use" : "inventory_available",
    invalidated_at: null,
    holder_party_id: held ? team.id : null,
    holder_kind: held ? "team" : null,
    holder_name: held ? team.name : null,
    responsible_person_id: held ? person.id : null,
    responsible_name: held ? person.name : null,
    usage_kind: held ? "temporary" : null,
    started_on: held ? "2020-01-01" : null,
    due_on: held ? "2030-01-01" : null,
    followup_name: held ? "示例经办人" : null,
    last_flow_on: "2020-01-01",
    created_at: "2020-01-01T00:00:00Z",
  };
}
function document(
  status: "draft" | "confirmed" | "voided" = "confirmed",
  count = 2,
): FlowDocument {
  return {
    ...blankDetails("issue"),
    id: id(50),
    created_by: id(1),
    version: 3,
    kind: "issue",
    handover_on: "2020-01-01",
    from_kind: "inventory",
    to_kind: "party",
    from_label: "经办人库存",
    to_label: "冻结的示例团队",
    sender_name: "示例移交人",
    receiver_name: "示例接收人",
    to_party_id: team.id,
    to_person_id: person.id,
    usage_kind: "temporary",
    due_on: "2030-01-01",
    status,
    document_no: status === "draft" ? null : "FF-20200101-0001",
    created_at: "2020-01-01T00:00:00Z",
    confirmed_at: status === "draft" ? null : "2020-01-01T00:00:00Z",
    header_snapshot: status === "draft" ? null : { title: "冻结的示例抬头" },
    parties_snapshot:
      status === "draft"
        ? null
        : {
            from_label: "经办人库存",
            to_label: "冻结的示例团队",
            sender_name: "示例移交人",
            receiver_name: "示例接收人",
            from_responsible_name: null,
            to_responsible_name: "冻结的示例负责人",
            handover_on: "2020-01-01",
            usage_kind: "temporary",
            due_on: "2030-01-01",
          },
    evidence_state: status === "draft" ? null : "awaiting_upload",
    remarks: "示例备注",
    void_reason: status === "voided" ? "示例作废" : null,
    items: Array.from({ length: count }, (_, index) => ({
      id: id(200 + index),
      line_no: index + 1,
      asset_id: id(101 + index),
      expected_asset_version: 2,
      new_asset_data: null,
      condition_on_handover: "normal",
      location: "示例位置",
      note: "示例交接说明",
      allow_legacy_duplicate: false,
      asset_snapshot: status === "draft" ? null : asset(index + 1),
      state_before: null,
      state_after: null,
    })),
  };
}
async function fixture(
  page: Page,
  role = "operator",
  enabled: boolean | null = true,
) {
  let active = true;
  let uncertain = false;
  let hold = false;
  let release: (() => void) | undefined;
  let saved = document();
  let saveFailure = false;
  let saveUncertain = false;
  let confirmConflict = false;
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const stock = [asset(1), asset(2), asset(3, true), asset(4, true)];
  const confirmations = new Map<string, FlowDocument>();
  await page.route("**/runtime-config.json", (route) =>
    route.fulfill({
      json: {
        apiUrl: api,
        databaseSchema: "example_app_2026",
        publishableKey: "sb_publishable_example",
        accountsEnabled: true,
        inventoryEnabled: true,
        ...(enabled === null ? {} : { flowsEnabled: enabled }),
      },
    }),
  );
  await page.route(api + "/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const user = {
      id: id(1),
      email: "operator@example.invalid",
      email_confirmed_at: "2020-01-01T00:00:00Z",
      user_metadata: {},
      app_metadata: {},
      aud: "authenticated",
      role: "authenticated",
    };
    if (path === "/auth/v1/token") {
      const encode = (v: unknown) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      return route.fulfill({
        json: {
          access_token: [
            encode({ alg: "HS256" }),
            encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
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
            id: user.id,
            display_name: "示例经办人",
            status: active ? "active" : "disabled",
            role: active ? role : null,
            version: 1,
            review_note: null,
          },
        },
      });
    if (name === "list_parties")
      return route.fulfill({ json: [person, nextPerson, team] });
    if (name === "list_assets")
      return route.fulfill({
        json: {
          items: stock,
          matched: 4,
          summary: {
            total: 4,
            inventory_available: 2,
            inventory_faulty: 0,
            in_use: 2,
            managed_faulty: 0,
            returned_upstream: 0,
            lost: 0,
            scrapped: 0,
          },
        },
      });
    if (name === "list_documents")
      return route.fulfill({
        json: [{ ...saved, item_count: saved.items.length }],
      });
    if (name === "get_document") {
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      return route.fulfill({ json: saved });
    }
    if (name === "save_document") {
      if (saveFailure)
        return route.fulfill({
          status: 409,
          json: { message: "document_conflict" },
        });
      const details = body.details as FlowDocument;
      const items = body.items as FlowItem[];
      saved = {
        ...document("draft", 0),
        ...details,
        version: body.expected_version ? Number(body.expected_version) + 1 : 1,
        items: items.map((item, index) => ({
          ...item,
          id: id(200 + index),
          line_no: index + 1,
          asset_snapshot: null,
          state_before: null,
          state_after: null,
        })),
      };
      if (saveUncertain) {
        saveUncertain = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: saved });
    }
    if (name === "confirm_document") {
      if (confirmConflict)
        return route.fulfill({
          status: 409,
          json: {
            message: "asset_flow_conflict",
            details: JSON.stringify({ asset_code: "SB-000001" }),
          },
        });
      const key = String(body.request_id);
      if (!confirmations.has(key)) {
        saved = {
          ...saved,
          status: "confirmed",
          version: saved.version + 1,
          document_no:
            { receipt: "LR", issue: "FF", transfer: "ZJ", return: "TH" }[
              saved.kind
            ] + "-20200101-0002",
          confirmed_at: "2020-01-01T00:00:00Z",
          header_snapshot: { title: "冻结的示例抬头" },
          parties_snapshot: {
            ...document().parties_snapshot!,
            sender_name: saved.sender_name,
            receiver_name: saved.receiver_name,
            from_label: saved.from_label,
            to_label: saved.to_label,
            from_responsible_name:
              [person, nextPerson].find((p) => p.id === saved.from_person_id)
                ?.name || null,
            to_responsible_name:
              [person, nextPerson].find((p) => p.id === saved.to_person_id)
                ?.name || null,
            transfer_mode: saved.transfer_mode,
            usage_kind: saved.usage_kind,
            due_on: saved.due_on,
          },
          items: saved.items.map((item, index) => ({
            ...item,
            asset_snapshot: stock.find((a) => a.id === item.asset_id) || {
              ...asset(index + 10),
              ...item.new_asset_data,
            },
          })),
        };
        confirmations.set(key, structuredClone(saved));
      }
      if (uncertain) {
        uncertain = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: confirmations.get(key) });
    }
    if (name === "delete_document")
      return route.fulfill({ json: { deleted: true, id: saved.id } });
    throw new Error("Unexpected flow RPC: " + name);
  });
  return {
    calls,
    stock,
    setDocument: (value: FlowDocument) => (saved = value),
    loseAcknowledgement: () => (uncertain = true),
    loseSaveAcknowledgement: () => (saveUncertain = true),
    conflictConfirmation: () => (confirmConflict = true),
    failSave: () => (saveFailure = true),
    disable: () => (active = false),
    holdDetail: () => (hold = true),
    releaseDetail: () => release?.(),
  };
}
async function login(page: Page) {
  await page.goto("/#/login");
  await page
    .getByLabel("邮箱", { exact: true })
    .fill("operator@example.invalid");
  await page.getByLabel("密码", { exact: true }).fill("fictional-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设备台账", exact: true }),
  ).toBeVisible();
}
async function identities(page: Page) {
  await page.getByLabel("实际交接日期", { exact: true }).fill("2020-01-01");
  await page.getByLabel("实际移交人", { exact: true }).fill("示例移交人");
  await page.getByLabel("实际接收人", { exact: true }).fill("示例接收人");
}

test("missing flag keeps all new routes closed without document requests", async ({
  page,
}) => {
  const f = await fixture(page, "operator", null);
  await login(page);
  await page.goto("/#/documents/new?kind=receipt");
  await expect(
    page.getByText("流转办理与单据尚未开放。", { exact: true }),
  ).toBeVisible();
  expect(
    f.calls.some(
      (c) => c.name.endsWith("document") || c.name === "list_documents",
    ),
  ).toBe(false);
});
test("viewer reads frozen formal snapshot, escaped notes and QR but cannot open a write form", async ({
  page,
}) => {
  const f = await fixture(page, "viewer");
  const doc = document();
  doc.items[0].note = "<script>window.unsafe = true</script>";
  f.setDocument(doc);
  await login(page);
  await page.goto("/#/documents/" + id(50));
  await expect(page.getByText("冻结的示例抬头", { exact: true })).toBeVisible();
  await expect(page.getByText(/冻结的示例团队/)).toBeVisible();
  await expect(
    page.getByRole("img", { name: "单据匹配二维码" }),
  ).toHaveAttribute("viewBox", /^0 0 [0-9]+ [0-9]+$/);
  await expect(
    page.getByText("交接：<script>window.unsafe = true</script>", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => "unsafe" in window)).toBe(false);
  expect(f.calls.filter((c) => c.name === "list_assets")).toHaveLength(1); // Home ledger only; formal detail uses snapshots.
  await expect(
    page.getByRole("button", { name: "删除草稿", exact: true }),
  ).toHaveCount(0);
  await page.goto("/#/documents/new?kind=issue");
  await expect(
    page.getByText("当前账号无法执行此操作，请登录或查看账号状态。", {
      exact: true,
    }),
  ).toBeVisible();
});
test("batch receipt expands distinct items and retains confirmation request after lost acknowledgement", async ({
  page,
}) => {
  const f = await fixture(page);
  await login(page);
  await page.goto("/#/documents/new?kind=receipt");
  await identities(page);
  await page.getByLabel("来源单位或交付方", { exact: true }).fill("示例交付方");
  await page.getByLabel("批量设备名称", { exact: true }).fill("示例电插板");
  await page
    .getByRole("combobox", { name: "批量设备分类", exact: true })
    .selectOption("power_strip");
  await page.getByLabel("数量", { exact: true }).fill("2");
  await page
    .getByRole("combobox", { name: "批量实际状况", exact: true })
    .selectOption("normal");
  await page
    .getByRole("button", { name: "展开为逐件明细", exact: true })
    .click();
  await page.getByLabel("原资产编号", { exact: true }).first().fill("00007/A");
  await page
    .getByRole("button", { name: "保存并核对交接", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "交接确认" })).toBeVisible();
  f.loseAcknowledgement();
  await page.getByRole("button", { name: "确认实际交接", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "确认实际交接", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "单据详情", exact: true }),
  ).toBeVisible();
  const saves = f.calls.filter((c) => c.name === "save_document");
  expect(saves).toHaveLength(1);
  expect(
    (saves[0].body.items as FlowItem[]).map(
      (i) => i.new_asset_data?.legacy_code,
    ),
  ).toEqual(["00007/A", ""]);
  const confirmations = f.calls.filter((c) => c.name === "confirm_document");
  expect(confirmations).toHaveLength(2);
  expect(confirmations[0].body).toEqual(confirmations[1].body);
});
test("team temporary issue saves per-asset versions and explicit responsibility", async ({
  page,
}) => {
  const f = await fixture(page);
  await login(page);
  await page.goto("/#/documents/new?kind=issue");
  await identities(page);
  await page
    .getByRole("combobox", { name: "接收对象", exact: true })
    .selectOption(team.id);
  await expect(
    page.getByRole("combobox", { name: "接收负责人", exact: true }),
  ).toHaveValue(person.id);
  await page
    .getByRole("combobox", { name: "使用方式", exact: true })
    .selectOption("temporary");
  await page.getByLabel("预计归还日期", { exact: true }).fill("2030-01-01");
  await page.getByRole("checkbox", { name: /SB-000001/ }).check();
  await page.getByRole("checkbox", { name: /SB-000002/ }).check();
  await page
    .getByRole("button", { name: "保存并核对交接", exact: true })
    .click();
  const call = f.calls.find((c) => c.name === "save_document")!;
  expect(call.body.details).toMatchObject({
    to_party_id: team.id,
    to_person_id: person.id,
    usage_kind: "temporary",
    due_on: "2030-01-01",
  });
  expect(
    (call.body.items as FlowItem[]).map((i) => i.expected_asset_version),
  ).toEqual([2, 2]);
  await expect(page.getByRole("region", { name: "交接确认" })).toContainText(
    "2 件",
  );
  f.conflictConfirmation();
  await page.getByRole("button", { name: "确认实际交接", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("设备 SB-000001");
  await expect(page.getByRole("region", { name: "交接确认" })).toBeVisible();
});

test("ordinary transfer uses held normal equipment and a new recipient and deadline", async ({
  page,
}) => {
  const f = await fixture(page);
  f.stock[3].condition = "faulty";
  await login(page);
  await page.goto("/#/flows");
  await page.getByRole("link", { name: "新建转交单", exact: true }).click();
  await identities(page);
  await page
    .getByRole("combobox", { name: "当前持有方", exact: true })
    .selectOption(team.id);
  await expect(
    page.getByRole("combobox", { name: "交出负责人", exact: true }),
  ).toHaveValue(person.id);
  await expect(page.getByRole("checkbox", { name: /SB-000001/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole("checkbox", { name: /SB-000004/ })).toHaveCount(
    0,
  );
  await page
    .getByRole("combobox", { name: "接收对象", exact: true })
    .selectOption(nextPerson.id);
  await page
    .getByRole("combobox", { name: "使用方式", exact: true })
    .selectOption("temporary");
  await page.getByLabel("预计归还日期", { exact: true }).fill("2031-01-01");
  await page.getByRole("checkbox", { name: /SB-000003/ }).check();
  await expect(
    page.getByRole("combobox", { name: "实际交接状况", exact: true }),
  ).toHaveValue("normal");
  await page
    .getByRole("button", { name: "保存并核对交接", exact: true })
    .click();
  const call = f.calls.find((c) => c.name === "save_document")!;
  expect(call.body.details).toMatchObject({
    kind: "transfer",
    transfer_mode: "holder",
    from_kind: "party",
    to_kind: "party",
    from_party_id: team.id,
    from_person_id: person.id,
    to_party_id: nextPerson.id,
    to_person_id: nextPerson.id,
    usage_kind: "temporary",
    due_on: "2031-01-01",
  });
  expect((call.body.items as FlowItem[]).map((i) => i.asset_id)).toEqual([
    id(103),
  ]);
  f.loseAcknowledgement();
  await page.getByRole("button", { name: "确认实际交接", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "确认实际交接", exact: true }).click();
  await expect(page.getByRole("article", { name: "交接单据" })).toContainText(
    "ZJ-20200101-0002",
  );
  const confirmations = f.calls.filter((c) => c.name === "confirm_document");
  expect(confirmations).toHaveLength(2);
  expect(confirmations[0].body).toEqual(confirmations[1].body);
});

test("same-team responsibility includes faults and keeps mixed individual deadlines visible", async ({
  page,
}) => {
  const f = await fixture(page);
  f.stock[2].due_on = "2019-12-31";
  f.stock[2].started_on = null;
  f.stock[3].condition = "faulty";
  await login(page);
  await page.goto("/#/documents/new?kind=transfer");
  await identities(page);
  await page
    .getByRole("combobox", { name: "转交方式", exact: true })
    .selectOption("responsibility");
  await page
    .getByRole("combobox", { name: "当前持有方", exact: true })
    .selectOption(team.id);
  await expect(
    page.getByRole("combobox", { name: "接收对象", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "接收对象", exact: true }),
  ).toHaveValue(team.id);
  await page
    .getByRole("combobox", { name: "接收负责人", exact: true })
    .selectOption(nextPerson.id);
  await expect(
    page.getByRole("combobox", { name: "使用方式", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("预计归还日期", { exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: /SB-000003/ }).check();
  await page.getByRole("checkbox", { name: /SB-000004/ }).check();
  await expect(page.locator(".flow-item").first()).toContainText(
    "保留原起始日期：未知",
  );
  await expect(page.locator(".flow-item").first()).toContainText("2019-12-31");
  await expect(
    page
      .locator(".flow-item")
      .last()
      .getByRole("combobox", { name: "实际交接状况", exact: true }),
  ).toHaveValue("faulty");
  await expect(
    page
      .locator(".flow-item")
      .last()
      .getByRole("combobox", { name: "实际交接状况", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "保存并核对交接", exact: true })
    .click();
  const call = f.calls.find((c) => c.name === "save_document")!;
  expect(call.body.details).toMatchObject({
    kind: "transfer",
    transfer_mode: "responsibility",
    from_party_id: team.id,
    to_party_id: team.id,
    from_person_id: person.id,
    to_person_id: nextPerson.id,
    usage_kind: null,
    due_on: null,
  });
  expect(
    (call.body.items as FlowItem[]).map((i) => i.condition_on_handover),
  ).toEqual(["normal", "faulty"]);
  await expect(page.getByRole("region", { name: "交接确认" })).toContainText(
    "保留当前分配",
  );
  await page.getByRole("button", { name: "确认实际交接", exact: true }).click();
  const sheet = page.getByRole("article", { name: "交接单据" });
  await expect(sheet).toContainText("同团队负责人交接");
  await expect(sheet).toContainText("保留预计归还日期：2019-12-31");
  await expect(sheet).toContainText("保留预计归还日期：2030-01-01");
});

test("same responsible person is rejected without saving a transfer", async ({
  page,
}) => {
  const f = await fixture(page);
  await login(page);
  await page.goto("/#/documents/new?kind=transfer");
  await identities(page);
  await page
    .getByRole("combobox", { name: "转交方式", exact: true })
    .selectOption("responsibility");
  await page
    .getByRole("combobox", { name: "当前持有方", exact: true })
    .selectOption(team.id);
  await page
    .getByRole("combobox", { name: "接收负责人", exact: true })
    .selectOption(person.id);
  await page.getByRole("checkbox", { name: /SB-000003/ }).check();
  await page
    .getByRole("button", { name: "保存并核对交接", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("不同负责人");
  expect(f.calls.filter((c) => c.name === "save_document")).toHaveLength(0);
});

test("responsibility print uses frozen dates and names when current data differs", async ({
  page,
}) => {
  const f = await fixture(page, "viewer");
  const doc = document("confirmed", 2);
  doc.kind = "transfer";
  doc.transfer_mode = "responsibility";
  doc.document_no = "ZJ-20200101-0001";
  doc.usage_kind = null;
  doc.due_on = null;
  doc.parties_snapshot = {
    ...doc.parties_snapshot!,
    from_responsible_name: "冻结的旧负责人",
    to_responsible_name: "冻结的新负责人",
    transfer_mode: "responsibility",
  };
  doc.items[0].asset_snapshot = {
    ...asset(3, true),
    condition: "faulty",
    started_on: null,
    due_on: "2019-12-31",
  };
  doc.items[0].condition_on_handover = "faulty";
  doc.items[1].asset_snapshot = { ...asset(4, true), due_on: "2030-01-01" };
  f.stock.forEach((a) => {
    a.due_on = "2099-01-01";
    a.responsible_name = "变更后的当前负责人";
  });
  f.setDocument(doc);
  await login(page);
  await page.goto("/#/documents/" + doc.id);
  const sheet = page.getByRole("article", { name: "交接单据" });
  await expect(sheet).toContainText("冻结的新负责人");
  await expect(sheet).toContainText("冻结的旧负责人");
  await expect(sheet).toContainText("原起始日期：未知");
  await expect(sheet).toContainText("2019-12-31");
  await expect(sheet).not.toContainText("2099-01-01");
  await expect(
    page.getByRole("link", { name: "继续编辑草稿", exact: true }),
  ).toHaveCount(0);
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({
    preferCSSPageSize: true,
    displayHeaderFooter: false,
  });
  expect(pdf.length).toBeGreaterThan(10000);
});
test("partial faulty return requires explanation and saves selected held device only", async ({
  page,
}) => {
  const f = await fixture(page);
  await login(page);
  await page.goto("/#/documents/new?kind=return");
  await identities(page);
  await page
    .getByRole("combobox", { name: "当前持有方", exact: true })
    .selectOption(team.id);
  await expect(
    page.getByRole("combobox", { name: "交出负责人", exact: true }),
  ).toHaveValue(person.id);
  await page
    .getByLabel("退回原因（必填）", { exact: true })
    .fill("示例部分故障退回");
  await page.getByRole("checkbox", { name: /SB-000003/ }).check();
  await page
    .getByRole("combobox", { name: "实际交接状况", exact: true })
    .selectOption("faulty");
  await page
    .getByRole("button", { name: "保存并核对交接", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("故障须说明");
  expect(f.calls.filter((c) => c.name === "save_document")).toHaveLength(0);
  await page.getByLabel("交接说明", { exact: true }).fill("示例无法开机");
  await page
    .getByRole("button", { name: "保存并核对交接", exact: true })
    .click();
  const call = f.calls.find((c) => c.name === "save_document")!;
  expect(call.body.details).toMatchObject({
    from_party_id: team.id,
    from_person_id: person.id,
    to_kind: "inventory",
  });
  expect(call.body.items).toMatchObject([
    {
      asset_id: id(103),
      condition_on_handover: "faulty",
      note: "示例无法开机",
    },
  ]);
});
test("draft conflict preserves form and draft deletion requires confirmation", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setDocument(document("draft"));
  await login(page);
  await page.goto("/#/documents/" + id(50) + "/edit");
  await expect(page.getByLabel("实际移交人", { exact: true })).toHaveValue(
    "示例移交人",
  );
  await page.getByLabel("实际移交人", { exact: true }).fill("示例改名");
  f.loseSaveAcknowledgement();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByText("草稿已保存，尚未改变设备去向。", { exact: true }),
  ).toBeVisible();
  const saves = f.calls.filter((c) => c.name === "save_document");
  expect(saves).toHaveLength(2);
  expect(saves[0].body).toEqual(saves[1].body);
  f.failSave();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("草稿已被修改");
  await expect(page.getByLabel("实际移交人", { exact: true })).toHaveValue(
    "示例改名",
  );
  await page.goto("/#/documents/" + id(50));
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  expect(f.calls.filter((c) => c.name === "delete_document")).toHaveLength(0);
  await page.getByRole("button", { name: "确认删除草稿", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "流转办理", exact: true }),
  ).toBeVisible();
  expect(f.calls.filter((c) => c.name === "delete_document")).toHaveLength(1);
});
test("late document response cannot restore content after permission loss", async ({
  page,
}) => {
  const f = await fixture(page);
  await login(page);
  f.holdDetail();
  await page.goto("/#/documents/" + id(50));
  await expect
    .poll(() => f.calls.filter((c) => c.name === "get_document").length)
    .toBe(1);
  f.disable();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("当前账号无法执行此操作，请登录或查看账号状态。", {
      exact: true,
    }),
  ).toBeVisible();
  f.releaseDetail();
  await expect(page.getByRole("article", { name: "交接单据" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打印单据 / 另存 PDF", exact: true }),
  ).toHaveCount(0);
});
test("fifty-line A4 PDF uses repeated header, page counters, preserved codes and signatures", async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  const doc = document("confirmed", 50);
  doc.remarks = "示例长备注 ".repeat(100) + "REMARK-END";
  doc.items[0].asset_snapshot!.legacy_code = "00007/LONG-" + "A".repeat(90);
  f.setDocument(doc);
  await login(page);
  await page.goto("/#/documents/" + id(50));
  await expect(page.getByRole("article", { name: "交接单据" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".site-header")).toBeHidden();
  await expect(page.locator(".print-table thead")).toHaveCSS(
    "display",
    "table-header-group",
  );
  await expect(page.locator(".print-signatures")).toHaveCSS(
    "break-inside",
    "avoid",
  );
  const pdf = await page.pdf({
    preferCSSPageSize: true,
    displayHeaderFooter: false,
  });
  await writeFile(testInfo.outputPath("fifty-line.pdf"), pdf, { mode: 0o600 });
  const pages =
    pdf.toString("latin1").match(/\/Type\s*\/Page(?:\s|\/|>)/g)?.length || 0;
  expect(pages).toBeGreaterThan(1);
  expect(pages).toBeLessThan(12);
  expect(pdf.length).toBeGreaterThan(10000);
  await expect(page.locator(".print-table tbody tr")).toHaveCount(50);
});
