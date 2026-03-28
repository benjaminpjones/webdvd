# webdvd

A web-based DVD player that faithfully reproduces the full DVD experience — menus, navigation, chapter selection, and all — in the browser.

Point webdvd at a `VIDEO_TS` folder and relive 1999 in a browser tab.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    Browser                       │
│                                                  │
│  ┌──────────────────┐  ┌─────────────────────┐   │
│  │ libdvdnav (WASM) │  │ Subpicture Renderer │   │
│  │ - IFO parsing     │  │ - RLE decode        │   │
│  │ - Navigation VM   │  │ - Button highlights  │   │
│  │ - PGC execution   │  │ - Canvas overlay     │   │
│  │ - Button handling │  │                     │   │
│  └────────┬─────────┘  └──────────┬──────────┘   │
│           │                       │               │
│     ┌─────┴───────────────────────┴─────┐         │
│     │       DVD Session Manager (TS)     │         │
│     │  - Orchestrates VM + video + menus │         │
│     │  - User input routing              │         │
│     └──────────────┬────────────────────┘         │
│                    │  <video> element              │
└────────────────────┼──────────────────────────────┘
                     │ HTTP / WebSocket
┌────────────────────┼──────────────────────────────┐
│            ┌───────┴────────┐                      │
│            │  Rust Server   │     Local machine     │
│            │  (axum/tokio)  │                       │
│            └───────┬────────┘                      │
│                    │                               │
│  ┌─────────────────┼──────────────────┐            │
│  │ ffmpeg subprocess                  │            │
│  │ MPEG-2/AC-3 → H.264/AAC → fMP4    │            │
│  └─────────────────┬──────────────────┘            │
│                    │                               │
│            ┌───────┴────────┐                      │
│            │   VIDEO_TS/    │                      │
│            └────────────────┘                      │
└────────────────────────────────────────────────────┘
```

## How It Works

**Server (Rust):** A local axum server reads a `VIDEO_TS` directory and streams transcoded MPEG-2/AC-3 video as H.264/AAC fMP4 on the fly via ffmpeg. The browser gets standard MP4 it can play natively. The transcode streams as ffmpeg produces fragments — playback starts within seconds, not after the whole file is transcoded.

**Navigation (WASM):** The canonical `libdvdnav` and `libdvdread` C libraries are compiled to WebAssembly via Emscripten. This gives us battle-tested DVD navigation — the same code that powers VLC and Kodi — running in the browser. The VM executes IFO commands, manages registers, handles PGC chains, and drives the entire disc experience. Both IFO and VOB files are loaded into Emscripten's MEMFS so the VM can read navigation packets and drive block-level playback.

**Session Manager (TypeScript):** On page load, the session manager "inserts the disc" by running the First Play PGC through the WASM VM. It spins the `dvdnav_get_next_block()` event loop (discarding MPEG-2 data, processing only navigation events like CELL_CHANGE, VTS_CHANGE, HIGHLIGHT, STILL_FRAME, HOP_CHANNEL, STOP) to determine what to play. If the disc lands in a menu, the overlay shows button highlights and waits for user input. If it lands in a title, the server is told to transcode that titleset. Button activation re-enters the event loop, using `awaitingTransition` tracking to skip stale menu cells until the VM completes the jump. Chapter seeks use sector-based offsets for fast startup; title switches require a new transcode request (~1-2s for ffmpeg startup).

**Menus (Canvas):** Button highlights are rendered on a `<canvas>` layer over the video. Click regions and arrow-key navigation are driven by PCI packets parsed by libdvdnav. Button activation triggers VM commands that navigate between menus and titles. An on-screen DVD remote provides arrow keys, OK, and Menu buttons for navigation. Full subpicture RLE decoding (for rendered menu text/graphics) is planned for a future milestone — currently menus use rectangle highlights only.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Server | Rust (axum + tokio) |
| Video transcode | ffmpeg subprocess (MPEG-2 → H.264/AAC → streaming fMP4) |
| DVD navigation | libdvdnav/libdvdread → WASM (Emscripten) |
| Browser app | TypeScript + Vite |
| Video playback | Native `<video>` + progressive fMP4 download |
| Menu rendering | `<canvas>` overlay |

## Prerequisites

- [Rust](https://rustup.rs/) (for the server)
- [Node.js](https://nodejs.org/) >= 18 (for the player)
- [ffmpeg](https://ffmpeg.org/) (for video transcoding)
- [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) (for building the WASM module)
- [dvdauthor](http://dvdauthor.sourceforge.net/) (for generating the test disc — includes `spumux` for menu button highlights)

## Quick Start

```bash
# 1. Build the WASM module (requires emcc on PATH)
./wasm/build.sh

# 2. Generate a test disc (requires ffmpeg + dvdauthor)
./scripts/make-test-disc.sh

# 3. Start the server
cd server
cargo run -- /tmp/webdvd-test/VIDEO_TS

# 4. In another terminal, start the player
cd player
npm install
npm run dev
```

Open http://localhost:5173 to watch your DVD. The test disc starts at the root menu — click a button or use the on-screen DVD remote to navigate.

To use a real DVD, point the server at its `VIDEO_TS` directory instead of the test disc.

## Testing

```bash
# WASM smoke test — verifies IFO parsing + VM event loop (Node.js, no browser)
# Requires: test disc generated, WASM built
node wasm/test.mjs

# E2E browser test — headless Chromium via Playwright
# Starts both servers automatically, verifies menu navigation + playback
cd player
npx playwright install chromium  # first time only
npm test
```

**Before submitting changes**, always run the e2e tests to validate the full playback pipeline:

```bash
cd player && npm test
```

This catches regressions in the WASM glue, VM navigation, menu interaction, server transcoding, and video playback. The e2e suite covers disc structure, menu loading, button highlights, sub-menu navigation, title playback from menus, and title switching.

The test disc includes a VMGM root menu (3 buttons: Title 1, Title 2, Chapters) and a VTS chapters sub-menu (3 buttons: Chapter 1, Chapter 2, Main Menu), exercising the full menu↔title flow.

CI runs the WASM smoke test on every push/PR via GitHub Actions. The smoke test covers VM navigation (the event loop reaches a CELL_CHANGE in VTS domain) but does not test the full browser playback pipeline — that's what the local e2e test is for.

## Project Structure

```
server/              Rust server (axum) — VIDEO_TS serving + streaming ffmpeg transcode
  src/api.rs         HTTP endpoints (/api/disc, /api/transcode, /api/ifo/*, /api/vob/*)
  src/transcode.rs   ffmpeg spawn + streaming fMP4 output
  src/disc.rs        VIDEO_TS directory scanner
player/              TypeScript + Vite browser app
  src/main.ts        App entry point — auto-play via SessionManager
  src/dvdnav.ts      WASM module wrapper — DvdSession class
  src/session.ts     DVD Session Manager — VM event loop + video orchestration
  e2e/               Playwright tests
wasm/
  lib/               Git submodules (libdvdread, libdvdnav)
  src/glue.c         C glue layer (EMSCRIPTEN_KEEPALIVE exports)
  src/config.h       Emscripten build config
  build.sh           Compiles C sources → dvdnav.js + dvdnav.wasm
  test.mjs           Node.js smoke test (IFO parsing + VM event loop)
  src/overlay.ts     Menu button highlight renderer (canvas overlay + DVD remote)
scripts/             Dev utilities (test disc generation with menus via dvdauthor + spumux)
```

## Key Design Details

### WASM VM event loop

The core of playback is `dvd_get_next_event()` in `glue.c`. It loops `dvdnav_get_next_block()` internally, **discarding MPEG-2 block data** (the server handles transcoding), and returns JSON only on navigation events. This avoids thousands of JS↔WASM round trips per second. The function has a 50k iteration safety cap to prevent infinite WASM hangs.

### MEMFS requirements

The WASM VM needs **both IFO and VOB files** in Emscripten's MEMFS to function. IFO files provide structure; VOB files contain the NAV packs that `dvdnav_get_next_block()` reads for navigation decisions. Without VOBs, the VM cannot navigate. Both are fetched from the server at session init.

### First Play PGC handling

When a DVD is "inserted" (page load), the VM starts at the First Play PGC. Simple discs jump straight to the main title. Commercial discs typically jump to a menu, where the session manager shows button highlights and waits for user input.

### Post-activation transition tracking

After a button is activated, the VM re-enters its event loop. The first few events are stale (still referencing the old menu's PCI/cell data). The `awaitingTransition` flag blocks menu detection until HOP_CHANNEL or VTS_CHANGE fires, confirming the VM has completed its jump. `menuCellsSinceHop` provides similar protection after domain hops — the first menu cell after a HOP has stale PCI, so button detection waits for the second cell.

### Sector-based seeking

Chapter and menu cell playback use VOB-absolute sector offsets from the IFO cell_playback table rather than time-based seeking. The server finds which VOB file contains the start sector, seeks to the byte offset, and reads across VOB file boundaries as needed. For menu cells that share a VOB with other cells, `lastSector` limits the read range to prevent bleeding into adjacent cells.

### Latency

- **VM decisions**: local WASM, microseconds, no network
- **Chapter seek (same title)**: client-side `video.currentTime`, instant
- **Title switch**: new transcode request → ~1-2s ffmpeg startup → streaming fMP4

## Milestones

### M0: Video on Screen
- [x] Project structure (Rust server + TypeScript player)
- [x] Rust server serves VIDEO_TS, transcodes via ffmpeg
- [x] Browser plays transcoded video in `<video>` element

### M1: libdvdnav in WASM
- [x] Compile libdvdnav + libdvdread to WASM via Emscripten
- [x] JS bindings: open disc, get title info, execute navigation
- [x] I/O adapter: VIDEO_TS files fetched from server → Emscripten virtual FS
- [x] Browser queries disc structure (titles, chapters, audio tracks) via WASM

### M2: VM-Driven Playback
- [x] Wire libdvdnav block reading to session manager
- [x] First Play PGC executes automatically on "disc insert"
- [x] VM navigates to root menu or main title
- [x] Title/chapter selection through the VM
- [x] Streaming transcode (fMP4 fragments, not buffered)

### M3: Menus
- [x] Button highlight rendering on canvas overlay
- [x] PCI packet parsing for button coordinates and commands
- [x] Click/keyboard → button activation → VM command → navigation
- [x] Full menu → movie → menu flow
- [x] On-screen DVD remote (arrows, OK, Menu)
- [ ] Subpicture stream parsing and RLE decoding (currently rectangle highlights only)
- [ ] On-demand VOB block reading (fetch blocks as VM requests them instead of loading entire menu VOBs into MEMFS — needed for fast startup from optical/network drives)

### M4: Full Experience
- [ ] Subtitle rendering during playback
- [ ] Audio/subtitle stream switching
- [ ] Seamless VOB boundary transitions
- [ ] Multi-angle support
- [ ] Disc library / collection view

## Prior Art & References

- **[libdvdnav](https://github.com/xbmc/libdvdnav)** / **[libdvdread](https://github.com/xbmc/libdvdread)** — canonical C libraries for DVD navigation and reading (compiled to WASM for this project)
- **[libav.js](https://github.com/Yahweasel/libav.js)** — precedent for compiling C multimedia libs to WASM
- **[DVD.js](https://github.com/gmarty/DVD.js)** — 2014 proof-of-concept JS DVD player (reference only)
- **[dvd.sourceforge.net/dvdinfo](http://dvd.sourceforge.net/dvdinfo/)** — community DVD spec documentation
- **[Inside DVD-Video (Wikibooks)](https://en.wikibooks.org/wiki/Inside_DVD-Video)** — VM instruction set, NAV packs, subpicture format

## License

MIT
