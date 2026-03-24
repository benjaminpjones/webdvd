import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  // Vite dev server — Playwright starts this automatically
  webServer: [
    {
      command: "cd ../server && cargo run -- /tmp/webdvd-test/VIDEO_TS",
      port: 3000,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "npx vite --port 5173",
      port: 5173,
      reuseExistingServer: true,
      timeout: 10_000,
    },
  ],
});
