import assert from "node:assert/strict";
import { mock, test } from "node:test";
import gateway from "../src/index.ts";

const env = {
  SUPABASE_URL: "https://upstream.example.com",
  FRONTEND_ORIGIN: "https://app.example.com",
  GEAR_DB_SCHEMA: "example_app_2026",
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
  assert.match(
    response.headers.get("Access-Control-Expose-Headers") || "",
    /x-supabase-api-version/,
  );
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
    assert.equal(request.headers.get("Accept-Profile"), env.GEAR_DB_SCHEMA);
    assert.equal(request.headers.get("Content-Profile"), env.GEAR_DB_SCHEMA);
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

test("verification resend is forwarded and logout only revokes the current session", async () => {
  const paths: string[] = [];
  const stub = mock.method(globalThis, "fetch", async (request) => {
    const url = new URL(request.url);
    paths.push(url.pathname);
    if (url.pathname.endsWith("/logout"))
      assert.equal(url.searchParams.get("scope"), "local");
    return Response.json({});
  });
  try {
    for (const path of ["/auth/v1/resend", "/auth/v1/logout?scope=global"]) {
      const response = await gateway.fetch(
        new Request("https://api.example.com" + path, {
          method: "POST",
          headers: { apikey: "fictional" },
          body: "{}",
        }),
        env,
      );
      assert.equal(response.status, 200);
    }
    assert.deepEqual(paths, ["/auth/v1/resend", "/auth/v1/logout"]);
  } finally {
    stub.mock.restore();
  }
});

test("email verification links work without placing an API key in the URL", async () => {
  const stub = mock.method(globalThis, "fetch", async (request) => {
    assert.equal(new URL(request.url).pathname, "/auth/v1/verify");
    assert.equal(request.headers.get("apikey"), null);
    return new Response(null, {
      status: 302,
      headers: { Location: env.FRONTEND_ORIGIN + "/?code=example" },
    });
  });
  try {
    const response = await gateway.fetch(
      new Request(
        "https://api.example.com/auth/v1/verify?token=example&type=signup",
      ),
      env,
    );
    assert.equal(response.status, 302);
  } finally {
    stub.mock.restore();
  }
});

test("legacy public profile maps only to configured namespace; private schemas stay forbidden", async () => {
  const seen: string[] = [];
  const stub = mock.method(globalThis, "fetch", async (request) => {
    seen.push(request.headers.get("Content-Profile"));
    return new Response("[]");
  });
  try {
    for (const profile of ["example_app_2026", "example_app"]) {
      const result = await gateway.fetch(
        new Request("https://api.example.com/rest/v1/rpc/list_assets", {
          method: "POST",
          headers: { apikey: "fictional", "Content-Profile": profile },
          body: "{}",
        }),
        env,
      );
      assert.equal(result.status, 200);
    }
    for (const profile of [
      "gear_private",
      "example_app_private_2026",
      "example_other_2026",
    ]) {
      const result = await gateway.fetch(
        new Request("https://api.example.com/rest/v1/rpc/list_assets", {
          method: "POST",
          headers: { apikey: "fictional", "Content-Profile": profile },
          body: "{}",
        }),
        env,
      );
      assert.equal(result.status, 403);
    }
    assert.deepEqual(seen, [env.GEAR_DB_SCHEMA, env.GEAR_DB_SCHEMA]);
  } finally {
    stub.mock.restore();
  }
});
