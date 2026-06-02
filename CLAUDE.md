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
- **Test disc has menus** — `make-test-disc.sh` generates a disc with VMGM root menu (5 buttons) and VTS 1 chapters sub-menu (3 buttons) using dvdauthor + spumux. Requires `spumux` (part of dvdauthor package). VTS 1 menu has a 4s intro PGC (no buttons) before the interactive sub-menu PGC (3 buttons) — tests both the multi-PGC menu flow and intro overlay timing. Title 4 is a second PGC in VTS 2 (same titleset as Title 2) to test PGC sector bounds. The e2e tests exercise menu→title, sub-menu→main-menu navigation, multi-PGC sector propagation, and intro overlay timing.
