import { handle, type Environment } from "./handler.ts";
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};
const names = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEAR_STORAGE_BUCKET",
  "GEAR_EVIDENCE_APP_URL",
  "GEAR_EVIDENCE_ENABLED",
] as const;
const env = Object.fromEntries(
  names.map((n) => [n, Deno.env.get(n) || ""]),
) as Environment;
Deno.serve((request) => handle(request, env));
