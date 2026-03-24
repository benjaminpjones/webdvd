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
  assert(numTitles >= 1, `has at least 1 title (got ${numTitles})`);

  const numParts = dvd.getNumParts(1);
  assert(numParts >= 1, `title 1 has at least 1 chapter (got ${numParts})`);

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

  // Title description (JSON)
  const titleJson = dvd.describeTitle(1);
  const titleInfo = JSON.parse(titleJson);
  assert(titleInfo.chapters >= 1, `describe_title reports at least 1 chapter (got ${titleInfo.chapters})`);
  assert(titleInfo.duration_ms > 0, `describe_title reports positive duration (got ${titleInfo.duration_ms}ms)`);
  assert(
    Array.isArray(titleInfo.chapter_times_ms),
    `describe_title returns chapter_times_ms array`
  );

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
