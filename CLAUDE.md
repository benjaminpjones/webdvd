# CLAUDE.md

## Project

webdvd — a web-based DVD player with faithful menu reproduction.

## Architecture Decisions

- **Rust server (axum/tokio)** handles VIDEO_TS serving and MPEG-2 → H.264/AAC transcode via ffmpeg subprocess
- **libdvdnav/libdvdread compiled to WASM** via Emscripten for browser-side DVD navigation (IFO parsing, VM, PGC execution, button handling)
- **TypeScript + Vite** browser app orchestrates WASM navigation + native `<video>` playback + `<canvas>` menu overlays
- DVD.js (2014 JS port) was evaluated and rejected — stale, incomplete. We use the canonical C libs via WASM instead.

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

## Current Status

M0 and M1 are complete. Next: M2 (VM-driven playback). See README.md for full milestone plan.

## Key Research

- DVD IFO VM: ~8 instruction categories, 64-bit opcodes, 24 SPRMs + 16 GPRMs. Spec at dvd.sourceforge.net/dvdinfo/
- Subpictures: 2bpp RLE, 4 colors from 16-entry CLUT, button highlights in PCI packets
- MPEG-2 has no native browser support — hence server-side transcode
- AC-3 audio has no native browser support either
- libav.js is precedent for compiling C multimedia libs to WASM via Emscripten
