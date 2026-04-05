import { defineConfig } from "@playwright/test";

const testDisc = process.env.WEBDVD_TEST_DISC ?? "/tmp/webdvd-test/VIDEO_TS";
const serverBin = process.env.WEBDVD_SERVER_BIN;
const serverCommand = serverBin
  ? `${serverBin} ${testDisc}`
  : `cd ../server && cargo run -- ${testDisc}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5188",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  // Vite dev server — Playwright starts this automatically
  webServer: [
    {
      command: serverCommand,
      port: 3000,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "npx vite --port 5188",
      port: 5188,
      reuseExistingServer: true,
      timeout: 10_000,
    },
  ],
});
