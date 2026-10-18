import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import { handle, type Environment } from "../handler.ts";
import { hints, readBounded, verifyFile, MAX_FILE_BYTES } from "../files.ts";
const id = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const env: Environment = {
  SUPABASE_URL: "https://database.example.invalid/",
  SUPABASE_ANON_KEY: "example-anon",
  SUPABASE_SERVICE_ROLE_KEY: "example-service",
  GEAR_STORAGE_BUCKET: "example-evidence",
  GEAR_EVIDENCE_APP_URL: "https://app.example.invalid/",
  GEAR_EVIDENCE_ENABLED: "true",
};
async function pdf(pages = 2) {
  const p = await PDFDocument.create();
  for (let i = 0; i < pages; i++) p.addPage();
  return new Uint8Array(await p.save());
}
function upload(file: Uint8Array, requestId = id(3)) {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(file)], "示例签字件.pdf", {
      type: "application/pdf",
    }),
  );
  form.set("document_id", id(1));
  form.set("expected_version", "3");
  form.set("request_id", requestId);
  form.set(
    "recognition",
    JSON.stringify({ document_ids: [id(1)], document_numbers: [] }),
  );
  return new Request("https://api.example.invalid/functions/v1/gear-evidence", {
    method: "POST",
    headers: {
      Authorization: "Bearer example-user",
      Origin: "https://app.example.invalid",
    },
    body: form,
  });
}
function fixture(bytes: Uint8Array) {
  let ready = false,
    stored = false,
    deny = false,
    denyAfterRead = false,
    attest = 0,
    readChecks = 0;
  const paths: string[] = [];
  let reservedPayload: unknown;
  let failure = false;
  const attachment = {
    id: id(2),
    document_id: id(1),
    storage_key: id(2) + "/" + id(4),
    original_name: "示例签字件.pdf",
    media_type: "application/pdf",
    size_bytes: bytes.length,
    sha256: "",
    upload_state: "pending",
    is_active: true,
  };
  const send: typeof fetch = async (input, init) => {
    const url = String(input);
    const p = new URL(url).pathname;
    paths.push(p);
    const headers = new Headers(init?.headers);
    assert.ok(url.startsWith(env.SUPABASE_URL));
    if (p === "/auth/v1/user") {
      assert.equal(headers.get("Authorization"), "Bearer example-user");
      return Response.json({ id: id(7) });
    }
    if (p === "/rest/v1/rpc/reserve_attachment") {
      if (deny)
        return Response.json(
          { message: "inventory_access_denied" },
          { status: 403 },
        );
      reservedPayload = JSON.parse(String(init?.body));
      return Response.json(attachment);
    }
    if (p === "/rest/v1/rpc/get_attachment") {
      readChecks++;
      if (deny || (denyAfterRead && readChecks > 1))
        return Response.json(
          { message: "inventory_access_denied" },
          { status: 403 },
        );
      return Response.json({
        ...attachment,
        upload_state: ready ? "ready" : "pending",
      });
    }
    if (p === "/rest/v1/rpc/commit_attachment") {
      assert.equal(headers.get("Authorization"), "Bearer example-service");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.actor_auth_id, id(7));
      assert.equal(body.verified.size_bytes, bytes.length);
      assert.equal(body.verified.page_count, 2);
      assert.equal(body.verified.recognition.document_ids[0], id(1));
      if (deny)
        return Response.json(
          { message: "inventory_access_denied" },
          { status: 403 },
        );
      ready = true;
      attest++;
      attachment.sha256 = body.verified.sha256;
      return Response.json({ ...attachment, upload_state: "ready" });
    }
    if (p.startsWith("/storage/v1/object/")) {
      assert.equal(headers.get("Authorization"), "Bearer example-service");
      if (init?.method === "POST") {
        assert.equal(headers.get("x-upsert"), "false");
        if (failure) {
          stored = true;
          return Response.json({ error: "already exists" }, { status: 409 });
        }
        stored = true;
        return Response.json({});
      }
      if (stored) return new Response(new Uint8Array(bytes));
      return new Response(null, { status: 404 });
    }
    throw new Error("Unexpected mock request");
  };
  return {
    send,
    paths,
    attachment,
    get attest() {
      return attest;
    },
    get reservedPayload() {
      return reservedPayload;
    },
    setDeny: () => {
      deny = true;
    },
    setDenyAfterRead: () => {
      readChecks = 0;
      denyAfterRead = true;
    },
    loseStorageAck: () => {
      failure = true;
    },
  };
}
test("authenticated upload verifies actual bytes and never overwrites or repeats completed upload", async () => {
  const bytes = await pdf();
  const f = fixture(bytes);
  const result = await handle(upload(bytes), env, f.send);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).attachment.upload_state, "ready");
  assert.equal(f.attest, 1);
  const retry = await handle(upload(bytes), env, f.send);
  assert.equal(retry.status, 200);
  assert.equal(f.attest, 1);
  assert.equal(f.paths.filter((p) => p.startsWith("/storage/")).length, 1);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  const payload = f.reservedPayload as {
    details: { size_bytes: number; sha256: string; media_type: string };
  };
  assert.equal(payload.details.size_bytes, bytes.length);
  assert.match(payload.details.sha256, /^[0-9a-f]{64}$/);
  assert.equal(payload.details.media_type, "application/pdf");
});
test("lost Storage acknowledgement verifies the existing immutable original before completion", async () => {
  const bytes = await pdf();
  const f = fixture(bytes);
  f.loseStorageAck();
  const result = await handle(upload(bytes), env, f.send);
  assert.equal(result.status, 200);
  assert.equal(f.attest, 1);
  assert.equal(f.paths.filter((p) => p.startsWith("/storage/")).length, 2);
});
test("anonymous, disabled feature, disallowed origin and rejected membership never write Storage", async () => {
  const bytes = await pdf();
  const f = fixture(bytes);
  assert.equal(
    (await handle(new Request("https://api.example.invalid/"), env, f.send))
      .status,
    401,
  );
  assert.equal(
    (
      await handle(
        upload(bytes),
        { ...env, GEAR_EVIDENCE_ENABLED: "false" },
        f.send,
      )
    ).status,
    503,
  );
  const request = upload(bytes);
  request.headers.set("Origin", "https://other.example.invalid");
  assert.equal((await handle(request, env, f.send)).status, 403);
  f.setDeny();
  const denied = await handle(upload(bytes), env, f.send);
  assert.equal(denied.status, 403);
  assert.equal(f.paths.filter((p) => p.startsWith("/storage/")).length, 0);
});
test("download rechecks current membership and preserves byte identity, MIME and private response headers", async () => {
  const bytes = await pdf();
  const f = fixture(bytes);
  await handle(upload(bytes), env, f.send);
  const get = () =>
    new Request(
      "https://api.example.invalid/functions/v1/gear-evidence?attachment_id=" +
        id(2),
      { headers: { Authorization: "Bearer example-user" } },
    );
  const result = await handle(get(), env, f.send);
  assert.equal(result.status, 200);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  assert.equal(result.headers.get("Content-Type"), "application/pdf");
  assert.match(
    result.headers.get("Content-Disposition")!,
    /filename\*=UTF-8''/,
  );
  assert.match(result.headers.get("Content-Security-Policy")!, /sandbox/);
  f.setDenyAfterRead();
  assert.equal((await handle(get(), env, f.send)).status, 403);
});
test("invalid MIME signatures, encrypted or malformed PDF, excessive pages and bounded body fail safely", async () => {
  await assert.rejects(
    verifyFile(new TextEncoder().encode("<svg onload=alert(1)>"), "fake.png"),
    /unsupported_evidence_file/,
  );
  await assert.rejects(
    verifyFile(new TextEncoder().encode("%PDF-broken"), "broken.pdf"),
    /invalid_or_encrypted_pdf/,
  );
  await assert.rejects(
    verifyFile(await pdf(21), "too-many.pdf"),
    /pdf_page_limit_exceeded/,
  );
  await assert.rejects(
    verifyFile(new Uint8Array(MAX_FILE_BYTES + 1), "too-big.png"),
    /invalid_evidence_file/,
  );
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(8));
      c.enqueue(new Uint8Array(8));
      c.close();
    },
  });
  await assert.rejects(readBounded(stream, 10), /evidence_file_too_large/);
  assert.throws(
    () =>
      hints({
        document_ids: ["https://malicious.example.invalid/"],
        document_numbers: [],
      }),
    /invalid_evidence_hints/,
  );
  const bytes = await pdf();
  const f = fixture(bytes);
  const request = upload(new TextEncoder().encode("not a PDF"));
  assert.equal((await handle(request, env, f.send)).status, 400);
  assert.equal(f.paths.filter((p) => p.startsWith("/storage/")).length, 0);
});

test("encrypted flag and malformed image containers are rejected; valid PNG is fingerprinted", async () => {
  const locked = await PDFDocument.create();
  locked.addPage();
  locked.context.trailerInfo.Encrypt = locked.context.register(
    locked.context.obj({ Filter: PDFName.of("Standard") }),
  );
  await assert.rejects(
    verifyFile(new Uint8Array(await locked.save()), "locked.pdf"),
    /invalid_or_encrypted_pdf/,
  );
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  const verified = await verifyFile(png, "示例.png");
  assert.equal(verified.media_type, "image/png");
  assert.equal(verified.page_count, 1);
  await assert.rejects(
    verifyFile(png.slice(0, 44), "broken.png"),
    /invalid_evidence_file/,
  );
  const huge = new Uint8Array(png);
  new DataView(huge.buffer).setUint32(16, 40000001);
  await assert.rejects(
    verifyFile(huge, "huge.png"),
    /image_dimensions_exceeded/,
  );
});
