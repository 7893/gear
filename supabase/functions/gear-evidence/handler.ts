import { hints, MAX_FILE_BYTES, readBounded, verifyFile } from "./files.ts";
export type Environment = Record<
  | "GEAR_DB_SCHEMA"
  | "SUPABASE_URL"
  | "SUPABASE_PUBLISHABLE_KEY"
  | "SUPABASE_SECRET_KEY"
  | "GEAR_STORAGE_BUCKET"
  | "GEAR_EVIDENCE_APP_URL"
  | "GEAR_EVIDENCE_ENABLED",
  string
>;
type Attachment = {
  id: string;
  document_id: string;
  storage_key: string;
  original_name: string;
  media_type: string;
  upload_state: string;
  size_bytes: number;
  sha256: string;
  is_active: boolean;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const codes = new Set([
  "invalid_evidence_hints",
  "image_dimensions_exceeded",
  "invalid_evidence_file",
  "unsupported_evidence_file",
  "invalid_or_encrypted_pdf",
  "pdf_page_limit_exceeded",
  "evidence_file_too_large",
  "attachment_not_found",
  "attachment_conflict",
  "evidence_document_unavailable",
  "document_conflict",
  "inventory_access_denied",
  "archived_evidence_admin_required",
  "duplicate_attachment",
  "evidence_limit_exceeded",
  "request_conflict",
  "invalid_evidence",
  "upload_incomplete",
  "attachment_cancelled",
  "evidence_unavailable",
  "login_required",
]);
export async function handle(
  request: Request,
  env: Environment,
  send: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    Vary: "Origin",
  });
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers });
  try {
    const allowed = new URL(env.GEAR_EVIDENCE_APP_URL);
    if (allowed.protocol !== "https:" || allowed.origin + "/" !== allowed.href)
      throw new Error("evidence_unavailable");
    const origin = request.headers.get("Origin");
    if (origin && origin !== allowed.origin)
      return json({ error: "origin_not_allowed" }, 403);
    headers.set("Access-Control-Allow-Origin", allowed.origin);
    headers.set(
      "Access-Control-Allow-Headers",
      "authorization, apikey, content-type, x-client-info",
    );
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (
      !env.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_") ||
      !env.SUPABASE_SECRET_KEY.startsWith("sb_secret_") ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(env.GEAR_DB_SCHEMA)
    )
      throw new Error("evidence_unavailable");
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (env.GEAR_EVIDENCE_ENABLED !== "true")
      throw new Error("evidence_unavailable");
    if (!["GET", "POST"].includes(request.method))
      return json({ error: "method_not_allowed" }, 405);
    const authorization = request.headers.get("Authorization") || "";
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization))
      throw new Error("login_required");
    const base = new URL(env.SUPABASE_URL);
    if (
      base.protocol !== "https:" ||
      base.origin + "/" !== base.href ||
      !/^[a-z0-9-]{3,63}$/.test(env.GEAR_STORAGE_BUCKET)
    )
      throw new Error("evidence_unavailable");
    const upstream = (path: string, init: RequestInit = {}) =>
      send(base.origin + path, {
        ...init,
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
    const userHeaders = {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: authorization,
    };
    const serviceHeaders = {
      apikey: env.SUPABASE_SECRET_KEY,
      // An explicit empty field lets this project's gateway derive the server
      // identity from apikey. The opaque secret key is never a Bearer JWT.
      Authorization: "",
    };
    const identity = await upstream("/auth/v1/user", { headers: userHeaders });
    if (!identity.ok) throw new Error("login_required");
    const user = (await identity.json()) as { id?: string };
    if (!user.id || !UUID.test(user.id)) throw new Error("login_required");
    const rpc = async (name: string, body: unknown, service = false) => {
      const response = await upstream("/rest/v1/rpc/" + name, {
        method: "POST",
        headers: {
          ...(service ? serviceHeaders : userHeaders),
          "Content-Type": "application/json",
          "Content-Profile": env.GEAR_DB_SCHEMA,
        },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof data.message === "string" && codes.has(data.message)
            ? data.message
            : "upload_incomplete",
        );
      return data;
    };
    const objectPath = (item: Attachment) => {
      if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(item.storage_key))
        throw new Error("attachment_not_found");
      return (
        "/storage/v1/object/" + env.GEAR_STORAGE_BUCKET + "/" + item.storage_key
      );
    };
    if (request.method === "GET") {
      const id = new URL(request.url).searchParams.get("attachment_id");
      if (!id || !UUID.test(id)) throw new Error("attachment_not_found");
      const item = (await rpc("get_attachment", {
        attachment_id: id,
      })) as unknown as Attachment;
      if (item.upload_state !== "ready")
        throw new Error("attachment_not_found");
      const file = await upstream(objectPath(item), {
        headers: serviceHeaders,
      });
      if (!file.ok) throw new Error("attachment_not_found");
      const bytes = await readBounded(file.body, MAX_FILE_BYTES);
      const actual = await crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(bytes).buffer,
      );
      const hash = Array.from(new Uint8Array(actual), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== item.sha256 || bytes.length !== item.size_bytes)
        throw new Error("upload_incomplete");
      await rpc("get_attachment", { attachment_id: id });
      headers.set("Content-Type", item.media_type);
      headers.set(
        "Content-Disposition",
        "attachment; filename=\"evidence\"; filename*=UTF-8''" +
          encodeURIComponent(item.original_name),
      );
      return new Response(bytes, { headers });
    }
    if (
      !(request.headers.get("Content-Type") || "").startsWith(
        "multipart/form-data;",
      )
    )
      throw new Error("invalid_evidence_file");
    const bytes = await readBounded(request.body, MAX_FILE_BYTES + 65536);
    const form = await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("Content-Type")! },
    }).formData();
    const allowedFields = [
      "file",
      "document_id",
      "expected_version",
      "request_id",
      "recognition",
      "source_kind",
      "external_reference",
      "correction_reason",
    ];
    if (
      [...form.keys()].some((k) => !allowedFields.includes(k)) ||
      [...form.keys()].some((k) => form.getAll(k).length !== 1)
    )
      throw new Error("invalid_evidence");
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("invalid_evidence_file");
    const document_id = String(form.get("document_id"));
    const request_id = String(form.get("request_id"));
    const version = String(form.get("expected_version"));
    if (
      !UUID.test(document_id) ||
      !UUID.test(request_id) ||
      !/^[1-9][0-9]{0,8}$/.test(version)
    )
      throw new Error("invalid_evidence");
    const recognitionText = String(
      form.get("recognition") || '{"document_ids":[],"document_numbers":[]}',
    );
    if (recognitionText.length > 4096)
      throw new Error("invalid_evidence_hints");
    let recognition;
    try {
      recognition = hints(JSON.parse(recognitionText));
    } catch {
      throw new Error("invalid_evidence_hints");
    }
    const content = new Uint8Array(await file.arrayBuffer());
    const verified = await verifyFile(content, file.name);
    const details = {
      original_name: file.name,
      size_bytes: verified.size_bytes,
      sha256: verified.sha256,
      media_type: verified.media_type,
      source_kind: String(form.get("source_kind") || "internal"),
      external_reference: String(form.get("external_reference") || ""),
      correction_reason: String(form.get("correction_reason") || ""),
    };
    const reserved = (await rpc("reserve_attachment", {
      document_id,
      details,
      expected_version: Number(version),
      request_id,
    })) as unknown as Attachment;
    const current = (await rpc("get_attachment", {
      attachment_id: reserved.id,
    })) as unknown as Attachment;
    if (current.upload_state === "ready") return json({ attachment: current });
    if (current.upload_state !== "pending" || !current.is_active)
      throw new Error("attachment_cancelled");
    const stored = await upstream(objectPath(current), {
      method: "POST",
      headers: {
        ...serviceHeaders,
        "Content-Type": verified.media_type,
        "x-upsert": "false",
      },
      body: content,
    });
    if (!stored.ok) {
      const existing = await upstream(objectPath(current), {
        headers: serviceHeaders,
      });
      if (!existing.ok) throw new Error("upload_incomplete");
      const original = await readBounded(existing.body, MAX_FILE_BYTES);
      const check = await verifyFile(original, file.name);
      if (check.sha256 !== verified.sha256)
        throw new Error("upload_incomplete");
    }
    const result = await rpc(
      "commit_attachment",
      {
        attachment_id: current.id,
        actor_auth_id: user.id,
        verified: { ...verified, recognition },
      },
      true,
    );
    return json({ attachment: result });
  } catch (error) {
    const code =
      error instanceof Error && codes.has(error.message)
        ? error.message
        : "upload_incomplete";
    return json(
      { error: code },
      code === "login_required"
        ? 401
        : [
              "inventory_access_denied",
              "attachment_not_found",
              "archived_evidence_admin_required",
            ].includes(code)
          ? 403
          : code === "evidence_unavailable"
            ? 503
            : ["document_conflict", "attachment_conflict"].includes(code)
              ? 409
              : 400,
    );
  }
}
