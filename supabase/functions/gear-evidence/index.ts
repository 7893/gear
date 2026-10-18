import { handle, type Environment } from "./handler.ts";
import { platformKey } from "./keys.ts";
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};
const names = [
  "GEAR_DB_SCHEMA",
  "SUPABASE_URL",
  "GEAR_STORAGE_BUCKET",
  "GEAR_EVIDENCE_APP_URL",
  "GEAR_EVIDENCE_ENABLED",
] as const;
const env: Environment = {
  ...(Object.fromEntries(
    names.map((n) => [n, Deno.env.get(n) || ""]),
  ) as Record<(typeof names)[number], string>),
  SUPABASE_PUBLISHABLE_KEY: platformKey(
    Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
    "sb_publishable_",
  ),
  SUPABASE_SECRET_KEY: platformKey(
    Deno.env.get("SUPABASE_SECRET_KEYS"),
    "sb_secret_",
  ),
};
Deno.serve((request) => handle(request, env));
