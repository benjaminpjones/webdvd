/**
 * session.ts — DVD Session Manager (M2)
 *
 * Orchestrates the libdvdnav VM event loop with <video> playback.
 * Drives First Play PGC on "disc insert", resolves playback targets,
 * and handles title/chapter selection through the VM.
 */

import {
  DvdSession,
  DVDNAV_CELL_CHANGE,
  DVDNAV_VTS_CHANGE,
  DVDNAV_STILL_FRAME,
  DVDNAV_STOP,
  DVDNAV_HOP_CHANNEL,
  DVDNAV_WAIT,
  DVDNAV_SPU_STREAM_CHANGE,
  DVDNAV_AUDIO_STREAM_CHANGE,
  DVDNAV_HIGHLIGHT,
  DVDNAV_SPU_CLUT_CHANGE,
  type DiscStructure,
  type ButtonInfo,
  type ButtonColorTable,
  type NavEvent,
  STUB_MAX_MS,
  STUB_MAX_SECTORS,
} from "./dvdnav";
import { demuxSubpictures } from "./spu-demux";
import { decodeSpuPacket, type SpuImage } from "./spu-decode";
import { MseSource, mseSupported } from "./mse";
import {
  parseTitlePgcs,
  buildTimeSectorMap,
  lookupCellForMs,
  type TimeSectorEntry,
} from "./ifo-parser";

/** Read big-endian uint32 from a Uint8Array */
function readU32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

export interface PlaybackTarget {
  vts: number;
  title: number;
  part: number;
  seekTimeMs?: number;
  sector?: number; // VOB-absolute sector for sector-based seeking
  lastSector?: number; // VOB-absolute last sector of PGC (bounds the read)
}

export type SessionState = "idle" | "loading" | "playing" | "menu" | "stopped";

export interface MenuState {
  buttons: ButtonInfo[];
  currentButton: number;
  clut: number[];
  spuImage?: SpuImage;
  buttonColors?: ButtonColorTable;
}

export class SessionManager {
  private session: DvdSession;
  private video: HTMLVideoElement;
  private structure: DiscStructure;
  private apiBase: string;
  private currentVts = 0;
  private currentTitle = 0;
  private currentPart = 0;
  private menuFirstSector = 0; // VOB-absolute sector where menu video starts (may include intro)
  private menuLastSector = 0; // VOB-absolute last sector of the current menu cell
  private menuButtonSector = 0; // VOB-absolute sector where buttons appear (interactive portion)
  private _state: SessionState = "idle";
  private _menuState: MenuState | null = null;
  private mse: MseSource | null = null;
  private mseFellBack = false;
  // Per-title time→sector maps, built once from the VTS IFO cell tables. Enable
  // seeking anywhere on the bar by re-transcoding from the cell covering the
  // target time. Keyed by `${vts}:${firstSector}:${lastSector}`.
  private titleMaps = new Map<string, { map: TimeSectorEntry[]; durationSec: number }>();
  private titleMapsLoaded = false;
  // Titles whose full transcode is cached as a seekable (faststart) file, keyed
  // like titleMaps. These play via native range-seekable <video> (instant
  // seeking, no re-transcode) instead of the MSE streaming path.
  private titleCached = new Map<string, boolean>();
  // True while the current title plays from the native cached file, so the
  // seek handler defers to the browser instead of re-transcoding.
  private nativeMode = false;
  // The currently playing title's map (looked up from titleMaps).
  private titleTimeMap: TimeSectorEntry[] = [];
  private titleDurationSec = 0;
  private titleVts = 0;
  private titleLastSector = 0;
  // Movie-time we last moved the playhead to ourselves; the seek handler
  // ignores seeks near this value so our own repositioning doesn't re-trigger.
  private programmaticSeekSec: number | null = null;
  private seekDebounce: ReturnType<typeof setTimeout> | null = null;
  private onStateChange: ((state: SessionState) => void) | null = null;
  private onMenuChange: ((menu: MenuState | null) => void) | null = null;
  private onLog: ((msg: string) => void) | null = null;

  constructor(
    session: DvdSession,
    video: HTMLVideoElement,
    structure: DiscStructure,
    opts?: {
      onStateChange?: (state: SessionState) => void;
      onMenuChange?: (menu: MenuState | null) => void;
      onLog?: (msg: string) => void;
    },
  ) {
    this.session = session;
    this.video = video;
    this.structure = structure;
    this.apiBase = `/api/disc/${encodeURIComponent(session.slug)}`;
    this.onStateChange = opts?.onStateChange ?? null;
    this.onMenuChange = opts?.onMenuChange ?? null;
    this.onLog = opts?.onLog ?? null;

    // Scrubbing the seek bar: if the target is already buffered, the browser
    // seeks natively; if not, re-transcode from the cell covering that time.
    this.video.addEventListener("seeking", this.onVideoSeeking);
  }

  private onVideoSeeking = () => {
    if (this._state !== "playing") return;
    // Native cached playback is a real seekable file — let the browser seek.
    if (this.nativeMode) return;
    const t = this.video.currentTime;
    // Ignore our own repositioning (segment start / seek resume).
    if (this.programmaticSeekSec !== null && Math.abs(t - this.programmaticSeekSec) < 0.75) {
      this.programmaticSeekSec = null;
      return;
    }
    // Within buffered data → let the browser seek natively (smooth, no reload).
    if (this.isBuffered(t)) return;
    // Otherwise coalesce rapid drag events, then re-transcode from the target.
    if (this.seekDebounce) clearTimeout(this.seekDebounce);
    this.seekDebounce = setTimeout(() => {
      this.seekDebounce = null;
      this.seekTo(this.video.currentTime);
    }, 250);
  };

  private isBuffered(t: number): boolean {
    const { buffered } = this.video;
    for (let i = 0; i < buffered.length; i++) {
      if (t >= buffered.start(i) && t <= buffered.end(i)) return true;
    }
    return false;
  }

  get state(): SessionState {
    return this._state;
  }

  get title(): number {
    return this.currentTitle;
  }

  get part(): number {
    return this.currentPart;
  }

  get menuState(): MenuState | null {
    return this._menuState;
  }

  private setState(state: SessionState) {
    this._state = state;
    this.onStateChange?.(state);
  }

  /** Check current state (avoids TS narrowing issues after async calls that mutate _state) */
  private inState(state: SessionState): boolean {
    return this._state === state;
  }

  private setMenu(menu: MenuState | null) {
    this._menuState = menu;
    this.onMenuChange?.(menu);
  }

  /** Cache: avoid re-parsing SPU for the same sector range */
  private cachedSpuKey = "";
  private cachedSpuImage: SpuImage | null = null;

  /**
   * Parse SPU from the current menu cell's VOB data and build a full MenuState.
   */
  /**
   * Enter the interactive menu state immediately, then fill in the SPU
   * highlight overlay asynchronously. Interactivity must NOT block on the SPU
   * fetch: for a large animated menu the SPU sector range can be many MB, and
   * awaiting it before setState("menu") leaves the menu unclickable (clicks
   * are dropped while state is still "loading"). Returns null for driveVM.
   */
  private enterMenu(buttons: ButtonInfo[], currentButton: number, clut: number[]): null {
    let buttonColors: ButtonColorTable | undefined;
    try {
      buttonColors = this.session.getButtonColors();
    } catch {
      // PCI not available
    }
    // Interactive right away — buttons are already known from PCI.
    this.setMenu({ buttons, currentButton, clut, buttonColors });
    this.setState("menu");
    // Fetch the highlight overlay in the background and patch it in.
    void this.getMenuSpuImage().then((spuImage) => {
      if (spuImage && this._state === "menu" && this._menuState) {
        this.setMenu({ ...this._menuState, spuImage });
      }
    });
    return null;
  }

  private async getMenuSpuImage(): Promise<SpuImage | undefined> {
    const key = `${this.currentVts}:${this.menuFirstSector}-${this.menuLastSector}`;
    if (key === this.cachedSpuKey && this.cachedSpuImage) {
      return this.cachedSpuImage;
    }

    const vobData = await this.session.getMenuVobData(
      this.currentVts,
      this.menuFirstSector,
      this.menuLastSector,
    );
    if (!vobData || vobData.length === 0) return undefined;

    const packets = demuxSubpictures(vobData);
    if (packets.length === 0) return undefined;

    // Use the last SPU packet (most recent display)
    const decoded = decodeSpuPacket(packets[packets.length - 1].data);
    this.log(
      `SPU: demuxed ${packets.length} packet(s), decoded=${decoded ? `${decoded.width}x${decoded.height}` : "null"}`,
    );
    if (!decoded) return undefined;

    this.cachedSpuKey = key;
    this.cachedSpuImage = decoded;
    return decoded;
  }

  private log(msg: string) {
    console.log(`[session] ${msg}`);
    this.onLog?.(msg);
  }

  /**
   * "Insert disc" — run First Play PGC and start playback.
   * The VM starts at the First Play PGC automatically after dvd_open().
   */
  async start(): Promise<void> {
    this.setState("loading");
    this.log("Starting disc (First Play PGC)...");

    // During First Play, skip title cells — the VM may navigate through
    // warnings/logos before reaching the menu. If no menu is found,
    // try menuCall() to jump directly, then fall back to title playback.
    let target = await this.driveVM(/* acceptTitles */ false);
    if (target) {
      this.playTarget(target);
    } else if (this.inState("menu")) {
      void this.loadMenuVideo();
    } else {
      // No menu found via First Play — try jumping directly to the menu.
      // This handles discs where First Play goes through title-domain
      // cells (warnings/logos) whose VOBs aren't in MEMFS.
      this.log("No menu via First Play — trying menuCall...");
      if (this.session.menuCall(3) || this.session.menuCall(2)) {
        target = await this.driveVM(/* acceptTitles */ false);
        if (this.inState("menu")) {
          void this.loadMenuVideo();
          return;
        }
        if (target) {
          this.playTarget(target);
          return;
        }
      }
      // No menu at all — reset and play first title directly.
      this.log("No menu found — falling back to title playback");
      this.session.reset();
      target = await this.driveVM(/* acceptTitles */ true);
      if (target) {
        this.playTarget(target);
      } else {
        this.log("VM reached STOP without a playback target");
        this.setState("stopped");
      }
    }
  }

  /** Select a title through the VM */
  async selectTitle(title: number): Promise<void> {
    this.setState("loading");
    this.log(`Selecting title ${title}...`);
    this.session.titlePlay(title);
    const target = await this.driveVM(true, false, title);
    if (target) {
      this.playTarget(target);
    } else if (this._state !== "menu") {
      // VM couldn't navigate (title VOBs not in MEMFS) —
      // fall back to direct transcode using IFO title-to-VTS mapping
      const titleInfo = this.structure.titles.find((t) => t.title === title);
      if (titleInfo?.vts) {
        this.log(`VM fallback: playing VTS ${titleInfo.vts} for title ${title}`);
        this.playTarget({
          vts: titleInfo.vts,
          title,
          part: 1,
          sector: titleInfo.firstSector,
          lastSector: titleInfo.lastSector,
        });
      }
    }
  }

  /** Select a chapter — seeks within current title if same VTS, otherwise re-navigates */
  async selectChapter(title: number, chapter: number): Promise<void> {
    const titleInfo = this.structure.titles.find((t) => t.title === title);

    // If same title is already playing, just seek
    if (this.currentTitle === title && this._state === "playing" && titleInfo) {
      const seekMs = chapter > 1 ? titleInfo.chapterTimesMs[chapter - 2] : 0;
      this.log(`Seeking to chapter ${chapter} (${seekMs}ms)`);
      this.video.currentTime = seekMs / 1000;
      this.currentPart = chapter;
      return;
    }

    // Otherwise navigate through the VM
    this.setState("loading");
    this.log(`Navigating to title ${title} chapter ${chapter}...`);
    this.session.partPlay(title, chapter);
    const target = await this.driveVM(true, false, title);
    if (target) {
      this.playTarget(target);
    }
  }

  /* --- Menu interaction (M3) --- */

  menuNavigate(direction: "up" | "down" | "left" | "right"): void {
    if (this._state !== "menu") return;
    const before = this.session.getCurrentButton();
    const ok = this.session.buttonSelect(direction);
    const after = this.session.getCurrentButton();
    this.log(`Navigate ${direction}: ok=${ok} button ${before}→${after}`);
    this.updateMenuHighlight();
  }

  async menuActivate(): Promise<void> {
    if (this._state !== "menu") return;
    const btn = this.session.getCurrentButton();
    const ok = this.session.buttonActivate();
    this.log(`Menu: activate button ${btn} → ok=${ok}`);
    if (!ok) {
      this.log("Activate failed — staying in menu");
      return;
    }
    await this.handlePostActivation();
  }

  async menuClick(dvdX: number, dvdY: number): Promise<void> {
    if (this._state !== "menu") return;
    // Select the button at click position, then activate the current button.
    // This is more reliable than mouseActivate which fails if coords are
    // slightly off a button boundary.
    this.session.mouseSelect(dvdX, dvdY);
    const btn = this.session.getCurrentButton();
    const ok = this.session.buttonActivate();
    this.log(`Menu: click (${dvdX},${dvdY}) → button ${btn}, activate ok=${ok}`);
    if (!ok) {
      this.log("Activate failed — staying in menu");
      return;
    }
    await this.handlePostActivation();
  }

  private async handlePostActivation(): Promise<void> {
    this.setMenu(null);
    this.setState("loading");
    // After button activation, the VM may not immediately navigate —
    // the current menu's cell loop can fire before the jump takes effect.
    // Use postActivation flag to skip the first menu detection.
    const target = await this.driveVM(true, true);
    this.log(
      `Post-activate: target=${target ? `VTS${target.vts}/T${target.title}` : "null"} state=${this._state}`,
    );
    if (target) {
      this.playTarget(target);
    } else if (this._state === "menu") {
      void this.loadMenuVideo();
    }
  }

  /** Return to root menu */
  async returnToMenu(): Promise<void> {
    this.log("Returning to root menu...");
    this.video.pause();
    this.detachSource();
    this.video.removeAttribute("src");
    this.video.removeAttribute("data-transcode-url");

    // Reset VM and drive First Play to initialize the disc structure.
    // acceptTitles=false so we don't accept a title cell as a playback
    // target here — we're looking for a menu, not a title.
    this.session.reset();
    this.setState("loading");
    await this.driveVM(/* acceptTitles */ false);

    if (this._state === "menu") {
      void this.loadMenuVideo();
      return;
    }

    // VM is now initialized (has processed VMGM). Try menuCall —
    // this should work now even though the last block read errored.
    // acceptTitles=false: if the menu PGC auto-advances to a title
    // (some discs' menus post-jump to the main movie instead of
    // pausing for input), we must not treat that title as the user's
    // requested playback target. They pressed Menu, not Play.
    this.log("Trying menuCall after VM init...");
    if (this.session.menuCall(3) || this.session.menuCall(2)) {
      await this.driveVM(/* acceptTitles */ false);
      if (this.inState("menu")) {
        void this.loadMenuVideo();
        return;
      }
    }

    this.log("Could not navigate to menu — this disc may not have one");
    this.setState("stopped");
  }

  private _hoverFailCount = 0;
  menuHover(dvdX: number, dvdY: number): void {
    if (this._state !== "menu") return;
    const before = this.session.getCurrentButton();
    const ok = this.session.mouseSelect(dvdX, dvdY);
    const after = this.session.getCurrentButton();
    if (ok && before !== after) {
      this.log(`Hover: mouseSelect(${dvdX},${dvdY}) ok=${ok} button ${before}→${after}`);
      this._hoverFailCount = 0;
    } else if (!ok && this._hoverFailCount++ % 30 === 0) {
      this.log(`Hover FAIL: mouseSelect(${dvdX},${dvdY}) returned false, current=${before}`);
    }
    if (ok) this.updateMenuHighlight();
  }

  private updateMenuHighlight(): void {
    const currentButton = this.session.getCurrentButton();
    if (this._menuState && currentButton !== this._menuState.currentButton) {
      this.setMenu({ ...this._menuState, currentButton });
    }
  }

  /**
   * Point the <video> at a transcode URL.
   *
   * The server streams a live fragmented MP4 whose `moov` declares duration 0,
   * which breaks Safari playback and leaves the seek bar short on Chrome/FF
   * until fully buffered. We route playback through MediaSource so we can set
   * the real duration (from the IFO) up front. `data-transcode-url` records the
   * logical URL (the element's own `src` becomes an opaque blob: URL under MSE).
   *
   * Falls back to a native `<video src>` when MSE is unavailable or fails
   * before playback has started.
   */
  private attachSource(
    url: string,
    opts: {
      durationHintSec?: number;
      totalDurationSec?: number;
      timestampOffsetSec?: number;
      startAtSec?: number;
      onProgrammaticSeek?: (sec: number) => void;
      keepAll?: boolean;
    } = {},
  ): void {
    this.detachSource();
    this.mseFellBack = false;
    this.video.setAttribute("data-transcode-url", url);

    if (mseSupported()) {
      try {
        this.mse = new MseSource(this.video, url, {
          durationHintSec: opts.durationHintSec,
          totalDurationSec: opts.totalDurationSec,
          timestampOffsetSec: opts.timestampOffsetSec,
          startAtSec: opts.startAtSec,
          onProgrammaticSeek: opts.onProgrammaticSeek,
          keepAll: opts.keepAll,
          onLog: (m) => this.log(m),
          onError: (err) => {
            // Only fall back if playback never started — otherwise a late
            // streaming hiccup would needlessly restart a playing video.
            if (this.mseFellBack || this.video.readyState >= 2) return;
            this.mseFellBack = true;
            this.log(`MSE failed before playback (${String(err)}) — using native src`);
            this.detachSource();
            this.video.src = url;
            this.video.load();
          },
        });
        return;
      } catch (err) {
        this.log(`MSE unavailable (${String(err)}) — using native src`);
      }
    }

    this.video.src = url;
    this.video.load();
  }

  private detachSource(): void {
    if (this.mse) {
      this.mse.destroy();
      this.mse = null;
    }
  }

  /**
   * Load the menu background video. Plays the full sector range (intro +
   * interactive) as a single transcoded video. If there's an intro animation
   * (menuButtonSector > menuFirstSector), the overlay is hidden until the
   * intro cells finish, using IFO cell playback durations for timing.
   */
  private async loadMenuVideo(): Promise<void> {
    let url = `${this.apiBase}/transcode-menu/${this.currentVts}`;
    const params = new URLSearchParams();
    if (this.menuFirstSector > 0) {
      params.set("sector", String(this.menuFirstSector));
    }
    if (this.menuLastSector > 0 && this.menuLastSector > this.menuFirstSector) {
      params.set("lastSector", String(this.menuLastSector));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
    this.log(
      `Loading menu video (VTS ${this.currentVts}, sector=${this.menuFirstSector}-${this.menuLastSector})...`,
    );
    this.video.muted = false;
    this.video.loop = false;
    // Menus are short and loop over their whole range, so buffer everything.
    this.attachSource(url, { keepAll: true });

    // Scan NAV packs in the VOB to find when buttons first appear.
    // This reads the actual PCI highlight data from the disc, matching
    // how a real DVD player discovers button activation timing.
    const introEndSec =
      this.menuButtonSector > this.menuFirstSector ? await this.getButtonStartPts() : 0;
    if (introEndSec > 0) {
      const savedMenu = this._menuState;
      this.setMenu(null); // hide overlay during intro
      this.log(`Intro: ${introEndSec.toFixed(1)}s until buttons (from NAV pack PTS)`);

      const onTimeUpdate = () => {
        if (this.video.currentTime >= introEndSec) {
          this.video.removeEventListener("timeupdate", onTimeUpdate);
          this.log(`Intro finished at ${this.video.currentTime.toFixed(1)}s — showing overlay`);
          this.setMenu(savedMenu);
        }
      };
      this.video.addEventListener("timeupdate", onTimeUpdate);

      // Loop from the interactive portion when video ends
      this.video.onended = () => {
        this.video.currentTime = introEndSec;
        this.video.play().catch(() => {});
      };
    } else {
      // No intro — loop the whole video
      this.video.loop = true;
      this.video.onended = null;
    }
    this.video.play().catch(() => {});
  }

  /**
   * Scan NAV packs in the menu VOB to find when buttons become visible.
   *
   * DVD PCI (Presentation Control Information) in each VOBU's NAV pack
   * defines buttons and their display timing:
   *   - btn_ns: number of buttons (0 = none)
   *   - hli_s_ptm: PTS when highlights should start displaying
   *   - vobu_s_ptm: PTS of this VOBU
   *
   * A real DVD player shows buttons when vobu_s_ptm >= hli_s_ptm.
   * Returns the highlight start time in seconds relative to the menu
   * video start, or 0 if no buttons found / VOB data unavailable.
   */
  private async getButtonStartPts(): Promise<number> {
    const vobData = await this.session.getMenuVobData(
      this.currentVts,
      this.menuFirstSector,
      this.menuLastSector,
    );
    if (!vobData || vobData.length === 0) return 0;

    // PCI layout (offsets from PCI data start, per nav_types.h):
    //   pci_gi_t (0x3C bytes): vobu_s_ptm at +0x0C
    //   nsml_agli_t (0x24 bytes)
    //   hl_gi_t: hli_ss +0x00, hli_s_ptm +0x02, hli_e_ptm +0x06,
    //            btn_se_e_ptm +0x0A, bitfields +0x0E, btn_ofn +0x10, btn_ns +0x11
    // Absolute from PCI start: vobu_s_ptm=0x0C, hli_ss=0x60, hli_s_ptm=0x62, btn_ns=0x71
    const SECTOR_SIZE = 2048;
    // Track PTS across PGC boundaries. Multi-PGC menus (intro PGC + interactive PGC)
    // reset vobu_s_ptm at each PGC start. We accumulate time across resets.
    let pgcBasePts = 0; // accumulated PTS from completed PGCs
    let pgcFirstPts = -1; // first vobu_s_ptm of current PGC
    let prevVobuPts = -1;

    for (let offset = 0; offset + SECTOR_SIZE <= vobData.length; offset += SECTOR_SIZE) {
      // Pack header: 00 00 01 BA
      if (
        vobData[offset] !== 0x00 ||
        vobData[offset + 1] !== 0x00 ||
        vobData[offset + 2] !== 0x01 ||
        vobData[offset + 3] !== 0xba
      )
        continue;

      const stuffing = vobData[offset + 13] & 0x07;
      let pos = offset + 14 + stuffing;

      // Walk PES packets to find the first 0xBF (PCI)
      while (pos + 6 < offset + SECTOR_SIZE) {
        if (vobData[pos] !== 0x00 || vobData[pos + 1] !== 0x00 || vobData[pos + 2] !== 0x01) break;
        const streamId = vobData[pos + 3];
        const pesLen = (vobData[pos + 4] << 8) | vobData[pos + 5];

        if (streamId === 0xbf) {
          // First byte after PES header is substream ID: 0x00=PCI, 0x01=DSI
          if (vobData[pos + 6] !== 0x00) {
            pos += 6 + pesLen;
            continue;
          }
          const pci = pos + 7; // skip PES header (6) + substream ID (1)
          if (pci + 0x72 > offset + SECTOR_SIZE) break;

          const vobuPtm = readU32(vobData, pci + 0x0c);

          // Detect PTS reset (new PGC) — vobu_s_ptm drops significantly
          if (prevVobuPts >= 0 && vobuPtm < prevVobuPts - 45000) {
            pgcBasePts += prevVobuPts - pgcFirstPts;
            pgcFirstPts = vobuPtm;
          }
          if (pgcFirstPts < 0) pgcFirstPts = vobuPtm;
          prevVobuPts = vobuPtm;

          // hli_ss (2 bytes at PCI+0x60): 0=no buttons, 1=different, 2=equal, 3=equal except cmds
          const hliSs = (vobData[pci + 0x60] << 8) | vobData[pci + 0x61];
          const btnNs = vobData[pci + 0x71];

          if (btnNs > 0 && hliSs > 0) {
            // This VOBU has active button highlights — intro animation is over.
            const effectivePts = pgcBasePts + (vobuPtm - pgcFirstPts);
            const seconds = effectivePts / 90000;
            this.log(
              `NAV scan: first active highlight at VOBU pts=${vobuPtm}, hli_ss=${hliSs}, ${btnNs} buttons (${seconds.toFixed(1)}s from menu start)`,
            );
            return Math.max(0, seconds);
          }
          break; // only check first 0xBF per sector (PCI, not DSI)
        }
        pos += 6 + pesLen;
      }
    }
    this.log("NAV scan: no buttons found in VOB data");
    return 0;
  }

  /**
   * Recognise a "dispatcher stub" title and let the VM read through it instead
   * of treating it as something to play.
   *
   * Discs commonly wire a menu button to a degenerate PGC — a fraction of a
   * second over a handful of sectors, no real content — whose post-command
   * chain picks the actual destination. Shrek's Play button lands on a 500ms /
   * 38-sector PGC that jumps to a VMG dispatcher, which in turn JumpTTs to the
   * feature (possibly to a bookmarked chapter). Transcoding the stub yields a
   * clip that looks like nothing happened, so we instead open a read window
   * over its sectors and keep driving: the VM plays through it, runs the
   * post-commands, and reports the real title a few events later.
   *
   * Returns true if the caller should keep driving the VM.
   */
  private traverseDispatcherStub(ev: NavEvent, traversed: Set<string>): boolean {
    const first = ev.firstSector ?? 0;
    const last = ev.pgcLastSector ?? 0;
    const sectors = last - first + 1;
    if ((ev.pgcLengthMs ?? 0) > STUB_MAX_MS) return false;
    if (sectors <= 0 || sectors > STUB_MAX_SECTORS) return false;

    const key = `${this.currentVts}:${first}:${last}`;
    if (traversed.has(key)) return false; // already tried — play it rather than loop
    traversed.add(key);

    if (!this.session.openTitleWindow(this.currentVts, first, last)) return false;
    this.log(
      `Dispatcher stub (title ${ev.title}, ${ev.pgcLengthMs}ms, sectors ${first}-${last}) — ` +
        `running its post-commands instead of playing it`,
    );
    return true;
  }

  /**
   * Drive the VM event loop until we find a playback target, enter a menu, or reach STOP.
   * Yields to the browser event loop periodically to avoid blocking UI.
   * @param acceptTitles If false, skip VTS title cells (for First Play navigation).
   */
  private async driveVM(
    acceptTitles = true,
    postActivation = false,
    requestedTitle?: number,
  ): Promise<PlaybackTarget | null> {
    let clut: number[] = [];
    let lastMenuSector = 0; // Track last menu cell's VOB-absolute sector
    let lastMenuLastSector = 0; // Track last menu cell's VOB-absolute last sector
    // After HOP or button activation, PCI may be stale — skip first menu detection.
    // Start high (999) normally so we don't skip anything.
    let menuCellsSinceHop = postActivation ? 0 : 999;
    // After button activation, require a state transition (HOP or VTS_CHANGE)
    // before accepting a new menu. The current menu's cells may keep looping
    // until the VM processes the button's jump command.
    let awaitingTransition = postActivation;
    const startVts = this.currentVts; // VTS before this driveVM call
    let firstMenuCellSector = -1; // first menu cell sector (for intro animations)
    const MAX_ROUNDS = 500;
    // Dispatcher stubs already read through in this drive, so a stub that
    // links back to itself can't spin forever.
    const stubsTraversed = new Set<string>();

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Yield to browser between rounds
      if (round > 0) {
        await new Promise((r) => setTimeout(r, 0));
      }

      const ev = await this.session.getNextEvent();

      if (ev.error) {
        // "iteration limit" means the C event loop read through many
        // BLOCK_OK/NAV_PACKET events without hitting anything interesting.
        // This happens when seeking through a large menu VOB. Just retry.
        if (ev.error === "iteration limit") {
          this.log(`VM: iteration limit reached, retrying...`);
          continue;
        }

        this.log(`VM error: ${ev.error}`);
        // "Error opening vtsN=X, domain=3" means the VM tried to open
        // title VOBs not in MEMFS. Only fall back to playback if the
        // target VTS is different from our current menu VTS — that means
        // the VM was navigating to a title. If it's the same VTS, the VM
        // was likely navigating to a sub-menu that needs title VOBs we
        // don't have; in that case, stay in the current menu.
        const vtsMatch = ev.error.match(/vtsN=(\d+).*domain=3/);
        if (vtsMatch) {
          const vts = parseInt(vtsMatch[1], 10);
          // Compare against the VTS we were in *before* driveVM started.
          // VTS_CHANGE updates currentVts during the loop, so checking
          // currentVts would always match after a VTS transition.
          if (vts !== startVts) {
            // Look up which title is in this VTS from disc structure.
            // If we know the requested title, use it (avoids ambiguity
            // when multiple titles share a VTS).
            const titleInfo = requestedTitle
              ? this.structure.titles.find((t) => t.title === requestedTitle)
              : this.structure.titles.find((t) => t.vts === vts);
            const title = titleInfo?.title ?? 1;
            this.log(`Falling back to direct transcode of VTS ${vts} (title ${title})`);
            this.currentVts = vts;
            return {
              vts,
              title,
              part: 1,
              sector: titleInfo?.firstSector,
              lastSector: titleInfo?.lastSector,
            };
          }
          this.log(`Sub-menu needs VTS ${vts} title VOBs (not in MEMFS) — cannot navigate`);
        }
        return null;
      }

      switch (ev.event) {
        case DVDNAV_CELL_CHANGE:
          this.log(
            `Cell change: title=${ev.title} part=${ev.part} cellN=${ev.cellN} ` +
              `isVts=${ev.isVts} pgcLength=${ev.pgcLengthMs}ms firstSector=${ev.firstSector}`,
          );
          if (ev.isVts && ev.title && ev.title > 0) {
            if (acceptTitles) {
              if (this.traverseDispatcherStub(ev, stubsTraversed)) continue;
              return {
                vts: this.currentVts,
                title: ev.title,
                part: ev.part ?? 1,
                sector: ev.firstSector,
                lastSector: ev.pgcLastSector,
              };
            }
            // During First Play navigation, skip title cells — the VM
            // may be playing through warnings/logos before reaching the menu.
            this.log(`Skipping title cell (VTS ${this.currentVts}) during navigation`);
            continue;
          }
          // Menu cell — ensure sectors are loaded, then track and check for buttons
          if (!ev.isVts) {
            lastMenuSector = ev.firstSector ?? 0;
            lastMenuLastSector = ev.lastSector ?? 0;
            menuCellsSinceHop++;

            // Track the first menu cell — intro animations precede the
            // interactive menu, so the first cell's sector is where the
            // menu video should start (even if it has no buttons yet).
            if (firstMenuCellSector < 0) {
              firstMenuCellSector = lastMenuSector;
            }

            // On-demand: fetch cell sectors if not yet loaded in MEMFS
            if (lastMenuLastSector > 0 && this.currentVts > 0) {
              const fetched = await this.session.ensureMenuCellLoaded(
                this.currentVts,
                lastMenuSector,
                lastMenuLastSector,
              );
              if (fetched) {
                this.log(
                  `Loaded menu cell sectors ${lastMenuSector}-${lastMenuLastSector} on demand`,
                );
              }
            }

            // After button activation, the VM can emit stale CELL_CHANGE
            // events from the outgoing menu before the jump completes.
            // Skip these until HOP_CHANNEL or VTS_CHANGE clears the flag.
            if (awaitingTransition) {
              this.log(`Menu cell skip (awaitingTransition)`);
              continue;
            }

            // PCI button data is guaranteed fresh here: glue.c defers a
            // menu-domain CELL_CHANGE until the cell's first NAV pack has
            // been processed. If buttons are populated, this cell is an
            // interactive menu. If empty, it's an intro/non-interactive
            // cell and we wait for a subsequent event with buttons.
            const buttons = this.session.getButtons();
            if (buttons.length > 0) {
              let currentButton = this.session.getCurrentButton();
              // Clamp stale highlight to valid range
              if (currentButton < 1 || currentButton > buttons.length) {
                currentButton = 1;
              }
              // Start the menu video from the first cell (which may be an
              // intro animation before the interactive portion).
              this.menuFirstSector =
                firstMenuCellSector >= 0 ? firstMenuCellSector : lastMenuSector;
              this.menuLastSector = lastMenuLastSector;
              this.menuButtonSector = lastMenuSector;
              this.log(
                `Menu detected via CELL_CHANGE: ${buttons.length} buttons, current=${currentButton}, sector=${this.menuFirstSector}-${this.menuLastSector}`,
              );
              return this.enterMenu(buttons, currentButton, clut);
            }
            // No buttons but PCI is fresh — the cell genuinely has no
            // buttons. Don't track as intro: the visual menu content may
            // already be visible (e.g. background animation playing before
            // button regions are defined in a later cell's NAV packs).
          }
          continue;

        case DVDNAV_VTS_CHANGE:
          // libdvdnav uses -1 for VMGM (no titleset); we use 0
          this.currentVts = (ev.newVtsN ?? 0) < 0 ? 0 : ev.newVtsN!;
          this.log(
            `VTS change: ${ev.oldVtsN} → ${ev.newVtsN} (domain ${ev.oldDomain} → ${ev.newDomain})`,
          );
          awaitingTransition = false;
          continue;

        case DVDNAV_STILL_FRAME: {
          const stillButtons = this.session.getButtons();
          if (stillButtons.length > 0 && !awaitingTransition) {
            // Still frame with buttons — this is a menu (infinite still)
            // or a slide-based sub-menu (timed still, e.g. Cast & Crew).
            // Either way, wait for user input.
            let currentButton = this.session.getCurrentButton();
            if (currentButton < 1 || currentButton > stillButtons.length) {
              currentButton = 1;
            }
            this.menuFirstSector = firstMenuCellSector >= 0 ? firstMenuCellSector : lastMenuSector;
            this.menuLastSector = lastMenuLastSector;
            this.menuButtonSector = lastMenuSector;
            this.log(
              `Menu via STILL_FRAME (${ev.stillLength === 0xff ? "infinite" : ev.stillLength + "s"}): ${stillButtons.length} buttons, current=${currentButton}, sector=${this.menuFirstSector}-${this.menuLastSector}`,
            );
            return this.enterMenu(stillButtons, currentButton, clut);
          }
          // No buttons — skip the still
          if (ev.stillLength === 0xff) {
            this.log("Infinite still with no buttons — skipping");
          } else {
            this.log(`Still frame: ${ev.stillLength}s, no buttons — skipping`);
          }
          this.session.stillSkip();
          continue;
        }

        case DVDNAV_SPU_CLUT_CHANGE:
          if (ev.clut) clut = ev.clut;
          continue;

        case DVDNAV_HIGHLIGHT: {
          const hlButtons = this.session.getButtons();
          this.log(
            `Highlight: button=${ev.buttonN} display=${ev.display} availableButtons=${hlButtons.length} cellsSinceHop=${menuCellsSinceHop}`,
          );
          if (ev.display && ev.display > 0 && hlButtons.length > 0) {
            // After HOP_CHANNEL, PCI is stale until NAV_PACKETs from the
            // new PGC have been read. HIGHLIGHT can fire before that happens,
            // so skip it when we haven't seen enough cells since the hop.
            if (menuCellsSinceHop < 2 || awaitingTransition) {
              this.log(
                `Ignoring HIGHLIGHT (cellsSinceHop=${menuCellsSinceHop}, awaitingTransition=${awaitingTransition})`,
              );
              continue;
            }
            let currentButton = this.session.getCurrentButton();
            if (currentButton < 1 || currentButton > hlButtons.length) {
              currentButton = 1;
            }
            this.menuFirstSector = firstMenuCellSector >= 0 ? firstMenuCellSector : lastMenuSector;
            this.menuLastSector = lastMenuLastSector;
            this.menuButtonSector = lastMenuSector;
            this.log(
              `Menu detected via HIGHLIGHT: ${hlButtons.length} buttons, current=${currentButton}, sector=${this.menuFirstSector}-${this.menuLastSector}`,
            );
            return this.enterMenu(hlButtons, currentButton, clut);
          }
          continue;
        }

        case DVDNAV_STOP:
          this.log("VM reached STOP");
          if (awaitingTransition) {
            // Button activation navigated to a title whose VOBs aren't
            // in MEMFS (empty placeholder). The VM stopped instead of
            // erroring. Check if there's a plausible title to play.
            const vts = this.currentVts > 0 ? this.currentVts : 1;
            const titleInfo = this.structure.titles.find((t) => t.vts === vts);
            if (titleInfo) {
              this.log(
                `STOP after activation — falling back to VTS ${vts} (title ${titleInfo.title})`,
              );
              return { vts, title: titleInfo.title, part: 1 };
            }
          }
          this.setState("stopped");
          return null;

        case DVDNAV_WAIT:
          this.log("VM wait — skipping");
          this.session.waitSkip();
          continue;

        case DVDNAV_HOP_CHANNEL:
          this.log("Hop channel (decoder flush)");
          menuCellsSinceHop = 0;
          firstMenuCellSector = -1;
          awaitingTransition = false;
          continue;

        case DVDNAV_SPU_STREAM_CHANGE:
        case DVDNAV_AUDIO_STREAM_CHANGE:
          continue;

        default:
          if (ev.event < 0) {
            this.log(`VM error event: ${ev.error ?? "unknown"}`);
            return null;
          }
          this.log(`Unhandled event: ${ev.event}`);
          continue;
      }
    }

    this.log("driveVM: max rounds reached without resolution");
    return null;
  }

  /**
   * Build time→sector maps for every title from the VTS IFOs. Run once at disc
   * open (before playback) so `playTarget` can look a map up synchronously.
   * Each map (cumulative cell start-time → start sector) powers the full-movie
   * seek bar and seek-anywhere. Failures are non-fatal: a title without a map
   * just falls back to the old segment-relative seek bar.
   */
  async preloadTitleMaps(): Promise<void> {
    if (this.titleMapsLoaded) return;
    this.titleMapsLoaded = true;

    // One IFO per titleset; parse it once and match each title to its PGC.
    const vtsSet = new Set(this.structure.titles.map((t) => t.vts).filter((v) => v > 0));
    await Promise.all(
      [...vtsSet].map(async (vts) => {
        try {
          const fname = `VTS_${String(vts).padStart(2, "0")}_0.IFO`;
          const res = await fetch(`${this.apiBase}/ifo/${fname}`);
          if (!res.ok) throw new Error(`ifo fetch ${res.status}`);
          const pgcs = parseTitlePgcs(await res.arrayBuffer());
          for (const title of this.structure.titles.filter((t) => t.vts === vts)) {
            const pgc =
              pgcs.find(
                (p) => p.firstSector === title.firstSector && p.lastSector === title.lastSector,
              ) ?? pgcs.find((p) => p.firstSector === title.firstSector);
            if (pgc && pgc.cells.length > 0) {
              const key = `${vts}:${title.firstSector}:${title.lastSector}`;
              this.titleMaps.set(key, {
                map: buildTimeSectorMap(pgc.cells),
                durationSec: pgc.durationMs / 1000,
              });
            }
          }
        } catch (err) {
          this.log(`Title map load failed for VTS ${vts}: ${String(err)}`);
        }
      }),
    );

    // Probe which titles are already cached as a seekable file → native
    // range playback instead of MSE streaming.
    await Promise.all(
      this.structure.titles.map(async (t) => {
        const cached = await this.probeTitleCached(t.vts, t.firstSector, t.lastSector);
        if (cached) this.titleCached.set(`${t.vts}:${t.firstSector}:${t.lastSector}`, true);
      }),
    );
    this.log(
      `Preloaded ${this.titleMaps.size} title map(s), ${this.titleCached.size} seekable-cached`,
    );
  }

  /** HEAD the seekable-file endpoint: 200 ⇒ the full title is cached seekable. */
  private async probeTitleCached(
    vts: number,
    firstSector: number,
    lastSector: number,
  ): Promise<boolean> {
    if (vts <= 0) return false;
    try {
      const res = await fetch(this.titleFileUrl(vts, firstSector, lastSector), { method: "HEAD" });
      return res.ok;
    } catch {
      return false;
    }
  }

  private titleFileUrl(vts: number, firstSector: number, lastSector: number): string {
    const params = new URLSearchParams();
    if (firstSector > 0) params.set("sector", String(firstSector));
    if (lastSector > 0) params.set("lastSector", String(lastSector));
    const qs = params.toString();
    return `${this.apiBase}/title-file/${vts}${qs ? `?${qs}` : ""}`;
  }

  /** Point the current-title map fields at the cached map for this title. */
  private useTitleMap(vts: number, firstSector: number, lastSector: number): void {
    const entry = this.titleMaps.get(`${vts}:${firstSector}:${lastSector}`);
    if (entry) {
      this.titleTimeMap = entry.map;
      this.titleDurationSec = entry.durationSec;
    } else {
      this.titleTimeMap = [];
      this.titleDurationSec = 0;
    }
  }

  /** Movie-time (seconds) at which the cell starting at `sector` begins. */
  private segmentStartSec(sector?: number): number {
    if (!sector || sector <= 0 || this.titleTimeMap.length === 0) return 0;
    const entry = this.titleTimeMap.find((e) => e.firstSector === sector);
    return entry ? entry.startMs / 1000 : 0;
  }

  /**
   * Seek to `targetSec` in the current title by re-transcoding from the cell
   * that covers it (the nearest cell boundary at or before the target), then
   * resuming playback exactly at `targetSec`. Used for scrubs that land outside
   * the buffered window.
   */
  private seekTo(targetSec: number): void {
    if (this._state !== "playing" || this.titleTimeMap.length === 0) return;
    const cell = lookupCellForMs(this.titleTimeMap, targetSec * 1000);
    if (!cell) return;
    // Playback resumes at the cell boundary (at or just before the target) —
    // instant, since the transcode starts there. Fine-tuning inside the target
    // region is then a smooth native seek within the buffer.
    this.log(
      `Seek ${targetSec.toFixed(1)}s → cell sector ${cell.firstSector} ` +
        `(cell start ${(cell.startMs / 1000).toFixed(1)}s)`,
    );
    this.playTarget({
      vts: this.titleVts,
      title: this.currentTitle,
      part: this.currentPart,
      sector: cell.firstSector,
      lastSector: this.titleLastSector,
    });
  }

  /**
   * Start (or re-point) title playback. The transcode covers [sector → title
   * end]; when a time→sector map is available we place it on the full-title
   * timeline via `timestampOffsetSec` and set the bar to the whole title, so a
   * mid-movie start shows the playhead in the right place.
   */
  private playTarget(target: PlaybackTarget): void {
    this.currentTitle = target.title;
    this.currentPart = target.part;
    const vts = target.vts;

    this.log(
      `Playing VTS ${vts} (title ${target.title}, chapter ${target.part}, sector=${target.sector ?? 0}, lastSector=${target.lastSector ?? 0})`,
    );
    this.setState("loading");

    const titleInfo = this.structure.titles.find((t) => t.title === target.title);
    if (titleInfo) {
      this.useTitleMap(vts, titleInfo.firstSector, titleInfo.lastSector);
    } else {
      this.titleTimeMap = [];
      this.titleDurationSec = 0;
    }
    this.titleVts = vts;
    this.titleLastSector = target.lastSector ?? titleInfo?.lastSector ?? 0;

    // Where this segment sits on the full-movie timeline. Playback resumes here.
    const segStartSec = this.segmentStartSec(target.sector);

    const canonicalKey = titleInfo ? `${vts}:${titleInfo.firstSector}:${titleInfo.lastSector}` : "";

    this.video.muted = false; // unmute for title playback
    this.video.loop = false; // titles don't loop — onended resumes VM

    if (titleInfo && this.titleCached.get(canonicalKey)) {
      // The whole title is cached as a seekable file — play it natively with
      // HTTP Range so seeking anywhere is instant and needs no re-transcode.
      this.nativeMode = true;
      this.detachSource();
      const fileUrl = this.titleFileUrl(vts, titleInfo.firstSector, titleInfo.lastSector);
      this.log(`Playing cached seekable title natively (seek to ${segStartSec.toFixed(1)}s)`);
      this.video.setAttribute("data-transcode-url", fileUrl);
      this.video.src = fileUrl;
      this.video.load();
      if (segStartSec > 0) {
        const onMeta = () => {
          this.video.removeEventListener("loadedmetadata", onMeta);
          this.video.currentTime = segStartSec; // native range-seek into the file
        };
        this.video.addEventListener("loadedmetadata", onMeta);
      }
    } else {
      // Streaming path: MSE. Mid-title (seek) segments aren't canonical, so tag
      // them nocache — only the from-start transcode is cached (then remuxed to
      // the seekable file that flips this title to native mode next time).
      this.nativeMode = false;
      const isCanonical = !target.sector || target.sector === titleInfo?.firstSector;
      let url = `${this.apiBase}/transcode/${vts}`;
      const params = new URLSearchParams();
      if (target.sector && target.sector > 0) params.set("sector", String(target.sector));
      if (target.lastSector && target.lastSector > 0) {
        params.set("lastSector", String(target.lastSector));
      }
      if (!isCanonical) params.set("nocache", "1");
      const qs = params.toString();
      if (qs) url += `?${qs}`;

      // With a title map, the bar spans the whole movie (totalDurationSec) and
      // the segment is offset into it. Without one, fall back to a rough
      // estimate of the remaining runtime so the bar at least has a length.
      const totalDurationSec = this.titleDurationSec > 0 ? this.titleDurationSec : undefined;
      let durationHintSec: number | undefined;
      if (!totalDurationSec && titleInfo && titleInfo.durationMs > 0) {
        const chapterStartMs =
          target.part > 1 ? (titleInfo.chapterTimesMs[target.part - 2] ?? 0) : 0;
        durationHintSec = Math.max(0, (titleInfo.durationMs - chapterStartMs) / 1000);
      }

      this.attachSource(url, {
        durationHintSec,
        totalDurationSec,
        timestampOffsetSec: segStartSec,
        startAtSec: segStartSec,
        onProgrammaticSeek: (sec) => {
          this.programmaticSeekSec = sec;
        },
      });
    }

    const onCanPlay = () => {
      this.video.removeEventListener("canplay", onCanPlay);

      this.video
        .play()
        .then(() => {
          this.setState("playing");
        })
        .catch((err) => {
          this.log(`Play failed: ${err}`);
        });
    };

    this.video.addEventListener("canplay", onCanPlay);

    this.video.onended = async () => {
      this.log("Video ended — resuming VM for post-commands...");
      // The disc may have post-commands (e.g. "call vmgm menu") that
      // navigate back to a menu or to the next title.
      this.session.stillSkip(); // signal that the still/end is done
      const nextTarget = await this.driveVM();
      if (nextTarget) {
        this.playTarget(nextTarget);
      } else if (this._state === "menu") {
        void this.loadMenuVideo();
      } else if (this._state !== "stopped") {
        this.setState("stopped");
      }
    };
  }
}
