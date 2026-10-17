import assert from "node:assert/strict";
import { mock, test } from "node:test";
import gateway from "../src/index.ts";

const env = {
  SUPABASE_URL: "https://upstream.example.com",
  FRONTEND_ORIGIN: "https://app.example.com",
  GEAR_DB_SCHEMA: "gear",
  GEAR_STORAGE_BUCKET: "gear-attachments",
  GEAR_FUNCTION_PREFIX: "gear-",
};

test("health is public, uncached and does not reveal upstream configuration", async () => {
  const response = await gateway.fetch(
    new Request("https://api.example.com/healthz"),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.doesNotMatch(await response.text(), /upstream\.example/);
});

test("rejects other origins, admin APIs and other application resources", async () => {
  for (const path of [
    "/auth/v1/admin/users",
    "/storage/v1/object/another-bucket/file.pdf",
    "/storage/v1/object/sign/another-bucket/file.pdf",
    "/functions/v1/another-function",
    "/storage/v1/object/gear-attachments%2fanother/file.pdf",
  ]) {
    const response = await gateway.fetch(
      new Request("https://api.example.com" + path),
      env,
    );
    assert.equal(response.status, 404);
  }
  const response = await gateway.fetch(
    new Request("https://api.example.com/healthz", {
      headers: { Origin: "https://other.example.com" },
    }),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("preflight allows only the configured frontend", async () => {
  const response = await gateway.fetch(
    new Request("https://api.example.com/rest/v1/devices", {
      method: "OPTIONS",
      headers: { Origin: env.FRONTEND_ORIGIN },
    }),
    env,
  );
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    env.FRONTEND_ORIGIN,
  );
});

test("requires caller API key and rejects an alternate database schema", async () => {
  const response = await gateway.fetch(
    new Request("https://api.example.com/rest/v1/devices"),
    env,
  );
  assert.equal(response.status, 401);
  const otherSchema = await gateway.fetch(
    new Request("https://api.example.com/rest/v1/devices", {
      headers: { apikey: "fictional", "Accept-Profile": "public" },
    }),
    env,
  );
  assert.equal(otherSchema.status, 403);
});

test("pins database schema, preserves caller authorization and disables caching", async () => {
  const stub = mock.method(globalThis, "fetch", async (request, options) => {
    assert.equal(new URL(request.url).origin, env.SUPABASE_URL);
    assert.equal(request.headers.get("Accept-Profile"), "gear");
    assert.equal(request.headers.get("Content-Profile"), "gear");
    assert.equal(request.headers.get("Authorization"), "Bearer fictional");
    assert.equal(request.headers.get("Cookie"), null);
    assert.equal(options.cf.cacheTtl, 0);
    return new Response("[]", {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  });
  try {
    const response = await gateway.fetch(
      new Request("https://api.example.com/rest/v1/devices", {
        headers: {
          apikey: "fictional",
          Authorization: "Bearer fictional",
          Cookie: "unrelated=fictional",
        },
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(stub.mock.callCount(), 1);
  } finally {
    stub.mock.restore();
  }
});

test("streams uploads into the dedicated bucket without following redirects", async () => {
  const stub = mock.method(globalThis, "fetch", async (request) => {
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.equal(await request.text(), "fictional attachment");
    return Response.json({ uploaded: true });
  });
  try {
    const response = await gateway.fetch(
      new Request(
        "https://api.example.com/storage/v1/object/gear-attachments/test.txt",
        {
          method: "POST",
          headers: { apikey: "fictional", "Content-Type": "text/plain" },
          body: "fictional attachment",
        },
      ),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(stub.mock.callCount(), 1);
  } finally {
    stub.mock.restore();
  }
});
