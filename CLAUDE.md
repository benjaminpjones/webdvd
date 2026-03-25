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

Playwright auto-starts both servers. The e2e suite verifies disc structure, title buttons, and that VM-driven auto-play actually starts video playback (not just that a URL was set).

## Gotchas

- **WASM MEMFS must include VOB files** — not just IFOs. The VM calls `dvdnav_get_next_block()` which reads NAV packs from VOBs. Without VOBs in MEMFS, the event loop fails silently and playback never starts.
- **`dvd_get_next_event()` discards MPEG-2 data** — it loops `dvdnav_get_next_block()` internally, skipping BLOCK_OK/NAV_PACKET/NOP. Only navigation events come back to JS. The server handles actual video transcoding separately.
- **Menu fallback** — if the disc's First Play PGC lands in a menu (infinite still), the session manager falls back to `titlePlay(1)`. Real menu support is M3.
