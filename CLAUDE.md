# CLAUDE.md

See README.md for architecture, design details, and milestones.

## Development

```bash
# Build WASM (requires emcc on PATH)
./wasm/build.sh

# Generate test disc (requires ffmpeg + dvdauthor)
./scripts/make-test-disc.sh

# Run server
cd server && cargo run -- /tmp/webdvd-test

# Run player (separate terminal)
cd player && npm run dev

# Tests
node wasm/validate-build.mjs   # WASM build validation (Node.js)
cd player && npm test          # Playwright e2e (headless browser)
```

## Validation

**Always run the e2e tests before submitting changes:**

```bash
cd player && npm test
```

Playwright auto-starts both servers. The e2e suite verifies disc structure, menu loading, button navigation, sub-menu flow, and title playback from menus.

## Gotchas

- **Menu VOBs are read on demand, not preloaded into MEMFS** — only IFO/BUP files are written to MEMFS. Each VOB is a 0-byte placeholder whose size is faked via `node.usedBytes` (so libdvdread's `stat()` reports the right block count without allocating). libdvdread's `dvd_input.c` is **overridden** (`wasm/src/dvd_input.c`, compiled instead of the pinned submodule's copy) so `*.VOB` reads call an `EM_ASYNC_JS` bridge (`dvdread_fetch_blocks` in glue.c → `Module.onVobRead`); the WASM is built with `-sASYNCIFY` so the otherwise-synchronous read can suspend. The player preloads each menu VOB's NAV packs (server-extracted via `GET /menu-nav/{vob}` — a few MB, not hundreds) into a sparse `Map<sector, navpack>` and serves the VM's reads from it (NAV pack where one exists, zeros elsewhere — the VM discards video). This is what makes large animated menus load fast. Title VOBs stay empty (size 0) so the VM hits EOF and skips auto-play intro titles instead of streaming them.
- **`dvd_get_next_event()` discards MPEG-2 data** — it loops `dvdnav_get_next_block()` internally, skipping BLOCK_OK/NAV_PACKET/NOP. Only navigation events come back to JS. The server handles actual video transcoding separately.
- **Post-activation stale events** — after button activation, the VM's event loop emits stale CELL_CHANGE/HIGHLIGHT/STILL_FRAME events from the old menu before the jump completes. `awaitingTransition` in `driveVM()` blocks menu detection until HOP_CHANNEL or VTS_CHANGE fires. Similarly, `menuCellsSinceHop` skips the first menu cell after a HOP because its PCI is not yet populated.
- **Sector-based seeking** — chapter and menu cell playback use VOB-absolute sector offsets from IFO `cell_playback`, not time-based `?ss=`. The server reads across multi-VOB file boundaries. For menu cells, `lastSector` limits the byte range to prevent bleeding into adjacent cells. For multi-PGC titlesets, `pgcLastSector` bounds the read to the title's PGC.
- **ILVU filtering** — DVDs with multi-angle content interleave VOBUs from different angles in the same VOB, tagged by `vob_id`. The server's `pipe_dvdread()` reads VOBU-by-VOBU, parsing NAV packs (DSI) for ILVU flags and filtering to only the target angle. Without this, duplicate PTS timestamps cause visible half-second repeats.
- **Menu intro overlay timing** — menus with intro animations (e.g. studio logos before the interactive menu) must hide the button overlay during the intro. `getButtonStartPts()` scans NAV pack PCI data for the first VOBU with `hli_ss > 0` (highlight status active) and `btn_ns > 0` (buttons defined). The PTS difference from the first VOBU gives the intro duration. PCI parsing must skip the 1-byte substream ID after the PES header (`pos + 7`, not `pos + 6`), and `btn_ns` is at PCI offset 0x71 (not 0x74 — the bit fields before it are only 2 bytes per `nav_types.h`).
- **Two playback modes: native cached (VOD) vs. MSE streaming** — the first time a title is watched it streams via MSE (fragmented fMP4, live). When that from-start transcode finishes caching, the server remuxes it to a **faststart (non-fragmented, indexed) `.seek.mp4`** (`remux_to_seekable` in cache.rs, `-c copy -movflags +faststart`) and deletes the fragmented copy. On later views the client HEAD-probes `GET /title-file/{vts}` (`preloadTitleMaps` seeds `titleCached`); a 200 means the seekable file exists, so it plays that **natively with HTTP Range** (`serve_seekable_file` returns 206) — instant, byte-accurate seeking with zero re-transcode (`nativeMode`, seek handler defers to the browser). Only the canonical from-start transcode is cached; mid-title seek segments are requested with `?nocache=1` so they don't pile up overlapping per-sector tails. Cache-status is seeded at disc open, so a title cached mid-session flips to native on the next disc open, not immediately.
- **Scrubbable seeking via re-transcode** (uncached / MSE mode) — the transcode is a linear stream with no HTTP range support, so seeking can't just move the byte position. At disc open, `SessionManager.preloadTitleMaps()` parses each title's cell table (`parseTitlePgcs` reads VTS_PGCIT at IFO offset 0xCC) into a cumulative time→sector map. Every title/scene segment is placed on the **full-movie timeline** via the SourceBuffer `timestampOffset` (= the cell's start time) with `mediaSource.duration` = the whole title, so the seek bar spans the movie and a mid-movie start (scene selection) shows the playhead in the right place. A `seeking` handler serves in-buffer scrubs natively (smooth); for a target outside the buffer it re-transcodes from the cell covering that time (`lookupCellForMs`) and resumes at that cell boundary — so seeks snap to cell granularity (≈1 min on a feature film; The Matrix's main PGC has 106 cells). Our own repositioning is announced via `onProgrammaticSeek` so the handler doesn't mistake it for a user scrub and loop. Menus don't seek (they're `keepAll` + loop).
- **Playback goes through MediaSource, not `<video src>`** — the transcode is a *live* fragmented MP4 (ffmpeg `+empty_moov`), whose `moov` declares duration 0, and the streaming response has no HTTP range support. A plain `<video src>` therefore never plays on Safari and only fills the seek bar as bytes arrive on Chrome/FF. The player (`player/src/mse.ts`) instead fetches the transcode bytes itself and appends them to a `SourceBuffer`, setting `mediaSource.duration` up front from the IFO title duration (so the full seek bar shows immediately) and calling `endOfStream()` to snap it to the true length. Titles use a bounded buffer window (evict-behind + pause-ahead, so a 2-hour movie doesn't OOM); menus use `keepAll` (short, and they loop). `ManagedMediaSource` is used when present (Safari/iOS). **The MSE codec string is derived at runtime** from the fMP4 init segment (`player/src/mp4-codec.ts` parses `moov → … → avcC/esds`) rather than hard-coded — Safari's `SourceBuffer` rejects a MIME that doesn't match the bitstream, and deriving it from the actual bytes means it can't drift from whatever ffmpeg emits (this also auto-handles a video-only stream). The server still pins `-profile:v high -level 4.0` in `transcode.rs` for deterministic output, but the player no longer depends on that pin. **The fMP4 must be muxed with `+default_base_moof`** (alongside `+frag_keyframe+empty_moov`) — without it ffmpeg writes `base-data-offset` addressing in each `tfhd`, which MSE forbids (`CHUNK_DEMUXER_ERROR_APPEND_FAILED`), so every `appendBuffer` fails and playback silently degrades to the native `<video>` path (which reintroduces the Safari/Firefox breakage). If you change the movflags, **delete the transcode cache** (`<disc>/.cache`) — cached `.mp4`s keep their old addressing and stay unplayable on MSE. The element's `src` is now an opaque `blob:` URL; the logical transcode URL lives on `data-transcode-url` (e2e reads that). MSE falls back to native `<video src>` if unsupported or if it errors before playback starts.
- **Test disc has menus** — `make-test-disc.sh` generates a disc with VMGM root menu (5 buttons) and VTS 1 chapters sub-menu (3 buttons) using dvdauthor + spumux. Requires `spumux` (part of dvdauthor package). VTS 1 menu has a 4s intro PGC (no buttons) before the interactive sub-menu PGC (3 buttons) — tests both the multi-PGC menu flow and intro overlay timing. Title 4 is a second PGC in VTS 2 (same titleset as Title 2) to test PGC sector bounds. The e2e tests exercise menu→title, sub-menu→main-menu navigation, multi-PGC sector propagation, and intro overlay timing.
