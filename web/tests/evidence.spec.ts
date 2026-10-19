import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
  let exportDocs: FlowDocument[] | null = null;
  const exportItems = new Map<string, Attachment[]>();
  let exportFailure: string | null = null;
  let versionDrift = false;
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
      if (body.document_id === exportFailure)
        return route.fulfill({
          status: 403,
          json: { message: "private attachment diagnostic" },
        });
      const target = exportDocs?.find((d) => d.id === body.document_id) || doc;
      return route.fulfill({
        json: {
          document_version: target.version + (versionDrift ? 1 : 0),
          evidence_state: target.evidence_state,
          items: exportItems.get(String(body.document_id)) ?? items,
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
    if (name === "list_documents") {
      const visible = exportDocs?.filter(
        (d) =>
          (d.status !== "draft" ||
            role === "admin" ||
            (role === "operator" && d.created_by === user.id)) &&
          (!body.state || d.status === body.state) &&
          (!body.kind || d.kind === body.kind) &&
          (!body.search || d.document_no?.includes(String(body.search))),
      );
      return route.fulfill({
        json: visible ?? [
          doc,
          { ...doc, id: id(11), document_no: "LR-20200101-0002" },
        ],
      });
    }
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
    setExportDocs: (value: FlowDocument[]) => (exportDocs = value),
    setExportItems: (docId: string, value: Attachment[]) =>
      exportItems.set(docId, value),
    failExport: (docId: string | null) => (exportFailure = docId),
    driftExport: (value: boolean) => (versionDrift = value),
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

function exportDocuments(): FlowDocument[] {
  const confirmed = {
    ...document(),
    evidence_state: "archived",
    item_count: 7,
    created_at: "2020-01-01T16:30:00Z",
    remarks: "=1+1",
  };
  confirmed.parties_snapshot!.from_label = "冻结的交付方";
  return [
    confirmed,
    {
      ...document(),
      id: id(11),
      document_no: "LR-20200101-0002",
      status: "voided",
      void_reason: "示例误录",
      evidence_state: "awaiting_review",
      item_count: 2,
    },
    {
      ...document(),
      id: id(12),
      document_no: null,
      status: "draft",
      confirmed_at: null,
      parties_snapshot: null,
      header_snapshot: null,
      evidence_state: null,
      item_count: 1,
    },
    {
      ...document(),
      id: id(13),
      created_by: id(2),
      document_no: null,
      status: "draft",
      confirmed_at: null,
      parties_snapshot: null,
      header_snapshot: null,
      evidence_state: null,
      item_count: 1,
    },
  ];
}
async function csvDownload(page: Page, name: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  const download = await pending;
  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
  return { text: bytes.toString("utf8"), name: download.suggestedFilename() };
}
for (const role of ["admin", "operator", "viewer"]) {
  test(`${role} exports visible document snapshots and sends fresh filters without attachment requests`, async ({
    page,
  }) => {
    const f = await fixture(page, role, false);
    f.setExportDocs(exportDocuments());
    await login(page);
    await page.goto("/#/documents");
    await expect(
      page.getByRole("heading", { name: "单据记录", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "导出附件关联 CSV", exact: true }),
    ).toHaveCount(0);
    const before = f.calls.length;
    const csv = await csvDownload(page, "导出单据 CSV");
    expect(csv.name).toMatch(/^单据清单-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.text).toContain('"LR-20200101-0001","领入","已确认"');
    expect(csv.text).toContain('"冻结的交付方"');
    expect(csv.text).toContain('"已归档"');
    expect(csv.text).toContain('"7"');
    expect(csv.text).toMatch(/2020年1月2日.*00:30/);
    expect(csv.text).toContain('"\'=1+1"');
    expect(csv.text).toContain('"示例误录"');
    const rows = role === "admin" ? 4 : role === "operator" ? 3 : 2;
    expect(csv.text.split("\r\n")).toHaveLength(rows + 2);
    expect(csv.text.includes('"不适用（草稿）"')).toBe(role !== "viewer");
    if (role !== "admin") expect(csv.text).not.toContain('"' + id(13) + '"');
    expect(f.calls.slice(before).map((c) => c.name)).toEqual([
      "list_documents",
    ]);
    await page.getByLabel("搜索单据", { exact: true }).fill("0002");
    await page
      .getByRole("combobox", { name: "单据状态", exact: true })
      .selectOption("voided");
    const filtered = await csvDownload(page, "导出单据 CSV");
    expect(filtered.text).not.toContain("LR-20200101-0001");
    expect(filtered.text).toContain("LR-20200101-0002");
    expect(f.calls.at(-1)).toEqual({
      name: "list_documents",
      body: { search: "0002", kind: null, state: "voided" },
    });
  });
}

test("attachment CSV retains visible inactive and pending records with associations but no private paths or original downloads", async ({
  page,
}) => {
  const f = await fixture(page, "admin");
  f.setExportDocs(exportDocuments().slice(0, 2));
  f.setExportItems(id(10), [
    {
      ...attachment(),
      review_state: "accepted",
      source_kind: "external",
      external_reference: "00007/A",
      original_name: '示例,"签字件".png',
    },
    {
      ...attachment(),
      id: id(21),
      is_active: false,
      review_state: "rejected",
      original_name: "已替换.pdf",
      correction_reason: "示例关联更正",
    },
    {
      ...attachment(),
      id: id(22),
      upload_state: "pending",
      uploaded_at: null,
      size_bytes: null,
      page_count: null,
      sha256: null,
      original_name: "=待上传.png",
    },
  ]);
  f.setExportItems(id(11), [
    {
      ...attachment(),
      id: id(23),
      document_id: id(11),
      original_name: "作废单原件.png",
    },
  ]);
  await login(page);
  await page.goto("/#/documents");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  const before = f.calls.length;
  const csv = await csvDownload(page, "导出附件关联 CSV");
  expect(csv.name).toMatch(/^附件关联清单-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csv.text.split("\r\n")).toHaveLength(6);
  expect(csv.text).toContain(
    '"示例,""签字件"".png","已上传","已核对","有效","外部凭证","00007/A"',
  );
  expect(csv.text).toContain('"已替换.pdf","已上传","已驳回","已停用"');
  expect(csv.text).toContain('"\'=待上传.png","上传中"');
  expect(csv.text).toContain('"作废单原件.png"');
  expect(csv.text).toContain('"LR-20200101-0002","领入","已作废"');
  expect(csv.text).toContain('"' + id(23) + '"');
  expect(csv.text).not.toContain("example/immutable");
  expect(csv.text).not.toMatch(/https?:\/\//);
  expect(f.calls.slice(before).map((c) => c.name)).toEqual([
    "list_documents",
    "list_evidence",
    "list_evidence",
  ]);
  expect(f.uploads).toHaveLength(0);
  expect(f.externalRequests).toEqual([]);
});

test("one denied attachment read, version drift or mismatched association fails the entire export and retry starts fresh", async ({
  page,
}) => {
  const f = await fixture(page, "viewer");
  f.setExportDocs(exportDocuments().slice(0, 2));
  f.setExportItems(id(10), [attachment()]);
  f.setExportItems(id(11), []);
  await login(page);
  await page.goto("/#/documents");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  let downloads = 0;
  page.on("download", () => downloads++);
  f.failExport(id(11));
  await page
    .getByRole("button", { name: "导出附件关联 CSV", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("导出失败");
  await expect(page.getByText("private attachment diagnostic")).toHaveCount(0);
  expect(downloads).toBe(0);
  f.failExport(null);
  f.driftExport(true);
  await page
    .getByRole("button", { name: "导出附件关联 CSV", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("单据已被修改或处理");
  expect(downloads).toBe(0);
  f.driftExport(false);
  f.setExportItems(id(10), [{ ...attachment(), document_id: id(11) }]);
  await page
    .getByRole("button", { name: "导出附件关联 CSV", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("单据已被修改或处理");
  expect(downloads).toBe(0);
  f.setExportItems(id(10), [attachment()]);
  const csv = await csvDownload(page, "导出附件关联 CSV");
  expect(csv.text.split("\r\n")).toHaveLength(3);
  expect(csv.text).toContain("示例签字件.png");
  expect(downloads).toBe(1);
});

test("empty document or attachment results produce headers without claiming failed or missing reads succeeded", async ({
  page,
}) => {
  const f = await fixture(page, "viewer");
  f.setExportDocs([]);
  await login(page);
  await page.goto("/#/documents");
  await expect(
    page.getByText("暂无符合条件的单据。", { exact: true }),
  ).toBeVisible();
  const before = f.calls.filter((c) => c.name === "list_evidence").length;
  expect(
    (await csvDownload(page, "导出单据 CSV")).text.split("\r\n"),
  ).toHaveLength(2);
  expect(
    (await csvDownload(page, "导出附件关联 CSV")).text.split("\r\n"),
  ).toHaveLength(2);
  expect(f.calls.filter((c) => c.name === "list_evidence")).toHaveLength(
    before,
  );
  f.setExportDocs([document()]);
  f.setExportItems(id(10), []);
  expect(
    (await csvDownload(page, "导出附件关联 CSV")).text.split("\r\n"),
  ).toHaveLength(2);
});

for (const reason of ["revoked", "route changed"]) {
  test(`pending attachment export stops subsequent reads and download when ${reason}`, async ({
    page,
  }) => {
    const f = await fixture(page, "admin");
    f.setExportDocs(exportDocuments().slice(0, 2));
    f.setExportItems(id(10), [attachment()]);
    f.setExportItems(id(11), []);
    await login(page);
    await page.goto("/#/documents");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    let downloads = 0;
    page.on("download", () => downloads++);
    f.hold();
    const before = f.calls.filter((c) => c.name === "list_evidence").length;
    await page
      .getByRole("button", { name: "导出附件关联 CSV", exact: true })
      .click();
    await expect
      .poll(() => f.calls.filter((c) => c.name === "list_evidence").length)
      .toBe(before + 1);
    await expect(
      page.getByRole("button", { name: "正在导出…", exact: true }),
    ).toBeDisabled();
    if (reason === "revoked") {
      f.disable();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByText("当前账号无法执行此操作，请登录或查看账号状态。", {
          exact: true,
        }),
      ).toBeVisible();
    } else {
      // Both routes share DocumentsView; its export context must still reset.
      await page.getByRole("link", { name: "流转办理", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "流转办理", exact: true }),
      ).toBeVisible();
    }
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/rpc/list_evidence"),
    );
    f.release();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(f.calls.filter((c) => c.name === "list_evidence")).toHaveLength(
      before + 1,
    );
    expect(downloads).toBe(0);
    expect(f.uploads).toHaveLength(0);
  });
}
