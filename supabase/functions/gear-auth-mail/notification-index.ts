import {
  createNotificationHandler,
  type NotificationEnvironment,
} from "./notifications.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};
const names = [
  "GEAR_DB_SCHEMA",
  "GEAR_NOTIFICATION_TOKEN",
  "GEAR_AUTH_APP_URL",
  "GEAR_GMAIL_CLIENT_ID",
  "GEAR_GMAIL_CLIENT_SECRET",
  "GEAR_GMAIL_REFRESH_TOKEN",
  "GEAR_MAIL_FROM",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const env = Object.fromEntries(
  names.map((name) => [name, Deno.env.get(name) || ""]),
) as NotificationEnvironment;
Deno.serve(createNotificationHandler(env));
