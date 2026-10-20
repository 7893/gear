export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const referencePattern =
  /^[A-Z]{2}-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
export type ReferenceRecord = {
  id: string;
  reference_code?: string;
  created_at?: string;
  uploaded_at?: string | null;
};
// Matches the database encoder; used for older exports with no reference field.
export function recordCode(prefix: string, record: ReferenceRecord): string {
  if (record.reference_code && referencePattern.test(record.reference_code))
    return record.reference_code;
  if (!uuidPattern.test(record.id)) throw new Error("reference_not_found");
  let value = BigInt("0x" + record.id.replaceAll("-", "").slice(-10));
  let token = "";
  for (let i = 0; i < 8; i++) {
    token = alphabet[Number(value % 32n)] + token;
    value /= 32n;
  }
  const date = record.created_at || record.uploaded_at;
  const year = date
    ? new Intl.DateTimeFormat("en", {
        timeZone: "Asia/Shanghai",
        year: "2-digit",
      }).format(new Date(date))
    : "00";
  return `${prefix}-${year}-${token.slice(0, 4)}-${token.slice(4)}`;
}
export type ReferenceKind = "asset" | "document" | "party";
export function recordPath(
  kind: ReferenceKind,
  record: ReferenceRecord,
): string {
  const folder = { asset: "assets", document: "documents", party: "parties" }[
    kind
  ];
  return `/${folder}/${encodeURIComponent(record.reference_code || record.id)}`;
}
export function scanPath(kind: "asset" | "document", code: string): string {
  return `/scan/${kind}/${encodeURIComponent(code)}`;
}
export function returnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 180) return null;
  return /^\/scan\/(asset|document)\/[A-Z0-9-]{1,64}$/.test(value)
    ? value
    : null;
}
