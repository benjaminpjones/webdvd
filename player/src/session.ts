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
  DVDNAV_SPU_STREAM_CHANGE,
  DVDNAV_AUDIO_STREAM_CHANGE,
  DVDNAV_HIGHLIGHT,
  DVDNAV_SPU_CLUT_CHANGE,
  type DiscStructure,
  type ButtonInfo,
} from "./dvdnav";

const API_BASE = "http://localhost:3000";

export interface PlaybackTarget {
  vts: number;
  title: number;
  part: number;
  seekTimeMs?: number;
}

export type SessionState = "idle" | "loading" | "playing" | "menu" | "stopped";

export interface MenuState {
  buttons: ButtonInfo[];
  currentButton: number;
  clut: number[];
}

export class SessionManager {
  private session: DvdSession;
  private video: HTMLVideoElement;
  private structure: DiscStructure;
  private currentVts = 0;
  private currentTitle = 0;
  private currentPart = 0;
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

  private setMenu(menu: MenuState | null) {
    this._menuState = menu;
    this.onMenuChange?.(menu);
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

    const target = await this.driveVM();
    if (target) {
      this.playTarget(target);
    } else if (this._state === "menu") {
      // driveVM entered a menu — load menu background video
      this.loadMenuVideo();
    } else {
      this.log("VM reached STOP without a playback target");
      this.setState("stopped");
    }
  }

  /** Select a title through the VM */
  async selectTitle(title: number): Promise<void> {
    this.setState("loading");
    this.log(`Selecting title ${title}...`);
    this.session.titlePlay(title);
    const target = await this.driveVM();
    if (target) {
      this.playTarget(target);
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
    const target = await this.driveVM();
    if (target) {
      this.playTarget(target);
    }
  }

  /* --- Menu interaction (M3) --- */

  menuNavigate(direction: "up" | "down" | "left" | "right"): void {
    if (this._state !== "menu") return;
    this.session.buttonSelect(direction);
    this.updateMenuHighlight();
  }

  async menuActivate(): Promise<void> {
    if (this._state !== "menu") return;
    this.log("Menu: activating button");
    this.session.buttonActivate();
    this.setMenu(null);
    this.setState("loading");
    const target = await this.driveVM();
    if (target) {
      this.playTarget(target);
    } else if (this._state === "menu") {
      this.loadMenuVideo();
    }
  }

  async menuClick(dvdX: number, dvdY: number): Promise<void> {
    if (this._state !== "menu") return;
    this.log(`Menu: click at (${dvdX}, ${dvdY})`);
    this.session.mouseActivate(dvdX, dvdY);
    this.setMenu(null);
    this.setState("loading");
    const target = await this.driveVM();
    if (target) {
      this.playTarget(target);
    } else if (this._state === "menu") {
      this.loadMenuVideo();
    }
  }

  /** Return to root menu (DVD_MENU_Root = 3) */
  async returnToMenu(): Promise<void> {
    this.log("Returning to root menu...");
    this.video.pause();
    this.video.removeAttribute("src");
    this.session.menuCall(3); // DVD_MENU_Root
    this.setState("loading");
    const target = await this.driveVM();
    if (target) {
      this.playTarget(target);
    } else if (this._state === "menu") {
      this.loadMenuVideo();
    }
  }

  menuHover(dvdX: number, dvdY: number): void {
    if (this._state !== "menu") return;
    this.session.mouseSelect(dvdX, dvdY);
    this.updateMenuHighlight();
  }

  private updateMenuHighlight(): void {
    const currentButton = this.session.getCurrentButton();
    if (this._menuState && currentButton !== this._menuState.currentButton) {
      this.setMenu({ ...this._menuState, currentButton });
    }
  }

  /**
   * Load the menu background video from the VMGM (titleset=0) transcode.
   * The video shows the menu's background frame; the canvas overlay draws button highlights.
   */
  private loadMenuVideo(): void {
    const url = `${API_BASE}/api/transcode-menu/0`;
    this.log("Loading menu background video...");
    this.video.src = url;
    this.video.muted = true; // menus are silent; muted enables autoplay
    this.video.loop = false;
    this.video.load();
    // Pause on the last frame — DVD menus are infinite stills
    this.video.onended = () => {
      this.video.currentTime = Math.max(0, this.video.duration - 0.1);
      this.video.pause();
    };
    this.video.play().catch(() => {});
  }

  /**
   * Drive the VM event loop until we find a playback target, enter a menu, or reach STOP.
   * Yields to the browser event loop periodically to avoid blocking UI.
   */
  private async driveVM(): Promise<PlaybackTarget | null> {
    let clut: number[] = [];
    const MAX_ROUNDS = 100;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Yield to browser between rounds
      if (round > 0) {
        await new Promise((r) => setTimeout(r, 0));
      }

      const ev = this.session.getNextEvent();

      if (ev.error) {
        this.log(`VM error: ${ev.error}`);
        return null;
      }

      switch (ev.event) {
        case DVDNAV_CELL_CHANGE:
          this.log(
            `Cell change: title=${ev.title} part=${ev.part} cellN=${ev.cellN} ` +
              `isVts=${ev.isVts} pgcLength=${ev.pgcLengthMs}ms`,
          );
          if (ev.isVts && ev.title && ev.title > 0) {
            // We're in VTS domain with a real title — play it
            return {
              vts: this.currentVts,
              title: ev.title,
              part: ev.part ?? 1,
            };
          }
          // Menu cell or title 0 — continue driving
          continue;

        case DVDNAV_VTS_CHANGE:
          this.currentVts = ev.newVtsN ?? 0;
          this.log(
            `VTS change: ${ev.oldVtsN} → ${ev.newVtsN} (domain ${ev.oldDomain} → ${ev.newDomain})`,
          );
          continue;

        case DVDNAV_STILL_FRAME:
          if (ev.stillLength === 0xff) {
            // Infinite still — this is a menu waiting for user input
            const buttons = this.session.getButtons();
            const currentButton = this.session.getCurrentButton();
            if (buttons.length > 0) {
              this.log(
                `Menu: ${buttons.length} buttons, current=${currentButton}`,
              );
              this.setMenu({ buttons, currentButton, clut });
              this.setState("menu");
              return null; // Don't play — wait for user interaction
            }
            // No buttons — skip the still (e.g. a non-interactive still frame)
            this.log("Infinite still with no buttons — skipping");
            this.session.stillSkip();
          } else {
            this.log(`Still frame: ${ev.stillLength}s — skipping`);
            this.session.stillSkip();
          }
          continue;

        case DVDNAV_SPU_CLUT_CHANGE:
          if (ev.clut) clut = ev.clut;
          continue;

        case DVDNAV_HIGHLIGHT:
          this.log(`Highlight: button=${ev.buttonN} display=${ev.display}`);
          continue;

        case DVDNAV_STOP:
          this.log("VM reached STOP");
          this.setState("stopped");
          return null;

        case DVDNAV_HOP_CHANNEL:
          this.log("Hop channel (decoder flush)");
          continue;

        case DVDNAV_SPU_STREAM_CHANGE:
        case DVDNAV_AUDIO_STREAM_CHANGE:
          continue;

        default:
          if (ev.event < 0) {
            this.log(`VM error event: ${ev.error ?? "unknown"}`);
            return null;
          }
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

    this.log(`Playing VTS ${vts} (title ${target.title}, chapter ${target.part})`);
    this.setState("loading");

    const url = `${API_BASE}/api/transcode/${vts}`;
    this.video.src = url;
    this.video.muted = false; // unmute for title playback
    this.video.loop = false; // titles don't loop — onended resumes VM
    this.video.load();

    const onCanPlay = () => {
      this.video.removeEventListener("canplay", onCanPlay);

      if (target.seekTimeMs && target.seekTimeMs > 0) {
        this.video.currentTime = target.seekTimeMs / 1000;
      }

      this.video.play().then(() => {
        this.setState("playing");
      }).catch((err) => {
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
