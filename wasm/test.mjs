/**
 * Smoke test for the libdvdnav WASM module.
 *
 * Loads the Emscripten module in Node.js, writes test disc IFO files
 * into MEMFS, opens the disc, and asserts the structure is correct.
 *
 * Usage:
 *   # Generate test disc first: ./scripts/make-test-disc.sh
 *   node wasm/test.mjs [/path/to/VIDEO_TS]
 */

import { createRequire } from "module";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const require = createRequire(import.meta.url);

// Default test disc location
const videoTsDir = process.argv[2] || "/tmp/webdvd-test/VIDEO_TS";

// Load the Emscripten factory
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
  console.log(`Loading WASM module...`);
  const Module = await createModule();

  // Write IFO/BUP files into MEMFS
  console.log(`Loading IFO files from ${videoTsDir}`);
  Module.FS.mkdir("/dvd");
  Module.FS.mkdir("/dvd/VIDEO_TS");

  const ifoFiles = readdirSync(videoTsDir).filter(
    (f) => f.endsWith(".IFO") || f.endsWith(".BUP")
  );

  for (const name of ifoFiles) {
    const data = readFileSync(join(videoTsDir, name));
    Module.FS.writeFile(`/dvd/VIDEO_TS/${name}`, new Uint8Array(data));
  }
  console.log(`  Loaded ${ifoFiles.length} IFO/BUP files\n`);

  // Bind functions
  const dvd = {
    open: Module.cwrap("dvd_open", "number", ["string"]),
    close: Module.cwrap("dvd_close", null, []),
    error: Module.cwrap("dvd_error", "string", []),
    getNumTitles: Module.cwrap("dvd_get_num_titles", "number", []),
    getNumParts: Module.cwrap("dvd_get_num_parts", "number", ["number"]),
    getNumAngles: Module.cwrap("dvd_get_num_angles", "number", ["number"]),
    getTitleString: Module.cwrap("dvd_get_title_string", "string", []),
    getSerialString: Module.cwrap("dvd_get_serial_string", "string", []),
    getVideoAspect: Module.cwrap("dvd_get_video_aspect", "number", []),
    getVideoWidth: Module.cwrap("dvd_get_video_width", "number", []),
    getVideoHeight: Module.cwrap("dvd_get_video_height", "number", []),
    titlePlay: Module.cwrap("dvd_title_play", "number", ["number"]),
    getNumAudioStreams: Module.cwrap("dvd_get_num_audio_streams", "number", []),
    getAudioChannels: Module.cwrap("dvd_get_audio_channels", "number", ["number"]),
    getNumSpuStreams: Module.cwrap("dvd_get_num_spu_streams", "number", []),
    describeTitle: Module.cwrap("dvd_describe_title", "string", ["number"]),
  };

  // Open disc
  console.log("Opening disc...");
  const rc = dvd.open("/dvd/VIDEO_TS");
  assert(rc === 0, `dvd_open returns 0 (got ${rc})`);

  if (rc !== 0) {
    console.error(`dvd_open error: ${dvd.error()}`);
    process.exit(1);
  }

  // Test structure queries
  console.log("\nDisc structure:");
  const numTitles = dvd.getNumTitles();
  assert(numTitles === 4, `has 4 titles (got ${numTitles})`);

  const numParts1 = dvd.getNumParts(1);
  assert(numParts1 === 2, `title 1 has 2 chapters (got ${numParts1})`);

  const numParts2 = dvd.getNumParts(2);
  assert(numParts2 === 3, `title 2 has 3 chapters (got ${numParts2})`);

  const numParts3 = dvd.getNumParts(3);
  assert(numParts3 === 1, `title 3 has 1 chapter (got ${numParts3})`);

  const numAngles = dvd.getNumAngles(1);
  assert(numAngles >= 1, `title 1 has at least 1 angle (got ${numAngles})`);

  // Navigate into title 1 to start the VM (video/audio queries need this)
  console.log("\nStarting VM (title_play 1)...");
  const playRc = dvd.titlePlay(1);
  assert(playRc === 0, `dvd_title_play(1) returns 0 (got ${playRc})`);

  // Video info
  const width = dvd.getVideoWidth();
  const height = dvd.getVideoHeight();
  const aspect = dvd.getVideoAspect();
  assert(width === 720, `video width is 720 (got ${width})`);
  assert(height === 480, `video height is 480 (got ${height})`);
  assert(aspect === 0 || aspect === 2, `video aspect is 0 (4:3) or 2 (16:9) (got ${aspect})`);

  // Audio info
  const numAudio = dvd.getNumAudioStreams();
  assert(numAudio >= 1, `has at least 1 audio stream (got ${numAudio})`);

  if (numAudio > 0) {
    const channels = dvd.getAudioChannels(0);
    assert(channels >= 1, `audio stream 0 has at least 1 channel (got ${channels})`);
  }

  // Title descriptions (JSON)
  const title2Json = dvd.describeTitle(2);
  const title2Info = JSON.parse(title2Json);
  assert(title2Info.chapters === 3, `title 2 describe reports 3 chapters (got ${title2Info.chapters})`);
  assert(title2Info.duration_ms > 0, `title 2 has positive duration (got ${title2Info.duration_ms}ms)`);
  assert(
    Array.isArray(title2Info.chapter_times_ms) && title2Info.chapter_times_ms.length === 3,
    `title 2 has 3 chapter_times_ms entries (got ${title2Info.chapter_times_ms?.length})`
  );

  // M2: Test navigation event loop
  console.log("\nTesting VM event loop (dvd_get_next_event)...");

  // Re-open disc with VOB files loaded (needed for block reading)
  dvd.close();

  // Load ALL files (including VOBs) for the event loop test
  const allFiles = readdirSync(videoTsDir).filter(
    (f) => f.endsWith(".IFO") || f.endsWith(".BUP") || f.endsWith(".VOB")
  );
  // Re-create MEMFS dirs (module is the same, dirs may still exist)
  try { Module.FS.mkdir("/dvd2"); } catch (_) {}
  try { Module.FS.mkdir("/dvd2/VIDEO_TS"); } catch (_) {}
  for (const name of allFiles) {
    const data = readFileSync(join(videoTsDir, name));
    Module.FS.writeFile(`/dvd2/VIDEO_TS/${name}`, new Uint8Array(data));
  }
  console.log(`  Loaded ${allFiles.length} files (incl. VOBs) into MEMFS`);

  const rc2 = dvd.open("/dvd2/VIDEO_TS");
  assert(rc2 === 0, `dvd_open (re-open with VOBs) returns 0 (got ${rc2})`);

  const getNextEvent = Module.cwrap("dvd_get_next_event", "string", []);
  const stillSkip = Module.cwrap("dvd_still_skip", "number", []);

  // After open, the VM is at First Play PGC which jumps to the root menu.
  // Drive events until we see a menu (NAV_PACKET with buttons) or a title cell.
  const getButtons = Module.cwrap("dvd_get_buttons", "string", []);
  let foundMenu = false;
  for (let i = 0; i < 20; i++) {
    const json = getNextEvent();
    const ev = JSON.parse(json);

    // After any event, check if PCI has been populated with buttons
    if (!foundMenu) {
      const btns = JSON.parse(getButtons());
      if (btns.length > 0) {
        foundMenu = true;
        assert(btns.length === 5, `root menu has 5 buttons (got ${btns.length})`);
        break;
      }
    }
    if (ev.event === 2) { // STILL_FRAME
      stillSkip();
    }
    if (ev.event === 8) { // STOP
      break;
    }
    if (ev.event < 0) {
      console.error(`  Event error: ${ev.error}`);
      break;
    }
  }

  assert(foundMenu, "First Play PGC navigated to root menu with buttons");

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
