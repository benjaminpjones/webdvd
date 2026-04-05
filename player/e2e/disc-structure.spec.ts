import { test, expect } from "@playwright/test";

/**
 * Helper: wait for the status element to settle on "Menu".
 * The session manager sets state → "menu" which triggers onStateChange.
 */
async function waitForMenu(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "Menu", {
    timeout: 30_000,
  });
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

    // All 4 titles detected
    await expect(discStructure).toContainText("Title 1:");
    await expect(discStructure).toContainText("Title 2:");
    await expect(discStructure).toContainText("Title 3:");
    await expect(discStructure).toContainText("Title 4:");

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

    await expect(discInfo).toContainText("4 title(s)");
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

    // Root menu should have 5 buttons
    const menuLogs = logs.filter((l) => l.includes("[session] Menu"));
    expect(menuLogs.some((l) => l.includes("5 buttons"))).toBe(true);
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

    // Navigate to "Title 1 Chapters" button (button 5 — down four times from button 1)
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Should land in the chapters sub-menu (still in "Menu" state)
    await waitForMenu(page);

    // The sub-menu should also have 3 buttons
    const menuLogs = logs.filter(
      (l) => l.includes("[session] Menu detected") || l.includes("[session] Menu via"),
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

    // Navigate to "Title 1 Chapters" sub-menu (button 5)
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
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

    // Click Title 4 button directly (bypasses menu) — Title 4 = VTS 3 (red)
    const title4Btn = page.locator(".title-btn[data-title='4']");
    await title4Btn.click();

    await expect(status).toContainText("Playing title 4", { timeout: 30_000 });

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

  test("multi-PGC title passes sector bounds to server", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    await page.goto("/");
    await waitForMenu(page);

    const status = page.locator("#status");

    // Play Title 3 (VTS 2, PGC 2 — starts mid-VOB at sector 644)
    const title3Btn = page.locator(".title-btn[data-title='3']");
    await title3Btn.click();

    await expect(status).toContainText("Playing title 3", { timeout: 30_000 });

    const video = page.locator("#video");
    const src = await video.getAttribute("src");
    // Should transcode VTS 2 with both sector and lastSector params
    expect(src).toContain("/api/transcode/2");
    expect(src).toMatch(/sector=\d+/);
    expect(src).toMatch(/lastSector=\d+/);

    // The sector should be > 0 (PGC 2 doesn't start at beginning of VOB)
    const sectorMatch = src?.match(/sector=(\d+)/);
    expect(sectorMatch).toBeTruthy();
    const sector = parseInt(sectorMatch![1], 10);
    expect(sector).toBeGreaterThan(0);

    // Verify the session log shows the non-zero sector and lastSector
    const playLog = logs.find((l) => l.includes("[session] Playing VTS"));
    expect(playLog).toBeTruthy();
    expect(playLog).toContain("lastSector=");

    // Video should play without errors
    const state = await video.evaluate((v: HTMLVideoElement) => ({
      error: v.error?.message ?? null,
      paused: v.paused,
      readyState: v.readyState,
    }));
    expect(state.error).toBeNull();
    expect(state.paused).toBe(false);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });

  test("menu renders subpicture overlay on canvas", async ({ page }) => {
    await page.goto("/");
    await waitForMenu(page);

    // The test disc has SPU subpictures with gray button outlines (normal state).
    // Verify the canvas overlay has non-transparent pixels in the button area.
    // Button 1 spans x=240..479, y=130..169 in DVD coordinates (720x480 canvas).
    const nonTransparent = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return 0;
      const ctx = canvas.getContext("2d");
      if (!ctx) return 0;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { data } = imageData;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) count++;
      }
      return count;
    });

    expect(nonTransparent).toBeGreaterThan(100);
  });
});
