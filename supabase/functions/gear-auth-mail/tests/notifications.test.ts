import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createNotificationHandler,
  type NotificationEnvironment,
} from "../notifications.ts";

const env: NotificationEnvironment = {
  GEAR_DB_SCHEMA: "example_app_2026",
  GEAR_NOTIFICATION_TOKEN: "example-only-scheduler-".repeat(3),
  GEAR_AUTH_APP_URL: "https://app.example.invalid/",
  GEAR_GMAIL_CLIENT_ID: "example-client",
  GEAR_GMAIL_CLIENT_SECRET: "example-client-secret",
  GEAR_GMAIL_REFRESH_TOKEN: "example-refresh",
  GEAR_MAIL_FROM: "sender@example.invalid",
  SUPABASE_URL: "https://backend.example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "example-server-only-key",
};
const job = {
  id: "00000000-0000-4000-8000-000000000001",
  lease_token: "00000000-0000-4000-8000-000000000002",
};
type Options = {
  claim?: () => Response;
  oauth?: () => Response;
  prepare?: () => Response;
  send?: () => Response;
  finish?: () => Response;
};
function fixture(options: Options = {}, configuration = env) {
  const calls: {
    name: string;
    body: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    let name: keyof Options;
    let body: Record<string, unknown>;
    if (url.origin === env.SUPABASE_URL) {
      assert.equal(headers.get("Content-Profile"), "example_app_2026");
      assert.equal(
        headers.get("Authorization"),
        "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      );
      const rpc = url.pathname.split("/").at(-1);
      name = (
        {
          claim_account_notification: "claim",
          prepare_account_notification: "prepare",
          finish_account_notification: "finish",
        } as const
      )[rpc as "claim_account_notification"];
      assert.ok(name);
      body = JSON.parse(String(init?.body));
    } else if (url.href === "https://oauth2.googleapis.com/token") {
      name = "oauth";
      body = Object.fromEntries(new URLSearchParams(String(init?.body)));
    } else {
      assert.equal(
        url.href,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      );
      assert.equal(headers.get("Authorization"), "Bearer example-access");
      name = "send";
      body = JSON.parse(String(init?.body));
    }
    calls.push({ name, body, headers });
    const respond = options[name];
    if (respond) return respond();
    return Response.json(
      {
        claim: job,
        oauth: { access_token: "example-access" },
        prepare: {
          to: "current@example.invalid",
          notification: { kind: "application_approved", role: "viewer" },
        },
        send: { id: "example-message" },
        finish: true,
      }[name],
    );
  };
  const handler = createNotificationHandler(configuration, fetcher);
  const request = (
    authorization = "Bearer " + env.GEAR_NOTIFICATION_TOKEN,
    method = "POST",
  ) =>
    new Request("https://function.example.invalid/", {
      method,
      headers: { Authorization: authorization },
      ...(method === "POST"
        ? {
            body: JSON.stringify({
              to: "ignored@example.invalid",
              text: "ignored",
            }),
          }
        : {}),
    });
  return { calls, handler, request };
}

test("notification endpoint accepts only the dedicated server token before provider or database calls", async () => {
  const f = fixture();
  for (const value of [
    "",
    "Bearer example-browser-key",
    "Bearer " + env.GEAR_NOTIFICATION_TOKEN + "x",
  ])
    assert.equal((await f.handler(f.request(value))).status, 401);
  assert.equal((await f.handler(f.request(undefined, "GET"))).status, 405);
  assert.equal(f.calls.length, 0);
  const missing = fixture(
    {},
    { ...env, GEAR_DB_SCHEMA: "example_app_2026", GEAR_NOTIFICATION_TOKEN: "" },
  );
  assert.equal((await missing.handler(missing.request())).status, 503);
  const invalid = fixture(
    {},
    { ...env, GEAR_AUTH_APP_URL: "https://app.example.invalid/extra" },
  );
  assert.equal((await invalid.handler(invalid.request())).status, 503);
  assert.equal(invalid.calls.length, 0);
});

test("idle or disabled worker never refreshes OAuth or sends", async () => {
  const f = fixture({ claim: () => Response.json(null) });
  const result = await f.handler(f.request());
  assert.deepEqual(await result.json(), { result: "idle" });
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ["claim"],
  );
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), null);
});

test("notification submission uses current database recipient, Chinese MIME and fenced result", async () => {
  const f = fixture();
  assert.equal((await f.handler(f.request())).status, 200);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ["claim", "oauth", "prepare", "send", "finish"],
  );
  const mime = Buffer.from(String(f.calls[3].body.raw), "base64url").toString(
    "utf8",
  );
  assert.match(mime, /To: <current@example.invalid>/);
  assert.doesNotMatch(
    mime,
    /ignored@example.invalid|example-server-only-key|example-refresh/,
  );
  assert.match(mime, /Content-Type: text\/plain; charset=UTF-8/);
  const text = Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString(
    "utf8",
  );
  assert.match(text, /使用申请已通过/);
  assert.match(text, /当前权限：查询人/);
  assert.match(text, /https:\/\/app.example.invalid\/#\//);
  assert.deepEqual(f.calls[4].body, {
    job_id: job.id,
    token: job.lease_token,
    outcome: "submitted",
    message_id: "example-message",
    failure_code: null,
    retry_seconds: 60,
  });
});

test("pending and rejected notifications reuse their fixed Chinese templates", async () => {
  for (const [notification, expected] of [
    [
      { kind: "application_pending", applicantName: "示例申请人" },
      "有新的使用申请待审核",
    ],
    [{ kind: "application_rejected" }, "使用申请未通过"],
  ] as const) {
    const f = fixture({
      prepare: () =>
        Response.json({ to: "current@example.invalid", notification }),
    });
    await f.handler(f.request());
    const mime = Buffer.from(
      String(f.calls.find((c) => c.name === "send")?.body.raw),
      "base64url",
    ).toString("utf8");
    assert.match(
      Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString("utf8"),
      new RegExp(expected),
    );
  }
});

test("OAuth rejection and failures cannot send; transient failures can be retried later", async () => {
  for (const [oauth, code] of [
    [
      () =>
        Response.json(
          { error: "invalid_grant", private: "must not escape" },
          { status: 400 },
        ),
      "mail_authorization",
    ],
    [
      () => {
        throw new Error("private network diagnostic");
      },
      "oauth_temporary",
    ],
    [() => Response.json({}, { status: 503 }), "oauth_temporary"],
  ] as const) {
    const f = fixture({ oauth });
    const response = await f.handler(f.request());
    assert.equal(response.status, 200);
    assert.deepEqual(
      f.calls.map((c) => c.name),
      ["claim", "oauth", "finish"],
    );
    assert.equal(f.calls.at(-1)?.body.failure_code, code);
    assert.doesNotMatch(await response.text(), /private|example-refresh/);
  }
});

test("eligibility cancelled or prepare acknowledgement lost never submits", async () => {
  for (const prepare of [
    () => Response.json(null),
    () => {
      throw new Error("uncertain transaction");
    },
  ]) {
    const f = fixture({ prepare });
    await f.handler(f.request());
    assert.deepEqual(
      f.calls.map((c) => c.name),
      ["claim", "oauth", "prepare"],
    );
  }
});

test("provider refusal records bounded retry only for definite authorization or rate rejection", async () => {
  for (const [status, details, code] of [
    [429, {}, "provider_rate_limit"],
    [401, {}, "provider_unauthorized"],
    [
      403,
      { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
      "provider_rate_limit",
    ],
    [
      403,
      { error: { errors: [{ reason: "domainPolicy" }] } },
      "provider_rejected",
    ],
    [400, {}, "provider_rejected"],
  ] as const) {
    const f = fixture({
      send: () =>
        Response.json(details, { status, headers: { "Retry-After": "120" } }),
    });
    await f.handler(f.request());
    assert.equal(f.calls.filter((c) => c.name === "send").length, 1);
    assert.equal(f.calls.at(-1)?.body.failure_code, code);
    if (code === "provider_rate_limit")
      assert.equal(f.calls.at(-1)?.body.retry_seconds, 120);
  }
});

test("timeouts, server errors and malformed success stay unknown without resend", async () => {
  for (const send of [
    () => {
      throw new Error("lost response after submission");
    },
    () => Response.json({}, { status: 503 }),
    () => Response.json({}),
    () => new Response("not JSON", { status: 200 }),
  ]) {
    const f = fixture({ send });
    const response = await f.handler(f.request());
    assert.deepEqual(await response.json(), { result: "unknown" });
    assert.equal(f.calls.at(-1)?.body.outcome, "unknown");
    assert.equal(f.calls.filter((c) => c.name === "send").length, 1);
  }
});

test("lost completion acknowledgement never repeats provider submission", async () => {
  const f = fixture({
    finish: () => {
      throw new Error("lost result");
    },
  });
  const response = await f.handler(f.request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { result: "result_not_recorded" });
  assert.equal(f.calls.filter((c) => c.name === "send").length, 1);
});

test("daily digest uses existing Chinese MIME and sends one message per invocation", async () => {
  const f = fixture({
    prepare: () =>
      Response.json({
        to: "operator@example.invalid",
        notification: {
          kind: "daily_due",
          businessDate: "2030-01-01",
          dueSoon: 2,
          dueToday: 1,
          overdue: 3,
        },
      }),
  });
  assert.equal((await f.handler(f.request())).status, 200);
  const sent = f.calls.filter((c) => c.name === "send");
  assert.equal(sent.length, 1);
  const mime = Buffer.from(String(sent[0].body.raw), "base64url").toString(
    "utf8",
  );
  assert.match(mime, /charset=UTF-8/i);
  assert.match(mime, /Content-Transfer-Encoding: base64/i);
  assert.equal(f.calls.at(-1)?.body.outcome, "submitted");
});
test("invalid digest is quarantined without provider submission", async () => {
  const f = fixture({
    prepare: () =>
      Response.json({
        to: "operator@example.invalid",
        notification: {
          kind: "daily_due",
          businessDate: "2030-01-01",
          dueSoon: -1,
          dueToday: 0,
          overdue: 0,
        },
      }),
  });
  await f.handler(f.request());
  assert.equal(
    f.calls.some((c) => c.name === "send"),
    false,
  );
  assert.equal(f.calls.at(-1)?.body.failure_code, "invalid_message");
});
