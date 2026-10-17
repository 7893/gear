import assert from "node:assert/strict";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import {
  createHandler,
  renderEmails,
  type MailEnvironment,
} from "../handler.ts";

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
