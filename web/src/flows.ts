import { computed } from "vue";
import { account, inventoryRpc } from "./accounts";
import { inventoryAccess, inventoryWriteAccess } from "./inventory";

export const flowAccess = computed(
  () => inventoryAccess.value && account.flowsEnabled,
);
export const flowWriteAccess = computed(
  () => inventoryWriteAccess.value && account.flowsEnabled,
);
export const flowAdminAccess = computed(
  () => flowWriteAccess.value && account.profile?.membership?.role === "admin",
);
export * from "./flows-model";
import type { FlowDocument, FlowItem, FlowDetails } from "./flows-model";
export async function listDocuments(filters: {
  search: string;
  kind: string | null;
  state: string | null;
}): Promise<FlowDocument[]> {
  return (await inventoryRpc("list_documents", filters)) as FlowDocument[];
}
export async function getDocument(id: string): Promise<FlowDocument> {
  return (await inventoryRpc("get_document", {
    document_id: id,
  })) as FlowDocument;
}
export async function saveDocument(
  details: FlowDetails,
  items: FlowItem[],
  requestId: string,
  draft: FlowDocument | null,
): Promise<FlowDocument> {
  return (await inventoryRpc("save_document", {
    details,
    items,
    request_id: requestId,
    document_id: draft?.id || null,
    expected_version: draft?.version ?? null,
  })) as FlowDocument;
}
export async function confirmDocument(
  draft: FlowDocument,
  requestId: string,
): Promise<FlowDocument> {
  return (await inventoryRpc("confirm_document", {
    document_id: draft.id,
    expected_version: draft.version,
    request_id: requestId,
  })) as FlowDocument;
}
export async function deleteDocument(
  draft: FlowDocument,
  requestId: string,
): Promise<void> {
  await inventoryRpc("delete_document", {
    document_id: draft.id,
    expected_version: draft.version,
    request_id: requestId,
  });
}
export async function reviewDocument(
  doc: FlowDocument,
  action: "void_document" | "correct_document",
  reason: string,
  correctionText: string,
  replacementId: string | null,
  requestId: string,
): Promise<void> {
  await inventoryRpc(action, {
    document_id: doc.id,
    expected_version: doc.version,
    reason,
    request_id: requestId,
    ...(action === "correct_document"
      ? {
          correction_text: correctionText,
          replacement_document_id: replacementId,
        }
      : {}),
  });
}
