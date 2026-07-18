import { defineConfig } from "@playwright/test";

const testDisc = process.env.WEBDVD_TEST_DISC ?? "/tmp/webdvd-test";
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
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  // Vite dev server — Playwright starts this automatically
  webServer: [
    {
      command: serverCommand,
      port: 3000,
      // Never reuse: a dev server already on :3000 is almost always rooted at a
      // different library than the suite expects, so the tests would silently
      // run against the wrong disc — stale /vob-list, transcodes written
      // outside the test root, and failures that look like code regressions but
      // are environmental. Failing to bind is the correct outcome; stop the
      // other server first.
      reuseExistingServer: false,
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
