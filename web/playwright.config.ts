import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4175",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    timeout: 30000,
    reuseExistingServer: false,
  },
});
