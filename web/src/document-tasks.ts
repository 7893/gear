import { evidenceStates } from "./evidence-model";
import type { FlowDocument } from "./flows-model";
export type EvidenceTask = "" | keyof typeof evidenceStates;
export function evidenceTask(value: unknown): EvidenceTask {
  return typeof value === "string" && Object.hasOwn(evidenceStates, value)
    ? (value as EvidenceTask)
    : "";
}
export function filterEvidenceTask(
  documents: FlowDocument[],
  task: EvidenceTask,
): FlowDocument[] {
  return task
    ? documents.filter(
        (doc) => doc.status === "confirmed" && doc.evidence_state === task,
      )
    : documents;
}
