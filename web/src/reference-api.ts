import { inventoryRpc } from "./accounts";
import { uuidPattern, type ReferenceKind } from "./references";
export async function resolveReference(
  kind: ReferenceKind,
  reference: string,
): Promise<string> {
  if (uuidPattern.test(reference)) return reference;
  const id = await inventoryRpc("resolve_reference", {
    entity_kind: kind,
    reference,
  });
  if (typeof id !== "string" || !uuidPattern.test(id))
    throw new Error("reference_not_found");
  return id;
}
