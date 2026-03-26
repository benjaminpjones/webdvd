/**
 * Menu smoke test for the libdvdnav WASM module (M3).
 *
 * Loads the menu test disc into MEMFS, drives the VM into the menu,
 * verifies button info, tests arrow navigation, and activates a button
 * to confirm it reaches the correct title.
 *
 * Usage:
 *   # Generate menu test disc first: ./scripts/make-menu-test-disc.sh
 *   node wasm/test-menu.mjs [/path/to/VIDEO_TS]
 */

import { createRequire } from "module";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const require = createRequire(import.meta.url);

const videoTsDir = process.argv[2] || "/tmp/webdvd-menu-test/VIDEO_TS";
const createModule = require("./build/dvdnav.js");

let failures = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failures++;
  } else {
    console.log(`  PASS: ${message}`);
  }
}

async function main() {
  console.log("Loading WASM module...");
  const Module = await createModule();

  // Load all files into MEMFS
  console.log(`Loading files from ${videoTsDir}`);
  Module.FS.mkdir("/dvd");
  Module.FS.mkdir("/dvd/VIDEO_TS");

  const allFiles = readdirSync(videoTsDir);
  for (const name of allFiles) {
    const data = readFileSync(join(videoTsDir, name));
    Module.FS.writeFile(`/dvd/VIDEO_TS/${name}`, new Uint8Array(data));
  }
  console.log(`  Loaded ${allFiles.length} files into MEMFS\n`);

  // Bind functions
  const dvd = {
    open: Module.cwrap("dvd_open", "number", ["string"]),
    close: Module.cwrap("dvd_close", null, []),
    titlePlay: Module.cwrap("dvd_title_play", "number", ["number"]),
    getNextEvent: Module.cwrap("dvd_get_next_event", "string", []),
    getButtons: Module.cwrap("dvd_get_buttons", "string", []),
    getCurrentButton: Module.cwrap("dvd_get_current_button", "number", []),
    buttonActivate: Module.cwrap("dvd_button_activate", "number", []),
    buttonSelectDown: Module.cwrap("dvd_button_select_down", "number", []),
    buttonSelectUp: Module.cwrap("dvd_button_select_up", "number", []),
    isDomainMenu: Module.cwrap("dvd_is_domain_menu", "number", []),
    stillSkip: Module.cwrap("dvd_still_skip", "number", []),
  };

  // Open disc
  console.log("Opening menu disc...");
  const rc = dvd.open("/dvd/VIDEO_TS");
  assert(rc === 0, `dvd_open returns 0 (got ${rc})`);

  // === Test 1: Drive VM to menu ===
  console.log("\nDriving VM to menu...");
  let sawClut = false;
  let sawHighlight = false;
  let reachedMenuStill = false;

  for (let i = 0; i < 50; i++) {
    const ev = JSON.parse(dvd.getNextEvent());

    if (ev.event === 10) sawClut = true; // SPU_CLUT_CHANGE
    if (ev.event === 9) sawHighlight = true; // HIGHLIGHT

    if (ev.event === 2 && ev.stillLength === 255) {
      reachedMenuStill = true;
      break;
    }
    if (ev.event === 8 || ev.event < 0) break;
  }

  assert(sawClut, "received SPU_CLUT_CHANGE event");
  assert(sawHighlight, "received HIGHLIGHT event");
  assert(reachedMenuStill, "reached infinite still (menu waiting for input)");
  assert(dvd.isDomainMenu() === 1, "VM is in menu domain");

  // === Test 2: Button info ===
  console.log("\nChecking button info...");
  const buttons = JSON.parse(dvd.getButtons());
  assert(buttons.length === 3, `menu has 3 buttons (got ${buttons.length})`);

  if (buttons.length >= 3) {
    // Verify button coordinates match our spumux layout
    assert(buttons[0].x0 === 210 && buttons[0].y0 === 178, `button 1 at (210,178) (got ${buttons[0].x0},${buttons[0].y0})`);
    assert(buttons[1].x0 === 210 && buttons[1].y0 === 238, `button 2 at (210,238) (got ${buttons[1].x0},${buttons[1].y0})`);
    assert(buttons[2].x0 === 210 && buttons[2].y0 === 298, `button 3 at (210,298) (got ${buttons[2].x0},${buttons[2].y0})`);

    // Verify adjacency (wrapping: 1->2->3->1)
    assert(buttons[0].down === 2, `button 1 down → 2 (got ${buttons[0].down})`);
    assert(buttons[1].down === 3, `button 2 down → 3 (got ${buttons[1].down})`);
    assert(buttons[2].down === 1, `button 3 down → 1 (got ${buttons[2].down})`);
  }

  // === Test 3: Arrow navigation ===
  console.log("\nTesting arrow navigation...");
  const cur1 = dvd.getCurrentButton();
  assert(cur1 === 1, `initial button is 1 (got ${cur1})`);

  dvd.buttonSelectDown();
  assert(dvd.getCurrentButton() === 2, `down → button 2 (got ${dvd.getCurrentButton()})`);

  dvd.buttonSelectDown();
  assert(dvd.getCurrentButton() === 3, `down → button 3 (got ${dvd.getCurrentButton()})`);

  dvd.buttonSelectUp();
  assert(dvd.getCurrentButton() === 2, `up → button 2 (got ${dvd.getCurrentButton()})`);

  // === Test 4: Button activation → title playback ===
  console.log("\nActivating button 2 (Title 2)...");
  const activateRc = dvd.buttonActivate();
  assert(activateRc === 0, `buttonActivate returns 0 (got ${activateRc})`);

  // Drive VM — should navigate to VTS domain, title 2
  let foundTitle = false;
  for (let i = 0; i < 20; i++) {
    const ev = JSON.parse(dvd.getNextEvent());
    if (ev.event === 6 && ev.isVts && ev.title > 0) {
      foundTitle = true;
      assert(ev.title === 2, `activated button 2 → title 2 (got title ${ev.title})`);
      break;
    }
    if (ev.event === 2) dvd.stillSkip();
    if (ev.event === 8 || ev.event < 0) break;
  }
  assert(foundTitle, "button activation navigated to VTS domain");

  // === Test 5: Regression — VM reset after structure query ===
  // getDiscStructure() calls titlePlay(1) to read video attributes, which
  // moves the VM into VTS domain. If we don't reopen, start() drives the VM
  // from title 1 instead of the First Play PGC, skipping the menu entirely.
  console.log("\nRegression: VM reaches menu after titlePlay(1) + reopen...");
  dvd.close();
  dvd.titlePlay(1); // simulate what queryStructure does (no-op after close, but mirrors the flow)
  const rc2 = dvd.open("/dvd/VIDEO_TS"); // reopen resets to First Play PGC
  assert(rc2 === 0, `reopen after titlePlay returns 0 (got ${rc2})`);

  let reachedMenuAfterReset = false;
  let reachedVtsInstead = false;
  for (let i = 0; i < 50; i++) {
    const ev = JSON.parse(dvd.getNextEvent());
    if (ev.event === 2 && ev.stillLength === 255) {
      // Infinite still = menu. Check we're actually in menu domain.
      reachedMenuAfterReset = dvd.isDomainMenu() === 1;
      break;
    }
    if (ev.event === 6 && ev.isVts && ev.title > 0) {
      reachedVtsInstead = true;
      break;
    }
    if (ev.event === 8 || ev.event < 0) break;
  }
  assert(reachedMenuAfterReset, "First Play PGC reaches menu after reopen (not title 1)");
  assert(!reachedVtsInstead, "did not skip to VTS domain (regression: titlePlay override)");

  // Cleanup
  dvd.close();

  // Summary
  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
