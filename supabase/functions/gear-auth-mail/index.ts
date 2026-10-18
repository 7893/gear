import { createHandler, type MailEnvironment } from "./handler.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};
const names = [
  "GEAR_DB_SCHEMA",
  "GEAR_AUTH_WEBHOOK_SECRET",
  "GEAR_AUTH_PUBLIC_URL",
  "GEAR_GMAIL_CLIENT_ID",
  "GEAR_GMAIL_CLIENT_SECRET",
  "GEAR_GMAIL_REFRESH_TOKEN",
  "GEAR_MAIL_FROM",
  "GEAR_AUTH_APP_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const env = Object.fromEntries(
  names.map((name) => [name, Deno.env.get(name) || ""]),
) as MailEnvironment;
Deno.serve(createHandler(env));
