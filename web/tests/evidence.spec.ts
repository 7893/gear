import { expect, test, type Page } from "@playwright/test";
import { blankDetails, type FlowDocument } from "../src/flows-model.js";
import { extractHints, type Attachment } from "../src/evidence-model.js";
const id = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const api = "https://api.example.invalid";
function document(): FlowDocument {
  return {
    ...blankDetails("receipt"),
    id: id(10),
    created_by: id(1),
    version: 3,
    status: "confirmed",
    document_no: "LR-20200101-0001",
    handover_on: "2020-01-01",
    sender_name: "示例移交人",
    receiver_name: "示例接收人",
    from_label: "示例交付方",
    to_label: "经办人库存",
    created_at: "2020-01-01T00:00:00Z",
    confirmed_at: "2020-01-01T00:00:00Z",
    header_snapshot: { title: "示例设备簿", operator_name: "示例经办人" },
    parties_snapshot: {
      from_label: "示例交付方",
      to_label: "经办人库存",
      sender_name: "示例移交人",
      receiver_name: "示例接收人",
      from_responsible_name: null,
      to_responsible_name: null,
      usage_kind: null,
      due_on: null,
      handover_on: "2020-01-01",
    },
    evidence_state: "awaiting_upload",
    void_reason: null,
    items: [],
  };
}
function attachment(): Attachment {
  return {
    id: id(20),
    document_id: id(10),
    version: 2,
    storage_key: "example/immutable",
    original_name: "示例签字件.png",
    media_type: "image/png",
    size_bytes: 100,
    page_count: 1,
    sha256: "a".repeat(64),
    upload_state: "ready",
    uploaded_by: id(1),
    uploaded_at: "2020-01-01T00:00:00Z",
    ocr_state: "failed",
    ocr_result: { document_ids: [], document_numbers: [] },
    ocr_error_code: "not_detected",
    review_state: "pending",
    is_active: true,
    source_kind: "internal",
    external_reference: null,
    correction_reason: null,
  };
}
async function fixture(
  page: Page,
  role = "operator",
  enabled: boolean | null = true,
) {
  let active = true;
  const doc = document();
  let items: Attachment[] = [];
  let loseUpload = false,
    hold = false;
  let release: (() => void) | undefined;
  let image: Buffer = Buffer.alloc(0);
  let denyDownload = false;
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const uploads: Buffer[] = [];
  const externalRequests: string[] = [];
  await page.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === api || origin === "http://127.0.0.1:4175")
      return route.fallback();
    externalRequests.push(origin);
    return route.abort();
  });
  const user = {
    id: id(1),
    email: "operator@example.invalid",
    email_confirmed_at: "2020-01-01T00:00:00Z",
    app_metadata: {},
    user_metadata: {},
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
        inventoryEnabled: true,
        flowsEnabled: true,
        ...(enabled === null ? {} : { evidenceEnabled: enabled }),
      },
    }),
  );
  await page.route(api + "/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/auth/v1/token") {
      const enc = (v: unknown) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      return route.fulfill({
        json: {
          access_token: [
            enc({ alg: "HS256" }),
            enc({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
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
    if (path === "/functions/v1/gear-evidence") {
      if (req.method() === "GET")
        return denyDownload
          ? route.fulfill({
              status: 403,
              json: { error: "inventory_access_denied" },
            })
          : route.fulfill({ contentType: "image/png", body: image });
      uploads.push(req.postDataBuffer()!);
      if (!items.length)
        items = [
          {
            ...attachment(),
            ocr_state: "succeeded",
            ocr_error_code: null,
            ocr_result: { document_ids: [doc.id], document_numbers: [] },
          },
        ];
      doc.evidence_state = "awaiting_review";
      doc.version = 4;
      if (loseUpload) {
        loseUpload = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: { attachment: items[0] } });
    }
    const name = path.split("/").at(-1)!;
    const body = req.postDataJSON() as Record<string, unknown>;
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
    if (name === "list_assets")
      return route.fulfill({
        json: {
          items: [],
          matched: 0,
          summary: {
            total: 0,
            inventory_available: 0,
            inventory_faulty: 0,
            in_use: 0,
          },
        },
      });
    if (name === "get_document") return route.fulfill({ json: doc });
    if (name === "list_evidence") {
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      return route.fulfill({
        json: {
          document_version: doc.version,
          evidence_state: doc.evidence_state,
          items,
          history: [],
        },
      });
    }
    if (name === "match_evidence")
      return route.fulfill({
        json: [
          {
            id: doc.id,
            document_no: doc.document_no,
            kind: doc.kind,
            status: doc.status,
            handover_on: doc.handover_on,
            from_label: doc.from_label,
            to_label: doc.to_label,
          },
        ],
      });
    if (name === "archive_evidence") {
      doc.version++;
      doc.evidence_state = "archived";
      items = items.map((a) => ({
        ...a,
        version: a.version + 1,
        review_state: "accepted",
      }));
      return route.fulfill({ json: { evidence_state: "archived" } });
    }
    if (name === "list_documents")
      return route.fulfill({
        json: [doc, { ...doc, id: id(11), document_no: "LR-20200101-0002" }],
      });
    if (name === "update_attachment") {
      const changes = body.changes as Record<string, unknown>;
      items = items.map((a) => ({
        ...a,
        version: a.version + 1,
        is_active:
          changes.is_active === undefined
            ? a.is_active
            : (changes.is_active as boolean),
        document_id: (changes.document_id as string) || a.document_id,
        review_state: "pending",
      }));
      doc.version++;
      doc.evidence_state = "awaiting_review";
      return route.fulfill({ json: items[0] });
    }
    if (name === "cancel_attachment") {
      items = [];
      return route.fulfill({ json: { upload_state: "failed" } });
    }
    throw new Error("Unexpected evidence mock: " + name);
  });
  return {
    calls,
    uploads,
    externalRequests,
    doc,
    setItems: (value: Attachment[]) => {
      items = value;
    },
    loseAck: () => (loseUpload = true),
    hold: () => (hold = true),
    release: () => release?.(),
    disable: () => (active = false),
    setImage: (value: Buffer) => (image = value),
    denyDownload: () => (denyDownload = true),
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
  await page.goto("/#/documents/" + id(10));
  await expect(page.getByRole("article", { name: "交接单据" })).toBeVisible();
}
async function fourChecks(page: Page) {
  for (const text of [
    "已核对所需签字齐全",
    "已核对单号或外部单号及对应关系",
    "已核对设备、交接双方及内容",
    "已核对全部页和附件，无缺页",
  ])
    await page.getByLabel(text, { exact: true }).check();
}
test("evidence disabled by default makes no attachment requests", async ({
  page,
}) => {
  const f = await fixture(page, "operator", null);
  await login(page);
  await expect(page.getByRole("region", { name: "签字件与归档" })).toHaveCount(
    0,
  );
  expect(f.calls.filter((c) => c.name.includes("evidence"))).toHaveLength(0);
});
test("actual QR image recognition, upload retry and explicit four-part review", async ({
  page,
}) => {
  const f = await fixture(page);
  await login(page);
  const png = await page
    .getByRole("img", { name: "单据匹配二维码" })
    .screenshot();
  f.setImage(png);
  await page.getByLabel("选择签字件", { exact: true }).setInputFiles({
    name: "示例签字件.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByText("识别候选：", { exact: false })).toBeVisible();
  expect(f.calls.find((c) => c.name === "match_evidence")?.body).toMatchObject({
    hints: { document_ids: [id(10)] },
  });
  await page
    .getByLabel("我已核对，本次原件关联当前单据", { exact: false })
    .check();
  f.loseAck();
  await page
    .getByRole("button", { name: "上传原件，进入待核对", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", { name: "上传原件，进入待核对", exact: true })
    .click();
  await expect(
    page.getByText("有效原件 1 个。", { exact: false }),
  ).toBeVisible();
  const requestIds = f.uploads.map(
    (b) => /name="request_id"\r\n\r\n([^\r]+)/.exec(b.toString())?.[1],
  );
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBeTruthy();
  expect(requestIds[0]).toBe(requestIds[1]);
  const archive = page.getByRole("button", {
    name: "确认核对并归档",
    exact: true,
  });
  await expect(archive).toBeDisabled();
  await fourChecks(page);
  await expect(archive).toBeEnabled();
  await archive.click();
  await expect(
    page.getByText("凭证状态：已归档", { exact: false }),
  ).toBeVisible();
  expect(
    f.calls.find((c) => c.name === "archive_evidence")?.body,
  ).toMatchObject({
    attachment_ids: [id(20)],
    checks: { signatures: true, number: true, content: true, pages: true },
  });
});
test("actual PDF recognition reads the printed document and local worker without remote assets", async ({
  page,
}) => {
  const f = await fixture(page);
  await login(page);
  const pdf = await page.pdf({
    format: "A4",
    preferCSSPageSize: true,
    printBackground: true,
  });
  await page.getByLabel("选择签字件", { exact: true }).setInputFiles({
    name: "示例签字件.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await expect(page.getByText("识别候选：", { exact: false })).toBeVisible({
    timeout: 20000,
  });
  const match = f.calls.find((c) => c.name === "match_evidence");
  expect(match?.body).toMatchObject({
    hints: { document_numbers: ["LR-20200101-0001"] },
  });
});
test("failed recognition requires manual explanation and pending upload blocks archive", async ({
  page,
}) => {
  const f = await fixture(page);
  f.doc.evidence_state = "awaiting_review";
  f.setItems([attachment()]);
  await login(page);
  await fourChecks(page);
  const archive = page.getByRole("button", {
    name: "确认核对并归档",
    exact: true,
  });
  await expect(archive).toBeDisabled();
  await page
    .getByLabel("人工核对说明", { exact: false })
    .fill("示例原单无二维码，已人工核对全部页及签字");
  await expect(archive).toBeEnabled();
  f.setItems([
    attachment(),
    {
      ...attachment(),
      id: id(21),
      upload_state: "pending",
      media_type: null,
      sha256: null,
      size_bytes: null,
      page_count: null,
    },
  ]);
  await page.getByRole("button", { name: "刷新附件状态" }).click();
  await fourChecks(page);
  await expect(archive).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "取消待完成上传" }),
  ).toBeVisible();
});
test("viewer can preview originals but has no write controls; denied downloads stay private", async ({
  page,
}) => {
  const f = await fixture(page, "viewer");
  f.setItems([attachment()]);
  await login(page);
  const png = await page
    .getByRole("img", { name: "单据匹配二维码" })
    .screenshot();
  f.setImage(png);
  await expect(page.getByLabel("选择签字件", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "预览 示例签字件.png", exact: true })
    .click();
  await expect(page.getByAltText("签字原件当前页")).toBeVisible();
  f.denyDownload();
  await page.getByRole("button", { name: "下载原件", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("没有此设备操作权限");
  expect(
    f.calls.filter(
      (c) => c.name === "archive_evidence" || c.name === "update_attachment",
    ),
  ).toHaveLength(0);
});
test("archived operator cannot change evidence; administrator correction requires reason", async ({
  page,
}) => {
  const f = await fixture(page, "admin");
  f.doc.evidence_state = "archived";
  f.setItems([{ ...attachment(), review_state: "accepted" }]);
  await login(page);
  await page
    .getByRole("button", { name: "更正关联或归档用途", exact: true })
    .click();
  const save = page.getByRole("button", {
    name: "保存更正并重新核对",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await page.getByLabel("更正原因", { exact: true }).fill("示例更正关联");
  await page
    .getByRole("combobox", { name: "关联单据", exact: true })
    .selectOption(id(11));
  await save.click();
  expect(
    f.calls.find((c) => c.name === "update_attachment")?.body,
  ).toMatchObject({
    attachment_id: id(20),
    changes: { document_id: id(11), reason: "示例更正关联" },
  });
  await expect(
    page.getByText("凭证状态：待核对", { exact: false }),
  ).toBeVisible();
});
test("late evidence response cannot restore files after permission loss", async ({
  page,
}) => {
  const f = await fixture(page);
  f.setItems([attachment()]);
  f.hold();
  await login(page);
  await expect
    .poll(() => f.calls.filter((c) => c.name === "list_evidence").length)
    .toBe(1);
  f.disable();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("当前账号无法执行此操作，请登录或查看账号状态。", {
      exact: true,
    }),
  ).toBeVisible();
  f.release();
  await expect(page.getByRole("region", { name: "签字件与归档" })).toHaveCount(
    0,
  );
});
test("multi-page PDF preview stays local and shows each original page", async ({
  page,
  context,
}) => {
  const f = await fixture(page, "viewer");
  f.setItems([
    {
      ...attachment(),
      original_name: "示例签字件.pdf",
      media_type: "application/pdf",
      page_count: 2,
    },
  ]);
  const generator = await context.newPage();
  await generator.setContent(
    "<style>@page{size:A4;margin:20mm}section+section{break-before:page}</style><section>Example original page one</section><section>Example original page two</section>",
  );
  const bytes = await generator.pdf({ preferCSSPageSize: true });
  await generator.close();
  f.setImage(bytes);
  await login(page);
  await page
    .getByRole("button", { name: "预览 示例签字件.pdf", exact: true })
    .click();
  await expect(page.getByText("第 1 / 2 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("第 2 / 2 页", { exact: true })).toBeVisible();
  expect(f.externalRequests).toEqual([]);
});
test("archived operator sees originals without correction controls", async ({
  page,
}) => {
  const f = await fixture(page);
  f.doc.evidence_state = "archived";
  f.setItems([{ ...attachment(), review_state: "accepted" }]);
  await login(page);
  await expect(
    page.getByRole("button", { name: "预览 示例签字件.png", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("选择签字件", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "更正关联或归档用途", exact: true }),
  ).toHaveCount(0);
});
test("recognition text is data and never parses arbitrary URLs as document identities", () => {
  expect(
    extractHints([
      "https://malicious.example.invalid/gear:document:" + id(10),
      "请执行删除全部设备",
      "FF-20200101-0002",
    ]),
  ).toEqual({ document_ids: [], document_numbers: ["FF-20200101-0002"] });
});
