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
} from "./dvdnav";
import { demuxSubpictures } from "./spu-demux";
import { decodeSpuPacket, type SpuImage } from "./spu-decode";

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
  private currentVts = 0;
  private currentTitle = 0;
  private currentPart = 0;
  private menuFirstSector = 0; // VOB-absolute sector of the current menu cell
  private menuLastSector = 0; // VOB-absolute last sector of the current menu cell
  private _state: SessionState = "idle";
  private _menuState: MenuState | null = null;
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
    this.onStateChange = opts?.onStateChange ?? null;
    this.onMenuChange = opts?.onMenuChange ?? null;
    this.onLog = opts?.onLog ?? null;
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
  private buildMenuState(buttons: ButtonInfo[], currentButton: number, clut: number[]): MenuState {
    const spuImage = this.getMenuSpuImage();
    let buttonColors: ButtonColorTable | undefined;
    try {
      buttonColors = this.session.getButtonColors();
    } catch {
      // PCI not available
    }
    return { buttons, currentButton, clut, spuImage, buttonColors };
  }

  private getMenuSpuImage(): SpuImage | undefined {
    const key = `${this.currentVts}:${this.menuFirstSector}-${this.menuLastSector}`;
    if (key === this.cachedSpuKey && this.cachedSpuImage) {
      return this.cachedSpuImage;
    }

    const vobData = this.session.getMenuVobData(
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
      this.loadMenuVideo();
    } else {
      // No menu found via First Play — try jumping directly to the menu.
      // This handles discs where First Play goes through title-domain
      // cells (warnings/logos) whose VOBs aren't in MEMFS.
      this.log("No menu via First Play — trying menuCall...");
      if (this.session.menuCall(3) || this.session.menuCall(2)) {
        target = await this.driveVM(/* acceptTitles */ false);
        if (this.inState("menu")) {
          this.loadMenuVideo();
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
      this.loadMenuVideo();
    }
  }

  /** Return to root menu */
  async returnToMenu(): Promise<void> {
    this.log("Returning to root menu...");
    this.video.pause();
    this.video.removeAttribute("src");

    // Reset VM and drive First Play to initialize the disc structure.
    // This will error on title VOBs, but the VM is now initialized.
    this.session.reset();
    this.setState("loading");
    await this.driveVM();

    if (this._state === "menu") {
      this.loadMenuVideo();
      return;
    }

    // VM is now initialized (has processed VMGM). Try menuCall —
    // this should work now even though the last block read errored.
    this.log("Trying menuCall after VM init...");
    if (this.session.menuCall(3) || this.session.menuCall(2)) {
      const target = await this.driveVM();
      if (this.inState("menu")) {
        this.loadMenuVideo();
        return;
      }
      if (target) {
        this.playTarget(target);
        return;
      }
    }

    this.log("Could not navigate to menu");
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
   * Load the menu background video. Seeks to the current menu PGC's cell
   * position so sub-menus (e.g. Scene Selection) show the correct video.
   */
  private loadMenuVideo(): void {
    let url = `/api/transcode-menu/${this.currentVts}`;
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
    this.video.src = url;
    this.video.muted = false;
    this.video.loop = false;
    this.video.load();
    // Animated menus: loop back to start when video ends
    this.video.onended = () => {
      this.video.currentTime = 0;
      this.video.play().catch(() => {});
    };
    this.video.play().catch(() => {});
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
    const MAX_ROUNDS = 500;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Yield to browser between rounds
      if (round > 0) {
        await new Promise((r) => setTimeout(r, 0));
      }

      const ev = this.session.getNextEvent();

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

            // After HOP_CHANNEL, PCI is stale until NAV_PACKETs from the
            // new PGC are read. The first CELL_CHANGE fires before any
            // NAV_PACKET, so skip it. By the second CELL_CHANGE, the C loop
            // has read blocks (including NAV_PACKETs) from the first cell.
            if (menuCellsSinceHop < 2 || awaitingTransition) {
              this.log(
                `Menu cell skip (cellsSinceHop=${menuCellsSinceHop}, awaitingTransition=${awaitingTransition})`,
              );
              continue;
            }

            const buttons = this.session.getButtons();
            if (buttons.length > 0) {
              let currentButton = this.session.getCurrentButton();
              // Clamp stale highlight to valid range
              if (currentButton < 1 || currentButton > buttons.length) {
                currentButton = 1;
              }
              this.menuFirstSector = lastMenuSector;
              this.menuLastSector = lastMenuLastSector;
              this.log(
                `Menu detected via CELL_CHANGE: ${buttons.length} buttons, current=${currentButton}, sector=${this.menuFirstSector}-${this.menuLastSector}`,
              );
              this.setMenu(this.buildMenuState(buttons, currentButton, clut));
              this.setState("menu");
              return null;
            }
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
            this.menuFirstSector = lastMenuSector;
            this.menuLastSector = lastMenuLastSector;
            this.log(
              `Menu via STILL_FRAME (${ev.stillLength === 0xff ? "infinite" : ev.stillLength + "s"}): ${stillButtons.length} buttons, current=${currentButton}, sector=${this.menuFirstSector}-${this.menuLastSector}`,
            );
            this.setMenu(this.buildMenuState(stillButtons, currentButton, clut));
            this.setState("menu");
            return null;
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
            this.menuFirstSector = lastMenuSector;
            this.menuLastSector = lastMenuLastSector;
            this.log(
              `Menu detected via HIGHLIGHT: ${hlButtons.length} buttons, current=${currentButton}, sector=${this.menuFirstSector}-${this.menuLastSector}`,
            );
            this.setMenu(this.buildMenuState(hlButtons, currentButton, clut));
            this.setState("menu");
            return null;
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

  private playTarget(target: PlaybackTarget): void {
    this.currentTitle = target.title;
    this.currentPart = target.part;
    const vts = target.vts;

    this.log(
      `Playing VTS ${vts} (title ${target.title}, chapter ${target.part}, sector=${target.sector ?? 0}, lastSector=${target.lastSector ?? 0})`,
    );
    this.setState("loading");

    let url = `/api/transcode/${vts}`;
    const params = new URLSearchParams();
    if (target.sector && target.sector > 0) {
      params.set("sector", String(target.sector));
    }
    if (target.lastSector && target.lastSector > 0) {
      params.set("lastSector", String(target.lastSector));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
    this.video.src = url;
    this.video.muted = false; // unmute for title playback
    this.video.loop = false; // titles don't loop — onended resumes VM
    this.video.load();

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
        this.loadMenuVideo();
      } else if (this._state !== "stopped") {
        this.setState("stopped");
      }
    };
  }
}
