import { renderMime } from "./handler.ts";
import { renderGearNotification, type Notification } from "./templates.ts";

export type NotificationEnvironment = Record<
  | "GEAR_NOTIFICATION_TOKEN"
  | "GEAR_AUTH_APP_URL"
  | "GEAR_GMAIL_CLIENT_ID"
  | "GEAR_GMAIL_CLIENT_SECRET"
  | "GEAR_GMAIL_REFRESH_TOKEN"
  | "GEAR_MAIL_FROM"
  | "SUPABASE_URL"
  | "SUPABASE_SERVICE_ROLE_KEY",
  string
>;
type Claim = { id: string; lease_token: string };
type Outcome = "submitted" | "failed" | "unknown";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sameToken(actual: string, expected: string): Promise<boolean> {
  const bytes = new TextEncoder();
  const [a, b] = await Promise.all(
    [actual, expected].map((value) =>
      crypto.subtle.digest("SHA-256", bytes.encode(value)),
    ),
  );
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
function origin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("invalid_origin");
  return url.origin;
}
function notification(value: unknown): Notification {
  if (!value || typeof value !== "object" || !("kind" in value))
    throw new Error("invalid_message");
  if (
    value.kind === "application_pending" &&
    "applicantName" in value &&
    typeof value.applicantName === "string" &&
    value.applicantName.length > 0 &&
    value.applicantName.length <= 80
  )
    return {
      kind: value.kind,
      applicantName: value.applicantName.replace(/[\r\n]/g, " "),
    };
  if (
    value.kind === "application_approved" &&
    "role" in value &&
    ["admin", "operator", "viewer"].includes(String(value.role))
  )
    return {
      kind: value.kind,
      role: value.role as "admin" | "operator" | "viewer",
    };
  if (value.kind === "application_rejected") return { kind: value.kind };
  throw new Error("invalid_message");
}
function rawMail(mime: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(mime), (b) =>
      String.fromCharCode(b),
    ).join(""),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function retryDelay(response: Response): number {
  const value = response.headers.get("retry-after") || "";
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds)
    ? Math.max(60, Math.min(86400, Math.ceil(seconds)))
    : 60;
}

// One invocation handles at most one job. The caller cannot choose a recipient,
// template or record. There are no network retries after an uncertain submission.
export function createNotificationHandler(
  env: NotificationEnvironment,
  fetcher: typeof fetch = fetch,
) {
  return async (request: Request): Promise<Response> => {
    const reply = (status: number, result: string) =>
      Response.json(
        { result },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    if (request.method !== "POST") return reply(405, "method_not_allowed");
    if (!env.GEAR_NOTIFICATION_TOKEN || env.GEAR_NOTIFICATION_TOKEN.length < 32)
      return reply(503, "not_configured");
    const authorization = request.headers.get("authorization") || "";
    if (
      authorization.length > 512 ||
      !(await sameToken(authorization, "Bearer " + env.GEAR_NOTIFICATION_TOKEN))
    )
      return reply(401, "unauthorized");
    let backend: string;
    try {
      if (Object.values(env).some((value) => !value))
        throw new Error("missing_config");
      backend = origin(env.SUPABASE_URL);
      origin(env.GEAR_AUTH_APP_URL);
      // Validate the sender before consuming a job; no recipient is sent here.
      renderMime(
        { to: env.GEAR_MAIL_FROM, subject: "配置检查", text: "" },
        env.GEAR_MAIL_FROM,
      );
    } catch {
      return reply(503, "not_configured");
    }
    async function rpc(name: string, body: object): Promise<unknown> {
      const response = await fetcher(backend + "/rest/v1/rpc/" + name, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
          "Content-Profile": "gear",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("database_unavailable");
      return response.json();
    }
    let job: Claim;
    try {
      const claimed = (await rpc(
        "claim_account_notification",
        {},
      )) as Claim | null;
      if (claimed === null) return reply(200, "idle");
      if (!claimed || !uuid.test(claimed.id) || !uuid.test(claimed.lease_token))
        throw new Error("invalid_claim");
      job = claimed;
    } catch {
      return reply(503, "database_unavailable");
    }
    async function finish(
      outcome: Outcome,
      failure_code: string | null = null,
      message_id: string | null = null,
      retry_seconds = 60,
    ): Promise<Response> {
      try {
        const recorded = await rpc("finish_account_notification", {
          job_id: job.id,
          token: job.lease_token,
          outcome,
          message_id,
          failure_code,
          retry_seconds,
        });
        return recorded === true
          ? reply(200, outcome)
          : reply(503, "result_not_recorded");
      } catch {
        // A lost acknowledgement is never a reason to send again.
        return reply(503, "result_not_recorded");
      }
    }
    let accessToken: string;
    try {
      const response = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: env.GEAR_GMAIL_CLIENT_ID,
          client_secret: env.GEAR_GMAIL_CLIENT_SECRET,
          refresh_token: env.GEAR_GMAIL_REFRESH_TOKEN,
        }),
      });
      if (!response.ok)
        return finish(
          "failed",
          response.status >= 500 || response.status === 429
            ? "oauth_temporary"
            : "mail_authorization",
        );
      const grant = await response.json();
      if (typeof grant.access_token !== "string" || !grant.access_token)
        return finish("failed", "mail_authorization");
      accessToken = grant.access_token;
    } catch {
      return finish("failed", "oauth_temporary");
    }
    let raw: string;
    try {
      const message = (await rpc("prepare_account_notification", {
        job_id: job.id,
        token: job.lease_token,
      })) as { to: string; notification: unknown } | null;
      if (message === null) return reply(200, "cancelled");
      try {
        const content = renderGearNotification(
          notification(message.notification),
          env.GEAR_AUTH_APP_URL,
        );
        raw = rawMail(
          renderMime({ to: message.to, ...content }, env.GEAR_MAIL_FROM),
        );
      } catch {
        return finish("failed", "invalid_message");
      }
    } catch {
      // The prepare transaction may already have committed. Let its lease
      // expire to unknown; neither rerun preparation nor submit a guessed mail.
      return reply(503, "database_unavailable");
    }
    try {
      const response = await fetcher(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw }),
        },
      );
      if (response.ok) {
        const submitted = await response.json();
        if (
          typeof submitted.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,255}$/.test(submitted.id)
        )
          return finish("unknown", "submission_unknown");
        return finish("submitted", null, submitted.id);
      }
      if (response.status === 429)
        return finish(
          "failed",
          "provider_rate_limit",
          null,
          retryDelay(response),
        );
      if (response.status === 401)
        return finish("failed", "provider_unauthorized");
      if (response.status === 403) {
        const details = await response.json().catch(() => null);
        const errors = details?.error?.errors;
        if (
          Array.isArray(errors) &&
          errors.some((entry: { reason?: unknown }) =>
            [
              "rateLimitExceeded",
              "userRateLimitExceeded",
              "dailyLimitExceeded",
            ].includes(String(entry?.reason)),
          )
        )
          return finish(
            "failed",
            "provider_rate_limit",
            null,
            response.headers.has("retry-after") ? retryDelay(response) : 3600,
          );
      }
      if (response.status >= 400 && response.status < 500)
        return finish("failed", "provider_rejected");
      return finish("unknown", "submission_unknown");
    } catch {
      return finish("unknown", "submission_unknown");
    }
  };
}
