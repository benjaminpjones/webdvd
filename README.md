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

**Server (Rust):** A local axum server reads a `VIDEO_TS` directory and transcodes MPEG-2/AC-3 video to H.264/AAC on the fly via ffmpeg. The browser gets standard MP4 it can play natively.

**Navigation (WASM):** The canonical `libdvdnav` and `libdvdread` C libraries are compiled to WebAssembly via Emscripten. This gives us battle-tested DVD navigation — the same code that powers VLC and Kodi — running in the browser. The VM executes IFO commands, manages registers, handles PGC chains, and drives the entire disc experience.

**Menus (Canvas):** DVD subpicture overlays (RLE-encoded bitmaps) are decoded and rendered on a `<canvas>` layer over the video. Button highlights, click regions, and arrow-key navigation are driven by PCI packets parsed by libdvdnav.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Server | Rust (axum + tokio) |
| Video transcode | ffmpeg subprocess (MPEG-2 → H.264/AAC → fMP4) |
| DVD navigation | libdvdnav/libdvdread → WASM (Emscripten) |
| Browser app | TypeScript + Vite |
| Video playback | Native `<video>` + MediaSource Extensions |
| Menu rendering | `<canvas>` overlay |

## Quick Start

```bash
# Start the server (requires ffmpeg installed)
cd server
cargo run -- /path/to/VIDEO_TS

# In another terminal, start the player
cd player
npm install
npm run dev
```

Open http://localhost:5173 to watch your DVD.

## Milestones

### M0: Video on Screen
- [x] Project structure (Rust server + TypeScript player)
- [x] Rust server serves VIDEO_TS, transcodes via ffmpeg
- [x] Browser plays transcoded video in `<video>` element

### M1: libdvdnav in WASM
- [ ] Compile libdvdnav + libdvdread to WASM via Emscripten
- [ ] JS bindings: open disc, get title info, execute navigation
- [ ] I/O adapter: VIDEO_TS files fetched from server → Emscripten virtual FS
- [ ] Browser queries disc structure (titles, chapters, audio tracks) via WASM

### M2: VM-Driven Playback
- [ ] Wire libdvdnav block reading to session manager
- [ ] First Play PGC executes automatically on "disc insert"
- [ ] VM navigates to root menu or main title
- [ ] Title/chapter selection through the VM

### M3: Menus
- [ ] Subpicture stream parsing and RLE decoding
- [ ] Button highlight rendering on canvas overlay
- [ ] PCI packet parsing for button coordinates and commands
- [ ] Click/keyboard → button activation → VM command → navigation
- [ ] Full menu → movie → menu flow

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
