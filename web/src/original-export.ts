import { recordCode } from "./references";
import { zipSync } from "fflate";
import { inventoryRpc } from "./accounts";
import { downloadEvidence } from "./evidence";
import { businessToday } from "./inventory";
export type Original = {
  id: string;
  reference_code?: string;
  created_at?: string;
  document_id: string | null;
  event_id: string | null;
  original_name: string;
  size_bytes: number;
  sha256: string;
  media_type: string;
  is_active: boolean;
  review_state: string;
};
export async function originalsZip(signal: AbortSignal) {
  const query = () => inventoryRpc("list_originals") as Promise<Original[]>;
  const items = await query();
  signal.throwIfAborted();
  // Small synchronous ZIP needs no additional Worker/CSP allowance.
  if (
    items.length > 1000 ||
    items.reduce((sum, item) => sum + item.size_bytes, 0) > 25 * 1024 * 1024
  )
    throw new Error("original_export_too_large");
  if (!items.length) throw new Error("original_export_empty");
  const files: Record<string, Uint8Array> = {};
  for (const item of items) {
    signal.throwIfAborted();
    if (
      !/^[a-f0-9-]{36}$/.test(item.id) ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      /[/\\\x00-\x1f\x7f]/.test(item.original_name) ||
      [".", ".."].includes(item.original_name) ||
      !Number.isSafeInteger(item.size_bytes) ||
      item.size_bytes < 1
    )
      throw new Error("upload_incomplete");
    const blob = await downloadEvidence(item.id, signal);
    if (blob.size !== item.size_bytes) throw new Error("upload_incomplete");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== item.sha256) throw new Error("upload_incomplete");
    files[`originals/${recordCode("AT", item)}/${item.original_name}`] = bytes;
  }
  const latest = await query();
  signal.throwIfAborted();
  if (JSON.stringify(latest) !== JSON.stringify(items))
    throw new Error("attachment_conflict");
  const day = businessToday();
  files["manifest.json"] = new TextEncoder().encode(
    JSON.stringify(
      { format: "gear-originals-v1", business_on: day, items },
      null,
      2,
    ) + "\n",
  );
  const bytes = zipSync(files, { level: 0 });
  signal.throwIfAborted();
  return {
    blob: new Blob([new Uint8Array(bytes).buffer], { type: "application/zip" }),
    filename: `设备凭证原件-${day}.zip`,
    message: `已打包 ${items.length} 份原件及校验清单，已交由浏览器下载。`,
  };
}
