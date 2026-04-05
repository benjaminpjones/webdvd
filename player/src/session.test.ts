import { describe, test, expect, vi } from "vitest";
import { SessionManager, type SessionState } from "./session";
import {
  type NavEvent,
  type ButtonInfo,
  type DiscStructure,
  type DvdSession,
  DVDNAV_CELL_CHANGE,
  DVDNAV_VTS_CHANGE,
  DVDNAV_STILL_FRAME,
  DVDNAV_STOP,
  DVDNAV_HOP_CHANNEL,
  DVDNAV_WAIT,
  DVDNAV_HIGHLIGHT,
  DVDNAV_SPU_CLUT_CHANGE,
} from "./dvdnav";

/* --- Event helpers --- */

const evt = {
  vtsChange: (newVtsN: number): NavEvent => ({
    event: DVDNAV_VTS_CHANGE,
    oldVtsN: 0,
    newVtsN,
    oldDomain: 0,
    newDomain: 1,
  }),
  cellTitle: (title: number, part = 1, sector = 100): NavEvent => ({
    event: DVDNAV_CELL_CHANGE,
    isVts: true,
    title,
    part,
    cellN: 1,
    firstSector: sector,
    pgcLastSector: 999,
  }),
  cellMenu: (firstSector = 0, lastSector = 50): NavEvent => ({
    event: DVDNAV_CELL_CHANGE,
    isVts: false,
    title: 0,
    cellN: 1,
    firstSector,
    lastSector,
  }),
  still: (length = 0xff): NavEvent => ({
    event: DVDNAV_STILL_FRAME,
    stillLength: length,
  }),
  stop: (): NavEvent => ({ event: DVDNAV_STOP }),
  hop: (): NavEvent => ({ event: DVDNAV_HOP_CHANNEL }),
  highlight: (buttonN: number, display = 1): NavEvent => ({
    event: DVDNAV_HIGHLIGHT,
    buttonN,
    display,
  }),
  wait: (): NavEvent => ({ event: DVDNAV_WAIT }),
  clutChange: (clut: number[]): NavEvent => ({
    event: DVDNAV_SPU_CLUT_CHANGE,
    clut,
  }),
  vmError: (error: string): NavEvent => ({ event: -1, error }),
};

/* --- Mock factories --- */

const BUTTONS: ButtonInfo[] = [
  {
    buttonN: 1,
    x0: 0,
    y0: 0,
    x1: 100,
    y1: 50,
    up: 1,
    down: 2,
    left: 1,
    right: 2,
    auto: 0,
    btnColn: 1,
  },
  {
    buttonN: 2,
    x0: 0,
    y0: 60,
    x1: 100,
    y1: 110,
    up: 1,
    down: 2,
    left: 1,
    right: 2,
    auto: 0,
    btnColn: 1,
  },
];

const DISC: DiscStructure = {
  titleString: "TEST",
  serialString: "0000",
  videoAspect: 2,
  videoWidth: 720,
  videoHeight: 480,
  titles: [
    {
      title: 1,
      chapters: 3,
      angles: 1,
      durationMs: 60000,
      chapterTimesMs: [20000, 40000],
      vts: 1,
      vtsTtn: 1,
      firstSector: 100,
      lastSector: 999,
    },
    {
      title: 2,
      chapters: 1,
      angles: 1,
      durationMs: 30000,
      chapterTimesMs: [],
      vts: 2,
      vtsTtn: 1,
      firstSector: 200,
      lastSector: 500,
    },
  ],
  audioStreams: [],
  spuStreamCount: 0,
};

function createMockSession(events: NavEvent[]) {
  const eventQueue = [...events];
  return {
    slug: "test-disc",
    getNextEvent: vi.fn(() => eventQueue.shift() ?? evt.stop()),
    titlePlay: vi.fn(),
    partPlay: vi.fn(),
    reset: vi.fn(),
    menuCall: vi.fn(() => false),
    ensureMenuCellLoaded: vi.fn(async () => false),
    getCurrentButton: vi.fn(() => 1),
    getButtons: vi.fn((): ButtonInfo[] => []),
    buttonActivate: vi.fn(() => false),
    buttonSelect: vi.fn(() => false),
    mouseSelect: vi.fn(() => false),
    stillSkip: vi.fn(),
    waitSkip: vi.fn(),
    getButtonColors: vi.fn((): [[number, number], [number, number], [number, number]] => [
      [0, 0],
      [0, 0],
      [0, 0],
    ]),
    getMenuVobData: vi.fn(() => null),
  };
}

function createMockVideo() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    src: "",
    currentTime: 0,
    muted: false,
    loop: false,
    onended: null as (() => void) | null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(fn);
    }),
    removeEventListener: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
    }),
    _emit(event: string) {
      listeners[event]?.forEach((fn) => fn());
    },
  };
}

function createManager(
  session: ReturnType<typeof createMockSession>,
  video: ReturnType<typeof createMockVideo>,
  opts?: {
    onStateChange?: (state: SessionState) => void;
    onMenuChange?: (menu: unknown) => void;
  },
) {
  return new SessionManager(
    session as unknown as DvdSession,
    video as unknown as HTMLVideoElement,
    DISC,
    { onLog: vi.fn(), ...opts },
  );
}

/* --- Tests --- */

describe("SessionManager", () => {
  describe("start()", () => {
    test("enters menu when First Play reaches buttons via CELL_CHANGE", async () => {
      const session = createMockSession([evt.vtsChange(1), evt.cellMenu(10, 50)]);
      session.getButtons.mockReturnValue(BUTTONS);
      const video = createMockVideo();
      const onMenu = vi.fn();
      const sm = createManager(session, video, { onMenuChange: onMenu });

      await sm.start();

      expect(sm.state).toBe("menu");
      expect(onMenu).toHaveBeenCalledWith(
        expect.objectContaining({ buttons: BUTTONS, currentButton: 1 }),
      );
    });

    test("enters menu via STILL_FRAME with buttons", async () => {
      const session = createMockSession([evt.vtsChange(1), evt.still(0xff)]);
      session.getButtons.mockReturnValue(BUTTONS);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();

      expect(sm.state).toBe("menu");
    });

    test("falls back to title playback when no menu found", async () => {
      // First Play: no menu cells, just a title cell (skipped because acceptTitles=false)
      // Then STOP. menuCall fails. Reset + driveVM(true) accepts the title cell.
      const session = createMockSession([
        // First driveVM(false): title cell skipped, then STOP
        evt.vtsChange(1),
        evt.cellTitle(1),
        evt.stop(),
        // After reset + driveVM(true): accepts title
        evt.vtsChange(1),
        evt.cellTitle(1),
      ]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();

      expect(sm.state).toBe("loading");
      expect(video.src).toContain("/api/disc/test-disc/transcode/1");
    });

    test("reaches stopped state when VM produces only STOP", async () => {
      const session = createMockSession([evt.stop(), evt.stop(), evt.stop()]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();

      expect(sm.state).toBe("stopped");
    });
  });

  describe("selectTitle()", () => {
    test("navigates to title via VM", async () => {
      const session = createMockSession([evt.vtsChange(1), evt.cellTitle(1, 1, 100)]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.selectTitle(1);

      expect(session.titlePlay).toHaveBeenCalledWith(1);
      expect(video.src).toContain("/api/disc/test-disc/transcode/1");
      expect(video.src).toContain("sector=100");
    });

    test("falls back to disc structure on VM error", async () => {
      // VM error for VTS 2 (different from currentVts=0) → fallback
      const session = createMockSession([evt.vmError("Error opening vtsN=2, domain=3")]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.selectTitle(2);

      expect(video.src).toContain("/api/disc/test-disc/transcode/2");
      expect(video.src).toContain("sector=200");
    });

    test("falls back to disc structure when VM has no title VOBs", async () => {
      // VM navigates but hits STOP (empty placeholder VOBs)
      const session = createMockSession([evt.stop()]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.selectTitle(1);

      // Should fall back to direct transcode using structure
      expect(video.src).toContain("/api/disc/test-disc/transcode/1");
    });
  });

  describe("selectChapter()", () => {
    test("seeks within current title instead of re-navigating", async () => {
      // First, play title 1 to set currentTitle
      const session = createMockSession([
        evt.vtsChange(1),
        evt.cellTitle(1, 1, 100),
        // selectChapter should not call driveVM again
      ]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.selectTitle(1);
      video._emit("canplay");
      await Promise.resolve(); // let play() resolve
      // Now state should be "playing"

      await sm.selectChapter(1, 2);

      // Should seek, not re-navigate
      expect(video.currentTime).toBe(20); // 20000ms / 1000
      expect(sm.part).toBe(2);
    });
  });

  describe("menu interaction", () => {
    test("menuActivate navigates to title after button press", async () => {
      // Set up: in menu state
      const session = createMockSession([
        // start() → menu
        evt.vtsChange(1),
        evt.cellMenu(10, 50),
        // handlePostActivation driveVM(true, true):
        // postActivation=true, so awaitingTransition=true
        // VTS_CHANGE clears awaitingTransition
        evt.vtsChange(1),
        evt.cellTitle(1, 1, 100),
      ]);
      session.getButtons.mockReturnValue(BUTTONS);
      session.buttonActivate.mockReturnValue(true);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();
      expect(sm.state).toBe("menu");

      await sm.menuActivate();

      expect(session.buttonActivate).toHaveBeenCalled();
      expect(video.src).toContain("/api/disc/test-disc/transcode/1");
    });

    test("menuActivate stays in menu when activation fails", async () => {
      const session = createMockSession([evt.vtsChange(1), evt.cellMenu(10, 50)]);
      session.getButtons.mockReturnValue(BUTTONS);
      session.buttonActivate.mockReturnValue(false);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();
      expect(sm.state).toBe("menu");

      await sm.menuActivate();

      // Should still be in menu — activation failed
      expect(sm.state).toBe("menu");
    });
  });

  describe("driveVM edge cases", () => {
    test("post-activation skips stale cells until HOP + 2 cell changes", async () => {
      const session = createMockSession([
        // start() → menu
        evt.vtsChange(1),
        evt.cellMenu(10, 50),
        // handlePostActivation (postActivation=true):
        // awaitingTransition=true, menuCellsSinceHop=0
        evt.cellMenu(10, 50), // skipped: awaitingTransition=true
        evt.hop(), // clears awaitingTransition, resets menuCellsSinceHop=0
        evt.cellMenu(20, 60), // menuCellsSinceHop=1, < 2 → skipped
        evt.cellMenu(20, 60), // menuCellsSinceHop=2, ≥ 2 → menu detected
      ]);
      session.getButtons.mockReturnValue(BUTTONS);
      session.buttonActivate.mockReturnValue(true);
      const video = createMockVideo();
      const onMenu = vi.fn();
      const sm = createManager(session, video, { onMenuChange: onMenu });

      await sm.start();
      expect(sm.state).toBe("menu");

      await sm.menuActivate();

      // Should end up in menu again (navigated to new menu)
      expect(sm.state).toBe("menu");
    });

    test("STILL_FRAME without buttons calls stillSkip", async () => {
      const session = createMockSession([
        evt.still(5), // 5-second still, no buttons
        evt.stop(),
      ]);
      session.getButtons.mockReturnValue([]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();

      expect(session.stillSkip).toHaveBeenCalled();
    });

    test("WAIT event calls waitSkip", async () => {
      const session = createMockSession([evt.wait(), evt.stop()]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();

      expect(session.waitSkip).toHaveBeenCalled();
    });

    test("SPU_CLUT_CHANGE updates clut in menu state", async () => {
      const clut = [0xff0000, 0x00ff00, 0x0000ff];
      const session = createMockSession([
        evt.vtsChange(1),
        evt.clutChange(clut),
        evt.cellMenu(10, 50),
      ]);
      session.getButtons.mockReturnValue(BUTTONS);
      const video = createMockVideo();
      const onMenu = vi.fn();
      const sm = createManager(session, video, { onMenuChange: onMenu });

      await sm.start();

      expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ clut }));
    });

    test("max rounds reached returns null without crash", async () => {
      // Feed more than 500 WAIT events (each calls waitSkip and continues)
      const events: NavEvent[] = Array.from({ length: 501 }, () => evt.wait());
      const session = createMockSession(events);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();

      // Should have hit max rounds, then fallen through to the
      // fallback paths in start() without crashing
      expect(session.waitSkip).toHaveBeenCalled();
    });

    test("iteration limit error retries", async () => {
      const session = createMockSession([
        { event: -1, error: "iteration limit" },
        evt.vtsChange(1),
        evt.cellMenu(10, 50),
      ]);
      session.getButtons.mockReturnValue(BUTTONS);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.start();

      // Should have retried past the iteration limit and found the menu
      expect(sm.state).toBe("menu");
    });
  });

  describe("playTarget", () => {
    test("sets video src with sector params and transitions to playing on canplay", async () => {
      const session = createMockSession([evt.vtsChange(1), evt.cellTitle(1, 2, 150)]);
      const video = createMockVideo();
      const onState = vi.fn();
      const sm = createManager(session, video, { onStateChange: onState });

      await sm.selectTitle(1);

      expect(video.src).toContain("/api/disc/test-disc/transcode/1");
      expect(video.src).toContain("sector=150");
      expect(video.src).toContain("lastSector=999");
      expect(sm.title).toBe(1);

      // Simulate canplay
      video._emit("canplay");
      await Promise.resolve();

      expect(video.play).toHaveBeenCalled();
    });

    test("video onended resumes VM for post-commands", async () => {
      const session = createMockSession([
        // selectTitle → title playback
        evt.vtsChange(1),
        evt.cellTitle(1, 1, 100),
        // After video ends, driveVM resumes → STOP
        evt.stop(),
      ]);
      const video = createMockVideo();
      const sm = createManager(session, video);

      await sm.selectTitle(1);
      expect(video.onended).not.toBeNull();

      // Simulate video ending
      await video.onended!();

      expect(session.stillSkip).toHaveBeenCalled();
      expect(sm.state).toBe("stopped");
    });
  });
});
