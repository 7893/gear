import assert from "node:assert/strict";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import {
  createHandler,
  renderEmails,
  renderMime,
  type MailEnvironment,
} from "../handler.ts";
import { renderGearCodeEmail, renderGearNotification } from "../templates.ts";

const secret = Buffer.from("fictional webhook test material only").toString(
  "base64",
);
const env: MailEnvironment = {
  GEAR_AUTH_WEBHOOK_SECRET: secret,
  GEAR_AUTH_PUBLIC_URL: "https://api.example.invalid",
  GEAR_GMAIL_CLIENT_ID: "example-client",
  GEAR_GMAIL_CLIENT_SECRET: "example-secret",
  GEAR_GMAIL_REFRESH_TOKEN: "example-refresh",
  GEAR_MAIL_FROM: "sender@example.invalid",
};
const payload = {
  user: { email: "person@example.invalid" },
  email_data: {
    email_action_type: "signup",
    token: "123456",
    token_hash: "a".repeat(64),
    redirect_to: "https://app.example.invalid/",
  },
};

test("Chinese MIME subject and body round-trip without broken characters or overlong lines", () => {
  const subjects = [
    renderGearCodeEmail("signup", "000042").subject,
    renderGearCodeEmail("recovery", "000042").subject,
    "【设备簿】中文标题，含生僻字𠮷和标点。".repeat(12),
  ];
  const text =
    "中文通知：请输入验证码 000042。\n".repeat(60) + "末行\r单独换行\r\n结尾";
  for (const subject of subjects) {
    const mime = renderMime(
      { to: "person@example.invalid", subject, text },
      env.GEAR_MAIL_FROM,
    );
    assert.doesNotMatch(mime, /(?<!\r)\n|\r(?!\n)/);
    const [headers, body] = mime.split("\r\n\r\n");
    assert.match(headers, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(headers, /Content-Transfer-Encoding: base64/);
    const subjectHeader = headers.match(
      /Subject: ([\s\S]*?)\r\nMIME-Version:/,
    )?.[1];
    assert.ok(subjectHeader);
    const words = [...subjectHeader.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    assert.ok(words.length > 0);
    const decodedSubject = words
      .map(([word, value]) => {
        assert.ok(word.length <= 75);
        return new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(value, "base64"),
        );
      })
      .join("");
    assert.equal(decodedSubject, subject);
    for (const line of ("Subject: " + subjectHeader).split("\r\n"))
      assert.ok(line.length <= 76);
    for (const line of body.trimEnd().split("\r\n"))
      assert.ok(line.length <= 76);
    assert.equal(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(body, "base64"),
      ),
      text.replace(/\r\n|\r|\n/g, "\r\n"),
    );
  }
  assert.throws(
    () =>
      renderMime(
        {
          to: "person@example.invalid",
          subject: "标题\r\nBcc: other@example.invalid",
          text: "正文",
        },
        env.GEAR_MAIL_FROM,
      ),
    /invalid_subject/,
  );
});
function signed(value: unknown = payload, timestamp = new Date()): Request {
  const body = JSON.stringify(value);
  const id = "example-event";
  return new Request("https://hook.example.invalid/", {
    method: "POST",
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(timestamp.valueOf() / 1000)),
      "webhook-signature": new Webhook(secret).sign(id, timestamp, body),
    },
  });
}

test("rejects unsigned, tampered and expired calls before any provider request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  const handler = createHandler(env, fetcher);
  assert.equal(
    (
      await handler(
        new Request("https://hook.example.invalid/", {
          method: "POST",
          body: "{}",
        }),
      )
    ).status,
    401,
  );
  const original = signed();
  assert.equal(
    (
      await handler(
        new Request(original.url, {
          method: "POST",
          headers: original.headers,
          body: JSON.stringify({ ...payload, extra: true }),
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (await handler(signed(payload, new Date(Date.now() - 3600000)))).status,
    401,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await handler(
        new Request("https://hook.example.invalid/", {
          method: "POST",
          body: "x".repeat(32769),
        }),
      )
    ).status,
    413,
  );
});

test("OAuth and Gmail delivery use fixed hosts; UTF-8 mail contains no OAuth credentials", async () => {
  const calls: string[] = [];
  let raw = "";
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(String(input));
    if (String(input).includes("oauth2.googleapis.com"))
      return Response.json({
        access_token: "example-access",
        expires_in: 3600,
      });
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer example-access",
    );
    raw = Buffer.from(
      JSON.parse(String(init?.body)).raw,
      "base64url",
    ).toString();
    return Response.json({ id: "example-submission" });
  };
  const handler = createHandler(env, fetcher);
  assert.equal((await handler(signed())).status, 200);
  assert.equal((await handler(signed())).status, 200);
  assert.equal(
    calls.filter((url) => url.includes("oauth2.googleapis.com")).length,
    1,
  );
  assert.equal(
    calls.filter((url) => url.includes("gmail.googleapis.com")).length,
    2,
  );
  assert.match(raw, /To: <person@example\.invalid>/);
  const body = Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString("utf8");
  assert.match(body, /验证码：123456/);
  assert.match(body, /https:\/\/api\.example\.invalid\/auth\/v1\/verify/);
  assert.doesNotMatch(
    raw + body,
    /example-refresh|example-access|example-secret/,
  );
});

test("secure email change pairs each recipient with the correct Supabase hash", () => {
  const emails = renderEmails(
    {
      user: { email: "old@example.invalid", new_email: "new@example.invalid" },
      email_data: {
        email_action_type: "email_change",
        token: "123456",
        token_new: "654321",
        token_hash: "n".repeat(64),
        token_hash_new: "o".repeat(64),
      },
    },
    env.GEAR_AUTH_PUBLIC_URL,
  );
  assert.equal(emails.length, 2);
  assert.equal(emails[0].to, "new@example.invalid");
  assert.ok(
    emails[0].text.includes("n".repeat(64)) &&
      emails[0].text.includes("654321"),
  );
  assert.equal(emails[1].to, "old@example.invalid");
  assert.ok(
    emails[1].text.includes("o".repeat(64)) &&
      emails[1].text.includes("123456"),
  );
});

test("Gear signup sends only a six-digit code and rejects other code formats", async () => {
  const signup = {
    ...payload,
    user: {
      ...payload.user,
      user_metadata: { gear_application_name: "Example applicant" },
    },
    email_data: { ...payload.email_data, token: "000042" },
  };
  const [mail] = renderEmails(signup, env.GEAR_AUTH_PUBLIC_URL);
  assert.match(mail.text, /验证码：000042/);
  assert.doesNotMatch(mail.text, /https?:|验证链接|a{64}/);
  let calls = 0;
  const handler = createHandler(env, async () => {
    calls++;
    return Response.json({});
  });
  for (const token of [
    undefined,
    "12345",
    "1234567",
    "12345678",
    "12a456",
    "１２３４５６",
  ]) {
    const invalid = { ...signup, email_data: { ...signup.email_data, token } };
    assert.throws(
      () => renderEmails(invalid, env.GEAR_AUTH_PUBLIC_URL),
      /invalid_token/,
    );
    assert.equal((await handler(signed(invalid))).status, 400);
  }
  assert.equal(calls, 0);
  // Other applications retain their existing verification links.
  assert.match(
    renderEmails(payload, env.GEAR_AUTH_PUBLIC_URL)[0].text,
    /https:\/\//,
  );
});

test("recovery code templates cannot turn codes into links or passwords", () => {
  for (const purpose of ["signup", "recovery", "reauthentication"] as const) {
    const mail = renderGearCodeEmail(purpose, "000042");
    assert.match(mail.text, /验证码：000042/);
    assert.doesNotMatch(mail.text, /https?:|验证链接|新密码：|旧密码：/);
    for (const invalid of ["12345", "1234567", "１２３４５６", "123\n45"])
      assert.throws(
        () => renderGearCodeEmail(purpose, invalid),
        /invalid_token/,
      );
  }
  assert.notEqual(
    renderGearCodeEmail("recovery", "000042").subject,
    renderGearCodeEmail("signup", "000042").subject,
  );
});

test("notification links use only the configured HTTPS origin and reject empty due summaries", () => {
  const pending = renderGearNotification(
    { kind: "application_pending", applicantName: "Example applicant" },
    "https://app.example.invalid",
  );
  const links = pending.text.match(/https:\/\/\S+/g) || [];
  assert.deepEqual(links, ["https://app.example.invalid/#/members"]);
  for (const origin of [
    "http://app.example.invalid",
    "https://person:secret@app.example.invalid",
    "https://app.example.invalid/?token=example",
    "https://app.example.invalid/unexpected",
  ])
    assert.throws(
      () => renderGearNotification({ kind: "application_rejected" }, origin),
      /invalid_app_origin/,
    );
  for (const overdue of [-1, 0, 1.5, Number.NaN])
    assert.throws(
      () =>
        renderGearNotification(
          {
            kind: "daily_due",
            businessDate: "2030-01-01",
            dueSoon: 0,
            dueToday: 0,
            overdue,
          },
          "https://app.example.invalid",
        ),
      /invalid_due_summary/,
    );
});

test("supports the shared project's normal Auth actions and security notifications", () => {
  for (const action of [
    "signup",
    "invite",
    "magiclink",
    "recovery",
    "reauthentication",
    "password_changed_notification",
    "email_changed_notification",
    "phone_changed_notification",
    "identity_linked_notification",
    "identity_unlinked_notification",
    "mfa_factor_enrolled_notification",
    "mfa_factor_unenrolled_notification",
  ]) {
    assert.equal(
      renderEmails(
        {
          ...payload,
          email_data: {
            ...payload.email_data,
            email_action_type: action,
            old_email: "old@example.invalid",
          },
        },
        env.GEAR_AUTH_PUBLIC_URL,
      ).length,
      1,
    );
  }
  assert.throws(
    () =>
      renderEmails(
        {
          ...payload,
          user: {
            email: "person@example.invalid\r\nBcc: other@example.invalid",
          },
        },
        env.GEAR_AUTH_PUBLIC_URL,
      ),
    /invalid_address/,
  );
});

test("email-change security notice goes to the original email", () => {
  const changed = renderEmails(
    {
      ...payload,
      email_data: {
        email_action_type: "email_changed_notification",
        old_email: "old@example.invalid",
      },
    },
    env.GEAR_AUTH_PUBLIC_URL,
  );
  assert.equal(changed[0].to, "old@example.invalid");
});

test("unknown actions and uncertain delivery never trigger a local resend or leak diagnostics", async () => {
  let calls = 0;
  const handler = createHandler(env, async (input) => {
    calls++;
    if (String(input).includes("oauth2.googleapis.com"))
      return Response.json({ access_token: "example-access" });
    throw new Error("provider diagnostic contains example-secret");
  });
  const unknown = await handler(
    signed({ ...payload, email_data: { email_action_type: "unknown" } }),
  );
  assert.equal(unknown.status, 400);
  assert.equal(calls, 0);
  const failed = await handler(signed());
  assert.equal(failed.status, 503);
  assert.equal(calls, 2);
  assert.doesNotMatch(
    await failed.text(),
    /provider diagnostic|example-secret/,
  );
});

test("Gear recovery uses a six-digit template only for its configured callback", () => {
  const recovery = {
    ...payload,
    user: {
      ...payload.user,
      id: "00000000-0000-4000-8000-000000000001",
      user_metadata: { gear_application_name: "Example" },
    },
    email_data: { ...payload.email_data, email_action_type: "recovery" },
  };
  const [mail] = renderEmails(
    recovery,
    env.GEAR_AUTH_PUBLIC_URL,
    "https://app.example.invalid/",
  );
  assert.match(mail.subject, /找回登录密码/);
  assert.match(mail.text, /验证码：123456/);
  assert.doesNotMatch(mail.text, /https?:|a{64}/);
  const [other] = renderEmails(
    {
      ...recovery,
      email_data: {
        ...recovery.email_data,
        redirect_to: "https://other.example.invalid/",
      },
    },
    env.GEAR_AUTH_PUBLIC_URL,
    "https://app.example.invalid/",
  );
  assert.match(other.text, /验证链接/);
});

test("recovery checks server-only eligibility before Google and hides ineligible accounts", async () => {
  const configured: MailEnvironment = {
    ...env,
    GEAR_AUTH_APP_URL: "https://app.example.invalid/",
    SUPABASE_URL: "https://backend.example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "example-service-key",
  };
  const recovery = {
    ...payload,
    user: { ...payload.user, id: "00000000-0000-4000-8000-000000000001" },
    email_data: { ...payload.email_data, email_action_type: "recovery" },
  };
  for (const allowed of [false, true]) {
    const hosts: string[] = [];
    const handler = createHandler(configured, async (input, init) => {
      const url = new URL(String(input));
      hosts.push(url.hostname);
      if (url.hostname === "backend.example.invalid") {
        assert.equal(url.pathname, "/rest/v1/rpc/can_recover_password");
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer example-service-key",
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          identity_id: recovery.user.id,
        });
        assert.equal(init?.redirect, "error");
        return Response.json(allowed);
      }
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "example-access" });
      assert.equal(url.hostname, "gmail.googleapis.com");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer example-access",
      );
      const raw = Buffer.from(
        JSON.parse(String(init?.body)).raw,
        "base64url",
      ).toString();
      const body = Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString();
      assert.match(body, /找回登录密码/);
      assert.doesNotMatch(body, /https?:|example-service-key/);
      return Response.json({ id: "example-submission" });
    });
    assert.equal((await handler(signed(recovery))).status, 200);
    assert.deepEqual(
      hosts,
      allowed
        ? [
            "backend.example.invalid",
            "oauth2.googleapis.com",
            "gmail.googleapis.com",
          ]
        : ["backend.example.invalid"],
    );
  }
  const failed = createHandler(configured, async () =>
    Response.json(
      { message: "example-service-key diagnostic" },
      { status: 503 },
    ),
  );
  const response = await failed(signed(recovery));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /example-service-key|diagnostic/);
});
