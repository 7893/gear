import { Webhook } from "standardwebhooks";
import { renderGearCodeEmail } from "./templates.ts";

export type MailEnvironment = Record<
  | "GEAR_AUTH_WEBHOOK_SECRET"
  | "GEAR_AUTH_PUBLIC_URL"
  | "GEAR_GMAIL_CLIENT_ID"
  | "GEAR_GMAIL_CLIENT_SECRET"
  | "GEAR_GMAIL_REFRESH_TOKEN"
  | "GEAR_MAIL_FROM",
  string
>;
type Payload = {
  user: {
    email: string;
    new_email?: string;
    user_metadata?: { gear_application_name?: unknown };
  };
  email_data: {
    email_action_type: string;
    token?: string;
    token_hash?: string;
    token_new?: string;
    token_hash_new?: string;
    redirect_to?: string;
    old_email?: string;
  };
};
type Mail = { to: string; subject: string; text: string };
const notices: Record<string, string> = {
  password_changed_notification: "密码已更改",
  email_changed_notification: "登录邮箱已更改",
  phone_changed_notification: "联系电话已更改",
  identity_linked_notification: "已关联登录方式",
  identity_unlinked_notification: "已移除登录方式",
  mfa_factor_enrolled_notification: "已添加验证方式",
  mfa_factor_unenrolled_notification: "已移除验证方式",
};
const titles: Record<string, string> = {
  signup: "验证注册邮箱",
  recovery: "重置登录密码",
  magiclink: "登录验证",
  invite: "账号邀请",
  reauthentication: "确认本次操作",
  email_change: "确认更换登录邮箱",
};

function address(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    /[\r\n<>\s]/.test(value) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(value)
  )
    throw new Error("invalid_address");
  return value;
}

export function renderEmails(payload: Payload, publicUrl: string): Mail[] {
  const data = payload.email_data;
  const action = data?.email_action_type;
  const to = address(payload.user?.email);
  if (notices[action])
    return [
      {
        to:
          action === "email_changed_notification"
            ? address(data.old_email)
            : to,
        subject: notices[action],
        text: `${notices[action]}。\n\n若这不是您的操作，请尽快联系管理员。`,
      },
    ];
  if (!titles[action]) throw new Error("unsupported_action");
  const gearSignup =
    action === "signup" &&
    typeof payload.user.user_metadata?.gear_application_name === "string";
  const make = (recipient: string, token?: string, hash?: string): Mail => {
    if (token !== undefined && !/^[0-9]{6,10}$/.test(token))
      throw new Error("invalid_token");
    if (gearSignup) {
      if (!token || !/^[0-9]{6}$/.test(token)) throw new Error("invalid_token");
      return {
        to: address(recipient),
        ...renderGearCodeEmail("signup", token),
      };
    }
    const lines = [
      titles[action],
      "",
      ...(token ? [`验证码：${token}`, ""] : []),
    ];
    if (hash) {
      if (!/^[a-zA-Z0-9_-]{16,256}$/.test(hash))
        throw new Error("invalid_token_hash");
      const origin = new URL(publicUrl);
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw new Error("invalid_public_url");
      const link = new URL("/auth/v1/verify", origin);
      link.searchParams.set("token", hash);
      link.searchParams.set("type", action);
      if (data.redirect_to)
        link.searchParams.set("redirect_to", data.redirect_to);
      lines.push("验证链接：", link.toString(), "");
    }
    if (!token && !hash) throw new Error("verification_missing");
    lines.push(
      "请勿向他人提供验证码或链接。如果不是您本人发起，请忽略此邮件。",
    );
    return {
      to: address(recipient),
      subject: titles[action],
      text: lines.join("\n"),
    };
  };
  if (action === "email_change") {
    // Supabase's backwards-compatible hash names are reversed for email changes.
    const emails = [
      make(
        address(payload.user.new_email),
        data.token_new || data.token,
        data.token_hash,
      ),
    ];
    if (data.token_hash_new)
      emails.push(make(to, data.token, data.token_hash_new));
    return emails;
  }
  return [make(to, data.token, data.token_hash)];
}

function base64(value: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(value), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
}
function encodedSubject(subject: string): string {
  if (!subject || /[\r\n]/.test(subject)) throw new Error("invalid_subject");
  const words: string[] = [];
  let chunk = "";
  let length = 0;
  for (const character of subject) {
    const size = new TextEncoder().encode(character).length;
    // Keep the first header line (including "Subject: ") below 76 bytes.
    // Encode whole Unicode characters so each encoded-word decodes on its own.
    if (length + size > 39) {
      words.push(`=?UTF-8?B?${base64(chunk)}?=`);
      chunk = "";
      length = 0;
    }
    chunk += character;
    length += size;
  }
  words.push(`=?UTF-8?B?${base64(chunk)}?=`);
  return words.join("\r\n ");
}

export function renderMime(mail: Mail, from: string): string {
  const text = mail.text.replace(/\r\n|\r|\n/g, "\r\n");
  const body =
    base64(text)
      .match(/.{1,76}/g)
      ?.join("\r\n") || "";
  return [
    `From: <${address(from)}>`,
    `To: <${address(mail.to)}>`,
    `Subject: ${encodedSubject(mail.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    "",
  ].join("\r\n");
}

export function createHandler(
  env: MailEnvironment,
  fetcher: typeof fetch = fetch,
) {
  let cachedToken: { value: string; expires: number } | undefined;
  return async (request: Request): Promise<Response> => {
    const response = (status: number, code?: string) =>
      Response.json(
        code ? { error: { http_code: status, message: code } } : {},
        { status, headers: { "Cache-Control": "no-store" } },
      );
    if (request.method !== "POST") return response(405, "method_not_allowed");
    if (Object.values(env).some((value) => !value))
      return response(503, "mail_not_configured");
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 32768) {
            await reader.cancel();
            return response(413, "payload_too_large");
          }
          chunks.push(value);
        }
      } catch {
        return response(400, "invalid_webhook");
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder().decode(bytes);
    let payload: Payload;
    try {
      const verifier = new Webhook(
        env.GEAR_AUTH_WEBHOOK_SECRET.replace(/^v1,/, ""),
      );
      payload = verifier.verify(
        body,
        Object.fromEntries(request.headers),
      ) as Payload;
    } catch {
      return response(401, "invalid_webhook");
    }
    let messages: Mail[];
    try {
      messages = renderEmails(payload, env.GEAR_AUTH_PUBLIC_URL);
      address(env.GEAR_MAIL_FROM);
    } catch {
      return response(400, "invalid_mail_request");
    }
    // One deadline across OAuth and delivery. No local retry after an uncertain send.
    const signal = AbortSignal.timeout(4500);
    try {
      if (!cachedToken || cachedToken.expires <= Date.now()) {
        const result = await fetcher("https://oauth2.googleapis.com/token", {
          method: "POST",
          signal,
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: env.GEAR_GMAIL_CLIENT_ID,
            client_secret: env.GEAR_GMAIL_CLIENT_SECRET,
            refresh_token: env.GEAR_GMAIL_REFRESH_TOKEN,
          }),
        });
        if (!result.ok) throw new Error("oauth_failed");
        const token = (await result.json()) as {
          access_token?: string;
          expires_in?: number;
        };
        if (!token.access_token) throw new Error("oauth_failed");
        cachedToken = {
          value: token.access_token,
          expires:
            Date.now() + Math.min(token.expires_in || 300, 3000) * 1000 - 60000,
        };
      }
      for (const mail of messages) {
        const raw = base64(renderMime(mail, env.GEAR_MAIL_FROM))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        const result = await fetcher(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            signal,
            headers: {
              Authorization: "Bearer " + cachedToken.value,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ raw }),
          },
        );
        if (!result.ok) {
          cachedToken = undefined;
          throw new Error("mail_failed");
        }
        const submission = (await result.json()) as { id?: string };
        if (!submission.id) throw new Error("mail_failed");
      }
      return response(200);
    } catch {
      return response(503, "mail_submission_failed");
    }
  };
}
