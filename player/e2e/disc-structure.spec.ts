import { test, expect } from "@playwright/test";

test.describe("DVD disc structure via WASM", () => {
  test("displays disc structure from libdvdnav", async ({ page }) => {
    // Collect console errors
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");

    // Wait for the WASM-derived disc structure to appear
    const discStructure = page.locator("#disc-structure");
    await expect(discStructure).not.toHaveText("Loading disc structure (WASM)...", {
      timeout: 15_000,
    });

    // Should not show an error
    const text = await discStructure.textContent();
    expect(text).not.toContain("WASM: Error");

    // Should contain video resolution info
    await expect(discStructure).toContainText("720x480");

    // Should contain aspect ratio
    await expect(discStructure).toContainText("4:3");

    // Should contain at least one title
    await expect(discStructure).toContainText("Title 1:");

    // Should contain chapter count
    await expect(discStructure).toContainText("chapter(s)");

    // Should contain duration (test disc is 10 seconds)
    await expect(discStructure).toContainText("0:10");

    // No JS errors related to WASM (exclude known harmless libdvdnav warnings)
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

    // Should show title count
    await expect(discInfo).toContainText("title(s)");
  });

  test("title buttons are rendered", async ({ page }) => {
    await page.goto("/");

    // Wait for title buttons to appear
    const btn = page.locator(".title-btn").first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await expect(btn).toContainText("Title 1");
  });

  test("VM-driven auto-play starts video", async ({ page }) => {
    await page.goto("/");

    // Wait for status to show playing
    const status = page.locator("#status");
    await expect(status).toContainText("Playing", { timeout: 30_000 });

    // Video element should have a src set
    const video = page.locator("#video");
    const src = await video.getAttribute("src");
    expect(src).toContain("/api/transcode/");

    // Video should actually be playing (not stalled/errored)
    const state = await video.evaluate((v: HTMLVideoElement) => ({
      paused: v.paused,
      readyState: v.readyState,
      error: v.error?.message ?? null,
      currentTime: v.currentTime,
      duration: v.duration,
    }));
    expect(state.error).toBeNull();
    expect(state.paused).toBe(false);
    expect(state.readyState).toBeGreaterThanOrEqual(2); // HAVE_CURRENT_DATA
    expect(state.duration).toBeGreaterThan(0);
  });
});
