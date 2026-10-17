import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: process.env.CLOUDFLARE_GATEWAY_NAME || "example-api-proxy",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-10-17",
    domains: process.env.BACKEND_DNS_NAME ? [process.env.BACKEND_DNS_NAME] : [],
    workersDev: false,
    previewUrls: false,
    env: {
      SUPABASE_URL: bindings.secret(),
      FRONTEND_ORIGIN: bindings.secret(),
      GEAR_DB_SCHEMA: bindings.secret(),
      GEAR_STORAGE_BUCKET: bindings.secret(),
      GEAR_FUNCTION_PREFIX: bindings.secret(),
    },
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false, persist: false },
      traces: { enabled: true, headSamplingRate: 0.01, persist: false },
    },
  },
});
