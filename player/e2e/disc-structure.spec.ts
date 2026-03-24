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

  test("displays server disc info", async ({ page }) => {
    await page.goto("/");

    const discInfo = page.locator("#disc-info");
    await expect(discInfo).not.toHaveText("Loading disc info...", {
      timeout: 10_000,
    });

    // Should show VOB count and titleset info
    await expect(discInfo).toContainText("VOB files");
    await expect(discInfo).toContainText("title set(s)");
  });

  test("titleset buttons are rendered", async ({ page }) => {
    await page.goto("/");

    // Wait for buttons to appear
    const btn = page.locator(".titleset-btn").first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toHaveText("Title Set 1");
  });
});
