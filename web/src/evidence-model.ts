export type EvidenceHints = {
  document_ids: string[];
  document_numbers: string[];
};
export type Attachment = {
  id: string;
  document_id: string;
  version: number;
  storage_key: string;
  original_name: string;
  media_type: string | null;
  size_bytes: number | null;
  page_count: number | null;
  sha256: string | null;
  upload_state: "pending" | "ready" | "failed";
  uploaded_by: string;
  uploaded_at: string | null;
  ocr_state: string;
  ocr_result: EvidenceHints | null;
  ocr_error_code: string | null;
  review_state: "pending" | "accepted" | "rejected";
  is_active: boolean;
  source_kind: "internal" | "external";
  external_reference: string | null;
  correction_reason: string | null;
};
export type EvidenceList = {
  document_version: number;
  evidence_state: "awaiting_upload" | "awaiting_review" | "archived";
  items: Attachment[];
  history: {
    id: number;
    event_type: string;
    actor_label: string;
    recorded_at: string;
    reason: string | null;
  }[];
};
export type Candidate = {
  id: string;
  document_no: string;
  kind: string;
  status: string;
  handover_on: string;
  from_label: string;
  to_label: string;
};
export const emptyHints = (): EvidenceHints => ({
  document_ids: [],
  document_numbers: [],
});
export function extractHints(values: string[]): EvidenceHints {
  const ids = new Set<string>();
  const numbers = new Set<string>();
  for (const text of values) {
    const id =
      /^gear:document:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
        text.trim(),
      );
    if (id) ids.add(id[1]);
    for (const match of text.matchAll(
      /\b(?:LR|FF|TH|ZJ)-[0-9]{8}-[0-9]{4,19}\b/g,
    ))
      numbers.add(match[0]);
  }
  return {
    document_ids: [...ids].slice(0, 20),
    document_numbers: [...numbers].slice(0, 20),
  };
}
