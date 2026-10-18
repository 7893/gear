import type { Asset } from "./inventory-model.js";

export const flowKinds = { receipt: "领入", issue: "分发", return: "退回" };
export const documentStates = {
  draft: "草稿",
  confirmed: "已确认",
  voided: "已作废",
};
export type FlowKind = keyof typeof flowKinds;
export type FlowDetails = {
  kind: FlowKind;
  handover_on: string | null;
  from_kind: "inventory" | "party" | "external";
  to_kind: "inventory" | "party" | "external";
  from_party_id: string | null;
  to_party_id: string | null;
  from_person_id: string | null;
  to_person_id: string | null;
  from_label: string;
  to_label: string;
  sender_name: string;
  receiver_name: string;
  usage_kind: "long_term" | "temporary" | null;
  due_on: string | null;
  remarks: string;
};
export type NewAssetData = {
  name: string;
  category: string;
  legacy_code: string;
  serial_number: string;
  brand: string;
  model: string;
  note: string;
};
export type FlowItem = {
  asset_id: string | null;
  new_asset_data: NewAssetData | null;
  expected_asset_version: number | null;
  condition_on_handover: "normal" | "faulty" | null;
  location: string | null;
  note: string | null;
  allow_legacy_duplicate: boolean;
};
export type DocumentItem = FlowItem & {
  id: string;
  line_no: number;
  asset_snapshot: Asset | null;
  state_before: Partial<Asset> | null;
  state_after: Partial<Asset> | null;
};
export type FlowDocument = FlowDetails & {
  id: string;
  created_by: string;
  version: number;
  status: keyof typeof documentStates;
  document_no: string | null;
  created_at: string;
  confirmed_at: string | null;
  header_snapshot: { title: string; operator_name?: string } | null;
  parties_snapshot: {
    from_label: string;
    to_label: string;
    sender_name: string;
    receiver_name: string;
    from_responsible_name: string | null;
    to_responsible_name: string | null;
    usage_kind: string | null;
    due_on: string | null;
    handover_on: string;
  } | null;
  evidence_state: string | null;
  void_reason: string | null;
  items: DocumentItem[];
  item_count?: number;
};
export function blankDetails(kind: FlowKind): FlowDetails {
  return {
    kind,
    handover_on: null,
    from_kind:
      kind === "receipt"
        ? "external"
        : kind === "issue"
          ? "inventory"
          : "party",
    to_kind: kind === "issue" ? "party" : "inventory",
    from_party_id: null,
    to_party_id: null,
    from_person_id: null,
    to_person_id: null,
    from_label: "",
    to_label: "",
    sender_name: "",
    receiver_name: "",
    usage_kind: kind === "issue" ? "long_term" : null,
    due_on: null,
    remarks: "",
  };
}
