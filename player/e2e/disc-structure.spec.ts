import { test, expect } from "@playwright/test";

/**
 * Helper: wait for the status element to settle on "Menu".
 * The session manager sets state → "menu" which triggers onStateChange.
 */
async function waitForMenu(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent === "Menu",
    { timeout: 30_000 },
  );
}

test.describe("DVD disc structure via WASM", () => {
  test("displays disc structure from libdvdnav", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");

    const discStructure = page.locator("#disc-structure");
    await expect(discStructure).not.toHaveText("Loading disc structure (WASM)...", {
      timeout: 15_000,
    });

    const text = await discStructure.textContent();
    expect(text).not.toContain("WASM: Error");

    await expect(discStructure).toContainText("720x480");
    await expect(discStructure).toContainText("4:3");

    // All 3 titles detected
    await expect(discStructure).toContainText("Title 1:");
    await expect(discStructure).toContainText("Title 2:");
    await expect(discStructure).toContainText("Title 3:");

    // Chapter counts
    await expect(discStructure).toContainText("2 chapter(s)");
    await expect(discStructure).toContainText("3 chapter(s)");

    // No unexpected WASM errors
    const knownWarnings = [
      "Couldn't find device name",
      "Can't read name block",
      "Encrypted DVD support unavailable",
      "Region mask",
    ];
    const wasmErrors = errors.filter(
      (e) =>
        (e.includes("wasm") || e.includes("dvdnav") || e.includes("WASM")) &&
        !knownWarnings.some((w) => e.includes(w)),
    );
    expect(wasmErrors).toHaveLength(0);
  });

  test("displays disc info from session", async ({ page }) => {
    await page.goto("/");

    const discInfo = page.locator("#disc-info");
    await expect(discInfo).not.toHaveText("Loading disc info...", {
      timeout: 15_000,
    });

    await expect(discInfo).toContainText("3 title(s)");
  });

  test("title buttons are rendered", async ({ page }) => {
    await page.goto("/");

    const btn = page.locator(".title-btn").first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await expect(btn).toContainText("Title 1");
  });
});

test.describe("DVD menu navigation", () => {
  test("First Play lands in root menu with buttons", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    await page.goto("/");
    await waitForMenu(page);

    // Root menu should have 3 buttons
    const menuLogs = logs.filter((l) => l.includes("[session] Menu"));
    expect(menuLogs.some((l) => l.includes("3 buttons"))).toBe(true);
  });

  test("menu button plays title", async ({ page }) => {
    await page.goto("/");
    await waitForMenu(page);

    const status = page.locator("#status");

    // Press Enter on default button (should play a title)
    await page.keyboard.press("Enter");

    await expect(status).toContainText("Playing", { timeout: 30_000 });

    const video = page.locator("#video");
    const src = await video.getAttribute("src");
    expect(src).toContain("/api/transcode/");
  });

  test("sub-menu navigation and return to main", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    await page.goto("/");
    await waitForMenu(page);

    // Navigate to "Chapters" button (button 3 — down twice from button 1)
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Should land in the chapters sub-menu (still in "Menu" state)
    await waitForMenu(page);

    // The sub-menu should also have 3 buttons
    const menuLogs = logs.filter((l) =>
      l.includes("[session] Menu detected") ||
      l.includes("[session] Menu via"),
    );
    // Should have at least 2 menu detections (root + sub-menu)
    expect(menuLogs.length).toBeGreaterThanOrEqual(2);

    // Navigate to "Main Menu" button (button 3) and press Enter
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Should return to root menu
    await waitForMenu(page);
  });

  test("sub-menu button plays title", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    await page.goto("/");
    await waitForMenu(page);

    // Navigate to "Chapters" sub-menu
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await waitForMenu(page);

    // Press Enter on "Chapter 1" button (button 1, already selected)
    await page.keyboard.press("Enter");

    const status = page.locator("#status");
    await expect(status).toContainText("Playing", { timeout: 30_000 });

    const video = page.locator("#video");
    const src = await video.getAttribute("src");
    expect(src).toContain("/api/transcode/");
  });

  test("VTS menu VOBs are loaded before dvd_open", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    await page.goto("/");
    await waitForMenu(page);

    // Phase 1 should have loaded IFOs + VMGM VOB only
    const phase1Log = logs.find((l) => l.includes("Phase 1:"));
    expect(phase1Log).toBeTruthy();
    expect(phase1Log).toContain("IFO/BUP");
    expect(phase1Log).toContain("VMGM VOB");

    // Phase 2 should have loaded VTS menu VOBs (blocking, before dvd_open)
    const phase2Log = logs.find((l) => l.includes("Phase 2:"));
    expect(phase2Log).toBeTruthy();
    expect(phase2Log).toContain("VTS menu VOB");
  });

  test("title switching from menu changes video source", async ({ page }) => {
    await page.goto("/");
    await waitForMenu(page);

    const status = page.locator("#status");

    // Click Title 3 button directly (bypasses menu)
    const title3Btn = page.locator(".title-btn[data-title='3']");
    await title3Btn.click();

    await expect(status).toContainText("Playing title 3", { timeout: 30_000 });

    const video = page.locator("#video");
    const src = await video.getAttribute("src");
    expect(src).toContain("/api/transcode/3");

    const state = await video.evaluate((v: HTMLVideoElement) => ({
      paused: v.paused,
      readyState: v.readyState,
      error: v.error?.message ?? null,
      duration: v.duration,
    }));
    expect(state.error).toBeNull();
    expect(state.paused).toBe(false);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
    expect(state.duration).toBeGreaterThan(0);
  });
});
