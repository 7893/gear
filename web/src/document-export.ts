import { documentStates, flowKinds, type FlowDocument } from "./flows-model";
import { evidenceAccess, listEvidence } from "./evidence";
import { evidenceStates, type Attachment } from "./evidence-model";
import { businessToday, timestamp } from "./inventory";
import type { CsvFile } from "./csv";

const identityHeaders = [
  "单据标识",
  "正式单号",
  "类型",
  "状态",
  "实际交接日期",
  "移交方",
  "接收方",
  "签字件状态",
];
function identityRow(doc: FlowDocument): string[] {
  const parties = doc.parties_snapshot;
  return [
    doc.id,
    doc.document_no || "",
    flowKinds[doc.kind],
    documentStates[doc.status],
    parties?.handover_on || doc.handover_on || "",
    parties?.from_label ?? doc.from_label,
    parties?.to_label ?? doc.to_label,
    doc.status === "draft"
      ? "不适用（草稿）"
      : evidenceStates[doc.evidence_state as keyof typeof evidenceStates] ||
        "未记录",
  ];
}
export function documentCsv(docs: FlowDocument[]): CsvFile {
  return {
    headers: [
      ...identityHeaders,
      "实际移交人",
      "实际接收人",
      "交出负责人",
      "接收负责人",
      "设备数",
      "创建时间（东八区）",
      "确认时间（东八区）",
      "作废原因",
      "备注",
    ],
    rows: docs.map((doc) => [
      ...identityRow(doc),
      doc.parties_snapshot?.sender_name ?? doc.sender_name,
      doc.parties_snapshot?.receiver_name ?? doc.receiver_name,
      doc.parties_snapshot?.from_responsible_name || "",
      doc.parties_snapshot?.to_responsible_name || "",
      String(doc.item_count ?? doc.items?.length ?? 0),
      timestamp(doc.created_at),
      doc.confirmed_at ? timestamp(doc.confirmed_at) : "",
      doc.void_reason || "",
      doc.remarks,
    ]),
    businessOn: businessToday(),
  };
}
function attachmentRow(doc: FlowDocument, item: Attachment): string[] {
  return [
    ...identityRow(doc),
    item.id,
    item.original_name,
    { pending: "上传中", ready: "已上传", failed: "上传失败" }[
      item.upload_state
    ],
    { pending: "待核对", accepted: "已核对", rejected: "已驳回" }[
      item.review_state
    ],
    item.is_active ? "有效" : "已停用",
    item.source_kind === "external" ? "外部凭证" : "本系统单据",
    item.external_reference || "",
    item.size_bytes === null ? "" : String(item.size_bytes),
    item.page_count === null ? "" : String(item.page_count),
    item.sha256 || "",
    item.uploaded_at ? timestamp(item.uploaded_at) : "",
    item.correction_reason || "",
  ];
}
export async function attachmentCsv(
  query: () => Promise<FlowDocument[]>,
  signal: AbortSignal,
): Promise<CsvFile> {
  const check = () => {
    signal.throwIfAborted();
    if (!evidenceAccess.value) throw new Error("inventory_access_denied");
  };
  check();
  const docs = await query();
  const rows: string[][] = [];
  for (const doc of docs) {
    check();
    const evidence = await listEvidence(doc.id);
    check();
    // Refuse to combine metadata from different versions, or a partial success.
    if (
      evidence.document_version !== doc.version ||
      evidence.evidence_state !== doc.evidence_state
    )
      throw new Error("document_conflict");
    for (const item of evidence.items) {
      if (item.document_id !== doc.id) throw new Error("document_conflict");
      rows.push(attachmentRow(doc, item));
    }
  }
  check();
  return {
    headers: [
      ...identityHeaders,
      "附件标识",
      "文件名",
      "上传状态",
      "核对状态",
      "有效情况",
      "凭证来源",
      "外部凭证编号",
      "文件字节数",
      "页数",
      "SHA-256",
      "上传时间（东八区）",
      "更正原因",
    ],
    rows,
    businessOn: businessToday(),
  };
}
