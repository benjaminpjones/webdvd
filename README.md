# webdvd

A web-based DVD player that faithfully reproduces the full DVD experience — menus, navigation, chapter selection, and all — in the browser.

Pop in your DVD, point webdvd at the `VIDEO_TS` folder, and relive 1999 in a browser tab.

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Browser                     │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  IFO VM  │  │ Subpic   │  │  MPEG-2   │  │
│  │ (nav     │  │ Renderer │  │  Decoder   │  │
│  │  engine) │  │ (menus)  │  │  (WASM)   │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       │              │              │         │
│       └──────────┬───┘──────────────┘         │
│                  │                            │
│           ┌──────┴──────┐                     │
│           │ DVD Session │                     │
│           │  Manager    │                     │
│           └──────┬──────┘                     │
└──────────────────┼────────────────────────────┘
                   │ HTTP / WebSocket
┌──────────────────┼────────────────────────────┐
│           ┌──────┴──────┐                     │
│           │ Disc Server │    Local machine     │
│           │ (Go/Rust)   │                      │
│           └──────┬──────┘                     │
│                  │                            │
│           ┌──────┴──────┐                     │
│           │  VIDEO_TS/  │                     │
│           └─────────────┘                     │
└───────────────────────────────────────────────┘
```

## Components

### 1. Disc Server (local)

A lightweight local server that reads a `VIDEO_TS` directory and serves its contents over HTTP.

**Endpoints:**
- `GET /ifo/:file` — serve parsed IFO/BUP files (raw or as JSON)
- `GET /vob/:title/:sector?count=N` — serve VOB sectors by logical block address
- `GET /disc` — disc metadata (titles, duration, audio/subtitle tracks)

**Tech:** Go or Rust. Minimal dependencies. Handles CSS decryption via libdvdcss if reading from a physical drive, or serves pre-decrypted VIDEO_TS folders directly.

### 2. IFO Navigation VM (browser)

A JavaScript/WASM reimplementation of the DVD navigation virtual machine.

**What it does:**
- Executes the register-based VM defined in the IFO files
- Manages 24 system parameter registers (SPRMs) — current title, chapter, audio stream, subpicture stream, player region, parental level, etc.
- Manages 16 general purpose registers (GPRMs) — used by disc authors for menu state, easter eggs, branching logic
- Handles ~16 VM instructions: jump, link, compare, set register, etc.
- Processes PGC (Program Chain) navigation: pre/post commands, cell commands
- Drives the entire user experience — every menu transition, every "play movie" action flows through this VM

**Reference:** `libdvdnav` (C, GPL) is the canonical implementation.

### 3. Subpicture / Menu Renderer (browser)

Renders DVD menus as interactive overlays on a `<canvas>`.

**What it does:**
- Decodes subpicture units (RLE-encoded bitmaps) from VOB streams
- Renders button highlight overlays with correct palette/contrast
- Maps button coordinates from PCI (Presentation Control Information) packets to clickable regions
- Handles button state transitions: normal → selected → activated
- Supports button navigation (up/down/left/right routing between buttons)
- Composites subpicture overlay on top of still frame or looping video background

### 4. MPEG-2 Decoder (browser, WASM)

Decodes the MPEG-2 Program Stream format used by DVDs.

**Options (in order of preference):**
1. **Minimal MPEG-2 WASM decoder** — compile a focused MPEG-2 decoder (e.g., libmpeg2) to WASM. Small, fast, purpose-built.
2. **ffmpeg.wasm** — heavier but handles every edge case. Good fallback.
3. **Transcode on server** — re-encode to H.264 on the fly. Simplest browser-side, but adds server load and latency, breaks seamless VOB transitions.

**Must support:**
- MPEG-2 video demux from VOB (Program Stream) containers
- Audio: AC3 (Dolby Digital), DTS, LPCM, MPEG audio
- Seamless playback across VOB boundaries (cells can span multiple VOBs)

### 5. DVD Session Manager (browser)

Orchestrates the other components. The central state machine.

- Receives navigation commands from the IFO VM ("play cell 3 of PGC 1 in title set 2")
- Requests the right VOB sectors from the disc server
- Feeds data to the MPEG-2 decoder
- Tells the subpicture renderer when to show/hide overlays
- Handles user input (remote control actions) and routes them to the VM
- Manages playback state: play, pause, fast-forward, chapter skip

## Milestones

### M0: Foundation
- [ ] Set up project structure (monorepo: `server/`, `player/`)
- [ ] Disc server: serve raw files from a VIDEO_TS directory over HTTP
- [ ] IFO parser: parse VMG (Video Manager) and VTS (Video Title Set) IFO files into structured data
- [ ] Basic browser shell with video element

### M1: Straight-to-Movie Playback
- [ ] VOB sector serving with byte-range support
- [ ] MPEG-2 decoding in WASM (video only, single title)
- [ ] Audio decoding (AC3 at minimum)
- [ ] Continuous playback across VOB file boundaries
- [ ] Basic transport controls (play/pause/seek)

### M2: Navigation VM
- [ ] Implement the IFO VM instruction set
- [ ] SPRM/GPRM register management
- [ ] PGC navigation (program chains, cells, pre/post commands)
- [ ] Title/chapter selection working through the VM
- [ ] First Play PGC execution (what happens when you "insert the disc")

### M3: Menus
- [ ] Subpicture stream parsing and RLE decoding
- [ ] Button highlight rendering on canvas overlay
- [ ] PCI packet parsing for button coordinates and commands
- [ ] Click/keyboard input mapped to button activation
- [ ] Button-to-button navigation (arrow key routing)
- [ ] Menu-to-content and content-to-menu transitions

### M4: Full Experience
- [ ] Multi-angle support
- [ ] Subtitle rendering (subpicture streams during playback, not just menus)
- [ ] Audio stream switching
- [ ] Parental control levels
- [ ] Region code handling
- [ ] Resume from stop

### M5: Polish
- [ ] Faithful transition timing (match real player behavior)
- [ ] Disc library / collection view
- [ ] Player skin themes (remember those?)
- [ ] Mobile touch support for menu interaction

## Prior Art & References

- **libdvdnav** / **libdvdread** — C libraries for DVD navigation and reading. The definitive reference for the IFO VM and disc structure.
- **libdvdcss** — CSS decryption library.
- **dvdauthor** — DVD authoring tool. Useful reference for understanding the IFO format from the creator's side.
- **MPEG-2 spec (ISO 13818)** — the video/audio codec spec.
- **DVD-Video spec (ECMA-267 / ISO/IEC 16448)** — UDF filesystem used by DVDs.
- [DVD-Video information](http://dvd.sourceforge.net/dvdinfo/) — community-maintained spec documentation.

## License

MIT
