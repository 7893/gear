import { PDFDocument } from "pdf-lib";
export const MAX_FILE_BYTES = 20971520;
export type Hints = { document_ids: string[]; document_numbers: string[] };
export function hints(value: unknown): Hints {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_evidence_hints");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !["document_ids", "document_numbers"].includes(k),
    )
  )
    throw new Error("invalid_evidence_hints");
  for (const [key, pattern] of [
    [
      "document_ids",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ],
    ["document_numbers", /^(LR|FF|TH|ZJ)-[0-9]{8}-[0-9]{4,19}$/],
  ] as const) {
    const items = v[key];
    if (
      !Array.isArray(items) ||
      items.length > 20 ||
      items.some((s) => typeof s !== "string" || !pattern.test(s))
    )
      throw new Error("invalid_evidence_hints");
  }
  return {
    document_ids: [...new Set(v.document_ids as string[])],
    document_numbers: [...new Set(v.document_numbers as string[])],
  };
}
function dimensions(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 40000000
  )
    throw new Error("image_dimensions_exceeded");
}
export async function verifyFile(bytes: Uint8Array, name: string) {
  if (
    !bytes.length ||
    bytes.length > MAX_FILE_BYTES ||
    name.length > 180 ||
    /[/\\\u0000-\u001f\u007f]/.test(name)
  )
    throw new Error("invalid_evidence_file");
  let media_type: string;
  let page_count = 1;
  if (
    bytes[0] === 0x89 &&
    new TextDecoder().decode(bytes.slice(1, 8)) === "PNG\r\n\x1a\n"
  ) {
    if (
      bytes.length < 45 ||
      new TextDecoder().decode(bytes.slice(12, 16)) !== "IHDR" ||
      !/\.png$/i.test(name)
    )
      throw new Error("invalid_evidence_file");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    dimensions(view.getUint32(16), view.getUint32(20));
    let offset = 8;
    let data = false;
    let end = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = new TextDecoder().decode(
        bytes.slice(offset + 4, offset + 8),
      );
      if (
        offset + 12 + length > bytes.length ||
        (offset === 8 && (type !== "IHDR" || length !== 13))
      )
        throw new Error("invalid_evidence_file");
      if (type === "IDAT") data = true;
      if (type === "IEND") {
        if (length !== 0 || offset + 12 !== bytes.length)
          throw new Error("invalid_evidence_file");
        end = true;
        break;
      }
      offset += 12 + length;
    }
    if (!data || !end) throw new Error("invalid_evidence_file");

    media_type = "image/png";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    if (
      !/\.jpe?g$/i.test(name) ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9
    )
      throw new Error("invalid_evidence_file");
    let found = false;
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error("invalid_evidence_file");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length)
        throw new Error("invalid_evidence_file");
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8) throw new Error("invalid_evidence_file");
        dimensions(
          bytes[offset + 5] * 256 + bytes[offset + 6],
          bytes[offset + 3] * 256 + bytes[offset + 4],
        );
        found = true;
        break;
      }
      offset += length;
    }
    if (!found) throw new Error("invalid_evidence_file");
    media_type = "image/jpeg";
  } else if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") {
    if (!/\.pdf$/i.test(name)) throw new Error("invalid_evidence_file");
    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(bytes, {
        updateMetadata: false,
        throwOnInvalidObject: true,
      });
    } catch {
      throw new Error("invalid_or_encrypted_pdf");
    }
    page_count = pdf.getPageCount();
    media_type = "application/pdf";
    if (page_count < 1 || page_count > 20)
      throw new Error("pdf_page_limit_exceeded");
  } else throw new Error("unsupported_evidence_file");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  const sha256 = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return { media_type, page_count, sha256, size_bytes: bytes.length };
}
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) throw new Error("invalid_evidence_file");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("evidence_file_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}
