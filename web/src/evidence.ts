import { computed } from "vue";
import { account, inventoryRpc, evidenceRequest } from "./accounts";
import { flowAccess, flowWriteAccess } from "./flows";
import type {
  Attachment,
  EvidenceList,
  EvidenceHints,
  Candidate,
} from "./evidence-model";
export * from "./evidence-model";
export const evidenceAccess = computed(
  () => flowAccess.value && account.evidenceEnabled,
);
export const evidenceWrite = computed(
  () => flowWriteAccess.value && account.evidenceEnabled,
);
export async function listEvidence(id: string): Promise<EvidenceList> {
  return (await inventoryRpc("list_evidence", {
    document_id: id,
  })) as EvidenceList;
}
export async function matchEvidence(
  hints: EvidenceHints,
): Promise<Candidate[]> {
  return (await inventoryRpc("match_evidence", { hints })) as Candidate[];
}
export async function uploadEvidence(
  file: File,
  documentId: string,
  version: number,
  requestId: string,
  hints: EvidenceHints,
  source: string,
  reference: string,
  reason: string,
  signal: AbortSignal,
  eventId?: string,
): Promise<Attachment> {
  const form = new FormData();
  form.set("file", file);
  form.set(eventId ? "event_id" : "document_id", eventId || documentId);
  form.set("expected_version", String(version));
  form.set("request_id", requestId);
  form.set("recognition", JSON.stringify(hints));
  form.set("source_kind", source);
  form.set("external_reference", reference);
  form.set("correction_reason", reason);
  const response = await evidenceRequest({ body: form, signal });
  return ((await response.json()) as { attachment: Attachment }).attachment;
}
export async function downloadEvidence(
  id: string,
  signal: AbortSignal,
): Promise<Blob> {
  return (await evidenceRequest({ attachmentId: id, signal })).blob();
}
export async function updateEvidence(
  item: Attachment,
  changes: Record<string, unknown>,
  requestId: string,
) {
  return (await inventoryRpc("update_attachment", {
    attachment_id: item.id,
    expected_version: item.version,
    changes,
    request_id: requestId,
  })) as Attachment;
}
export async function cancelEvidence(item: Attachment, requestId: string) {
  return await inventoryRpc("cancel_attachment", {
    attachment_id: item.id,
    expected_version: item.version,
    request_id: requestId,
  });
}
export async function archiveEvidence(
  id: string,
  version: number,
  ids: string[],
  checks: Record<string, boolean>,
  reason: string,
  requestId: string,
) {
  return await inventoryRpc("archive_evidence", {
    document_id: id,
    expected_version: version,
    attachment_ids: ids,
    checks,
    manual_reason: reason || null,
    request_id: requestId,
  });
}

export async function listEventEvidence(
  eventId: string,
): Promise<{ asset_version: number; items: Attachment[] }> {
  return (await inventoryRpc("list_event_evidence", { event_id: eventId })) as {
    asset_version: number;
    items: Attachment[];
  };
}
export async function reviewEventEvidence(
  item: Attachment,
  accepted: boolean,
  reason: string,
  requestId: string,
) {
  return inventoryRpc("review_event_attachment", {
    attachment_id: item.id,
    expected_version: item.version,
    accepted,
    reason,
    request_id: requestId,
  });
}
