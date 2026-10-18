import jsQR from "jsqr";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { extractHints, type EvidenceHints } from "./evidence-model";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export const MAX_BYTES = 20 * 1024 * 1024;
function ensure(signal: AbortSignal) {
  signal.throwIfAborted();
}
function scan(canvas: HTMLCanvasElement): string[] {
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const values: string[] = [];
  for (let i = 0; i < 4; i++) {
    const code = jsQR(image.data, image.width, image.height, {
      inversionAttempts: "attemptBoth",
    });
    if (!code) break;
    values.push(code.data);
    const points = [
      code.location.topLeftCorner,
      code.location.topRightCorner,
      code.location.bottomLeftCorner,
      code.location.bottomRightCorner,
    ];
    const left = Math.max(
        0,
        Math.floor(Math.min(...points.map((p) => p.x))) - 3,
      ),
      right = Math.min(
        image.width,
        Math.ceil(Math.max(...points.map((p) => p.x))) + 3,
      );
    const top = Math.max(
        0,
        Math.floor(Math.min(...points.map((p) => p.y))) - 3,
      ),
      bottom = Math.min(
        image.height,
        Math.ceil(Math.max(...points.map((p) => p.y))) + 3,
      );
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++)
        image.data.fill(
          255,
          (y * image.width + x) * 4,
          (y * image.width + x) * 4 + 4,
        );
  }
  return values;
}
async function openPdf(bytes: Uint8Array, signal: AbortSignal) {
  const task = pdfjs.getDocument({
    data: bytes,
    enableXfa: false,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: true,
  });
  const stop = () => void task.destroy();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const pdf = await task.promise;
    ensure(signal);
    if (pdf.numPages < 1 || pdf.numPages > 20) {
      await task.destroy();
      throw new Error("pdf_page_limit_exceeded");
    }
    return {
      pdf,
      close: async () => {
        signal.removeEventListener("abort", stop);
        await task.destroy();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", stop);
    await task.destroy();
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && error.message === "pdf_page_limit_exceeded")
      throw error;
    throw new Error("invalid_or_encrypted_pdf");
  }
}
function canvasFor(width: number, height: number) {
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width * scale));
  c.height = Math.max(1, Math.round(height * scale));
  return { canvas: c, scale };
}
export async function recognizeEvidence(
  file: File,
  signal: AbortSignal,
  progress: (value: string) => void = () => {},
): Promise<{ hints: EvidenceHints; pages: number; mediaType: string }> {
  if (!file.size) throw new Error("invalid_evidence_file");
  if (file.size > MAX_BYTES) throw new Error("evidence_file_too_large");
  ensure(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  ensure(signal);
  const values: string[] = [];
  let pages = 1;
  let mediaType: string;
  if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") {
    mediaType = "application/pdf";
    const { pdf, close } = await openPdf(bytes, signal);
    pages = pdf.numPages;
    try {
      for (let n = 1; n <= pages; n++) {
        ensure(signal);
        progress(`正在识别第 ${n} / ${pages} 页…`);
        const p = await pdf.getPage(n);
        const text = await p.getTextContent();
        values.push(text.items.map((i) => ("str" in i ? i.str : "")).join(" "));
        const viewport = p.getViewport({ scale: 1 });
        const { canvas, scale } = canvasFor(
          viewport.width * 2,
          viewport.height * 2,
        );
        const context = canvas.getContext("2d")!;
        await p.render({
          canvas,
          canvasContext: context,
          viewport: p.getViewport({ scale: scale * 2 }),
        }).promise;
        ensure(signal);
        values.push(...scan(canvas));
        p.cleanup();
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      await close();
    }
  } else {
    mediaType =
      bytes[0] === 0x89
        ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8
          ? "image/jpeg"
          : "";
    if (!mediaType) throw new Error("unsupported_evidence_file");
    let image: ImageBitmap;
    try {
      image = await createImageBitmap(new Blob([bytes], { type: mediaType }));
    } catch {
      throw new Error("invalid_evidence_file");
    }
    try {
      if (image.width * image.height > 40000000)
        throw new Error("image_dimensions_exceeded");
      ensure(signal);
      const { canvas } = canvasFor(image.width, image.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      values.push(...scan(canvas));
    } finally {
      image.close();
    }
  }
  ensure(signal);
  return { hints: extractHints(values), pages, mediaType };
}
export async function previewPage(
  blob: Blob,
  mediaType: string,
  pageNumber: number,
  signal: AbortSignal,
): Promise<{ url: string; pages: number }> {
  ensure(signal);
  if (mediaType !== "application/pdf")
    return { url: URL.createObjectURL(blob), pages: 1 };
  const { pdf, close } = await openPdf(
    new Uint8Array(await blob.arrayBuffer()),
    signal,
  );
  try {
    if (pageNumber < 1 || pageNumber > pdf.numPages)
      throw new Error("invalid_evidence_file");
    const p = await pdf.getPage(pageNumber);
    const viewport = p.getViewport({ scale: 1 });
    const { canvas, scale } = canvasFor(
      viewport.width * 2,
      viewport.height * 2,
    );
    await p.render({
      canvas,
      canvasContext: canvas.getContext("2d")!,
      viewport: p.getViewport({ scale: scale * 2 }),
    }).promise;
    ensure(signal);
    const image = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("invalid_evidence_file"))),
        "image/png",
      ),
    );
    return { url: URL.createObjectURL(image), pages: pdf.numPages };
  } finally {
    await close();
  }
}
