# CLAUDE.md

See README.md for architecture, design details, and milestones.

## Development

```bash
# Build WASM (requires emcc on PATH)
./wasm/build.sh

# Generate test disc (requires ffmpeg + dvdauthor)
./scripts/make-test-disc.sh

# Run server
cd server && cargo run -- /tmp/webdvd-test/VIDEO_TS

# Run player (separate terminal)
cd player && npm run dev

# Tests
node wasm/test.mjs            # WASM smoke test (Node.js)
cd player && npm test          # Playwright e2e (headless browser)
```

## Validation

**Always run the e2e tests before submitting changes:**

```bash
cd player && npm test
```

Playwright auto-starts both servers. The e2e suite verifies disc structure, menu loading, button navigation, sub-menu flow, and title playback from menus.

## Gotchas

- **WASM MEMFS must include VOB files** — not just IFOs. The VM calls `dvdnav_get_next_block()` which reads NAV packs from VOBs. Without VOBs in MEMFS, the event loop fails silently and playback never starts.
- **`dvd_get_next_event()` discards MPEG-2 data** — it loops `dvdnav_get_next_block()` internally, skipping BLOCK_OK/NAV_PACKET/NOP. Only navigation events come back to JS. The server handles actual video transcoding separately.
- **Post-activation stale events** — after button activation, the VM's event loop emits stale CELL_CHANGE/HIGHLIGHT/STILL_FRAME events from the old menu before the jump completes. `awaitingTransition` in `driveVM()` blocks menu detection until HOP_CHANNEL or VTS_CHANGE fires. Similarly, `menuCellsSinceHop` skips the first menu cell after a HOP because its PCI is not yet populated.
- **Sector-based seeking** — chapter and menu cell playback use VOB-absolute sector offsets from IFO `cell_playback`, not time-based `?ss=`. The server reads across multi-VOB file boundaries. For menu cells, `lastSector` limits the byte range to prevent bleeding into adjacent cells.
- **Test disc has menus** — `make-test-disc.sh` generates a disc with VMGM root menu (3 buttons) and VTS 1 chapters sub-menu (3 buttons) using dvdauthor + spumux. Requires `spumux` (part of dvdauthor package). The e2e tests exercise menu→title and sub-menu→main-menu navigation.
