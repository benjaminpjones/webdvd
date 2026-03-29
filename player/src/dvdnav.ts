/**
 * dvdnav.ts — TypeScript wrapper for the libdvdnav WASM module.
 *
 * Provides DvdSession for long-lived VM-driven navigation (M2+)
 * and openDisc() for one-shot structure queries (backward compat).
 */

/* --- Event constants (match dvdnav_events.h) --- */

export const DVDNAV_BLOCK_OK = 0;
export const DVDNAV_NOP = 1;
export const DVDNAV_STILL_FRAME = 2;
export const DVDNAV_SPU_STREAM_CHANGE = 3;
export const DVDNAV_AUDIO_STREAM_CHANGE = 4;
export const DVDNAV_VTS_CHANGE = 5;
export const DVDNAV_CELL_CHANGE = 6;
export const DVDNAV_NAV_PACKET = 7;
export const DVDNAV_STOP = 8;
export const DVDNAV_HIGHLIGHT = 9;
export const DVDNAV_SPU_CLUT_CHANGE = 10;
export const DVDNAV_HOP_CHANNEL = 12;
export const DVDNAV_WAIT = 13;

/* --- Emscripten types --- */

interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
}

interface DvdnavModule {
  cwrap(name: string, returnType: string | null, argTypes: string[]): Function;
  FS: EmscriptenFS;
}

interface DvdnavBindings {
  open: (path: string) => number;
  close: () => void;
  error: () => string;
  titlePlay: (title: number) => number;
  partPlay: (title: number, part: number) => number;
  stillSkip: () => number;
  waitSkip: () => number;
  getNextEvent: () => string;
  getCurrentTitle: () => number;
  getCurrentPart: () => number;
  isDomainVts: () => number;
  isDomainMenu: () => number;
  getNumTitles: () => number;
  getNumParts: (title: number) => number;
  getNumAngles: (title: number) => number;
  getTitleString: () => string;
  getSerialString: () => string;
  getVideoAspect: () => number;
  getVideoWidth: () => number;
  getVideoHeight: () => number;
  getNumAudioStreams: () => number;
  getAudioLang: (stream: number) => number;
  getAudioChannels: (stream: number) => number;
  getAudioFormat: (stream: number) => number;
  getNumSpuStreams: () => number;
  getSpuLang: (stream: number) => number;
  describeTitle: (title: number) => string;
  /* Menu / Button (M3) */
  getCurrentButton: () => number;
  getButtons: () => string;
  buttonActivate: () => number;
  buttonSelectUp: () => number;
  buttonSelectDown: () => number;
  buttonSelectLeft: () => number;
  buttonSelectRight: () => number;
  mouseSelect: (x: number, y: number) => number;
  mouseActivate: (x: number, y: number) => number;
  menuCall: (menuId: number) => number;
  goUp: () => number;
  getLastVobuPtm: () => number;
}

/* --- Public types --- */

export interface NavEvent {
  event: number;
  /* CELL_CHANGE fields */
  cellN?: number;
  pgN?: number;
  pgcLengthMs?: number;
  cellStartSectors?: number;
  firstSector?: number;  // VOB-absolute first sector of the cell
  lastSector?: number;   // VOB-absolute last sector of the cell
  title?: number;
  part?: number;
  isVts?: boolean;
  /* VTS_CHANGE fields */
  oldVtsN?: number;
  newVtsN?: number;
  oldDomain?: number;
  newDomain?: number;
  /* STILL_FRAME fields */
  stillLength?: number;
  /* NAV_PACKET fields */
  vobuStartPtm?: number;
  /* HIGHLIGHT fields */
  display?: number;
  buttonN?: number;
  /* SPU_CLUT_CHANGE fields */
  clut?: number[];
  /* Error */
  error?: string;
}

export interface ButtonInfo {
  buttonN: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  up: number;
  down: number;
  left: number;
  right: number;
  auto: number;
}

export interface TitleInfo {
  title: number;
  chapters: number;
  angles: number;
  durationMs: number;
  chapterTimesMs: number[];
  vts: number;       // VTS (titleset) number this title belongs to
  vtsTtn: number;    // title number within the VTS
}

export interface AudioStream {
  stream: number;
  lang: string;
  channels: number;
  format: number;
}

export interface DiscStructure {
  titleString: string;
  serialString: string;
  videoAspect: number;
  videoWidth: number;
  videoHeight: number;
  titles: TitleInfo[];
  audioStreams: AudioStream[];
  spuStreamCount: number;
}

/* --- Module loading --- */

let modulePromise: Promise<DvdnavModule> | null = null;

async function getModule(): Promise<DvdnavModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const factory = await new Promise<
        (opts?: object) => Promise<DvdnavModule>
      >((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/wasm/dvdnav.js";
        script.onload = () => {
          const fn = (globalThis as Record<string, unknown>)[
            "createDvdnavModule"
          ];
          if (typeof fn === "function") {
            resolve(fn as (opts?: object) => Promise<DvdnavModule>);
          } else {
            reject(new Error("createDvdnavModule not found on globalThis"));
          }
        };
        script.onerror = () =>
          reject(new Error("Failed to load /wasm/dvdnav.js"));
        document.head.appendChild(script);
      });
      return factory();
    })();
  }
  return modulePromise;
}

function bindFunctions(mod: DvdnavModule): DvdnavBindings {
  const w = (name: string, ret: string | null, args: string[]) =>
    mod.cwrap(name, ret, args);
  return {
    open: w("dvd_open", "number", ["string"]) as DvdnavBindings["open"],
    close: w("dvd_close", null, []) as DvdnavBindings["close"],
    error: w("dvd_error", "string", []) as DvdnavBindings["error"],
    titlePlay: w("dvd_title_play", "number", ["number"]) as DvdnavBindings["titlePlay"],
    partPlay: w("dvd_part_play", "number", ["number", "number"]) as DvdnavBindings["partPlay"],
    stillSkip: w("dvd_still_skip", "number", []) as DvdnavBindings["stillSkip"],
    waitSkip: w("dvd_wait_skip", "number", []) as DvdnavBindings["waitSkip"],
    getNextEvent: w("dvd_get_next_event", "string", []) as DvdnavBindings["getNextEvent"],
    getCurrentTitle: w("dvd_get_current_title", "number", []) as DvdnavBindings["getCurrentTitle"],
    getCurrentPart: w("dvd_get_current_part", "number", []) as DvdnavBindings["getCurrentPart"],
    isDomainVts: w("dvd_is_domain_vts", "number", []) as DvdnavBindings["isDomainVts"],
    isDomainMenu: w("dvd_is_domain_menu", "number", []) as DvdnavBindings["isDomainMenu"],
    getNumTitles: w("dvd_get_num_titles", "number", []) as DvdnavBindings["getNumTitles"],
    getNumParts: w("dvd_get_num_parts", "number", ["number"]) as DvdnavBindings["getNumParts"],
    getNumAngles: w("dvd_get_num_angles", "number", ["number"]) as DvdnavBindings["getNumAngles"],
    getTitleString: w("dvd_get_title_string", "string", []) as DvdnavBindings["getTitleString"],
    getSerialString: w("dvd_get_serial_string", "string", []) as DvdnavBindings["getSerialString"],
    getVideoAspect: w("dvd_get_video_aspect", "number", []) as DvdnavBindings["getVideoAspect"],
    getVideoWidth: w("dvd_get_video_width", "number", []) as DvdnavBindings["getVideoWidth"],
    getVideoHeight: w("dvd_get_video_height", "number", []) as DvdnavBindings["getVideoHeight"],
    getNumAudioStreams: w("dvd_get_num_audio_streams", "number", []) as DvdnavBindings["getNumAudioStreams"],
    getAudioLang: w("dvd_get_audio_lang", "number", ["number"]) as DvdnavBindings["getAudioLang"],
    getAudioChannels: w("dvd_get_audio_channels", "number", ["number"]) as DvdnavBindings["getAudioChannels"],
    getAudioFormat: w("dvd_get_audio_format", "number", ["number"]) as DvdnavBindings["getAudioFormat"],
    getNumSpuStreams: w("dvd_get_num_spu_streams", "number", []) as DvdnavBindings["getNumSpuStreams"],
    getSpuLang: w("dvd_get_spu_lang", "number", ["number"]) as DvdnavBindings["getSpuLang"],
    describeTitle: w("dvd_describe_title", "string", ["number"]) as DvdnavBindings["describeTitle"],
    /* Menu / Button (M3) */
    getCurrentButton: w("dvd_get_current_button", "number", []) as DvdnavBindings["getCurrentButton"],
    getButtons: w("dvd_get_buttons", "string", []) as DvdnavBindings["getButtons"],
    buttonActivate: w("dvd_button_activate", "number", []) as DvdnavBindings["buttonActivate"],
    buttonSelectUp: w("dvd_button_select_up", "number", []) as DvdnavBindings["buttonSelectUp"],
    buttonSelectDown: w("dvd_button_select_down", "number", []) as DvdnavBindings["buttonSelectDown"],
    buttonSelectLeft: w("dvd_button_select_left", "number", []) as DvdnavBindings["buttonSelectLeft"],
    buttonSelectRight: w("dvd_button_select_right", "number", []) as DvdnavBindings["buttonSelectRight"],
    mouseSelect: w("dvd_mouse_select", "number", ["number", "number"]) as DvdnavBindings["mouseSelect"],
    mouseActivate: w("dvd_mouse_activate", "number", ["number", "number"]) as DvdnavBindings["mouseActivate"],
    menuCall: w("dvd_menu_call", "number", ["number"]) as DvdnavBindings["menuCall"],
    goUp: w("dvd_go_up", "number", []) as DvdnavBindings["goUp"],
    getLastVobuPtm: w("dvd_get_last_vobu_ptm", "number", []) as DvdnavBindings["getLastVobuPtm"],
  };
}

/** Convert a 16-bit ISO 639 language code to a 2-char string */
function langCodeToString(code: number): string {
  if (code === 0 || code === 0xffff) return "";
  return String.fromCharCode((code >> 8) & 0xff, code & 0xff);
}

/** Fetch all IFO/BUP + VOB files from server and write them into Emscripten MEMFS */
async function loadDiscFiles(mod: DvdnavModule): Promise<string> {
  const vtsPath = "/dvd/VIDEO_TS";
  mod.FS.mkdir("/dvd");
  mod.FS.mkdir(vtsPath);

  // Fetch IFO/BUP and VOB file lists in parallel
  const [ifoRes, vobRes] = await Promise.all([
    fetch(`/api/ifo-list`),
    fetch(`/api/vob-list`),
  ]);
  if (!ifoRes.ok) throw new Error(`Failed to fetch IFO list: ${ifoRes.statusText}`);
  if (!vobRes.ok) throw new Error(`Failed to fetch VOB list: ${vobRes.statusText}`);

  const ifoFiles: string[] = await ifoRes.json();
  const allVobs: string[] = await vobRes.json();

  // Only load menu VOBs into MEMFS — VIDEO_TS.VOB and VTS_NN_0.VOB.
  // Title VOBs (VTS_NN_1+.VOB) are multi-GB and not needed: the VM
  // produces navigation events (CELL_CHANGE, VTS_CHANGE) from IFO data
  // before reading title VOB blocks, and the server handles transcoding.
  const vobFiles = allVobs.filter(
    (name) => name.startsWith("VIDEO_TS") || name.match(/^VTS_\d+_0\.VOB$/),
  );

  const fetchFile = async (name: string, endpoint: string) => {
    const resp = await fetch(`/api/${endpoint}/${name}`);
    if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.statusText}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    mod.FS.writeFile(`${vtsPath}/${name}`, buf);
  };

  await Promise.all([
    ...ifoFiles.map((name) => fetchFile(name, "ifo")),
    ...vobFiles.map((name) => fetchFile(name, "vob")),
  ]);

  // Create empty placeholder VOBs for any titleset that has IFOs but no
  // menu VOB. libdvdread needs these files to exist (even if 0-byte) or
  // DVDOpenFile fails when the VM transitions through that domain.
  const ifoSet = new Set(ifoFiles);
  const vobSet = new Set(vobFiles);
  // VMGM: VIDEO_TS.VOB
  if (ifoSet.has("VIDEO_TS.IFO") && !vobSet.has("VIDEO_TS.VOB")) {
    mod.FS.writeFile(`${vtsPath}/VIDEO_TS.VOB`, new Uint8Array(0));
    console.log("[dvdnav] Created empty VIDEO_TS.VOB placeholder");
  }
  // VTS menus: VTS_NN_0.VOB
  // VTS titles: VTS_NN_1.VOB (libdvdnav opens title VOBs during VTS init,
  // even when navigating to the menu domain; without a placeholder file
  // the open fails and menu navigation breaks)
  for (const ifo of ifoFiles) {
    const m = ifo.match(/^(VTS_\d+)_0\.IFO$/);
    if (m) {
      const menuVob = `${m[1]}_0.VOB`;
      if (!vobSet.has(menuVob)) {
        mod.FS.writeFile(`${vtsPath}/${menuVob}`, new Uint8Array(0));
        console.log(`[dvdnav] Created empty ${menuVob} placeholder`);
      }
      const titleVob = `${m[1]}_1.VOB`;
      if (!vobSet.has(titleVob)) {
        mod.FS.writeFile(`${vtsPath}/${titleVob}`, new Uint8Array(0));
        console.log(`[dvdnav] Created empty ${titleVob} placeholder`);
      }
    }
  }

  console.log(
    `[dvdnav] Loaded ${ifoFiles.length} IFO/BUP + ${vobFiles.length} VOB files into MEMFS`,
  );
  return vtsPath;
}

/** Query disc structure from an open dvdnav handle */
function queryStructure(dvd: DvdnavBindings): DiscStructure {
  const numTitles = dvd.getNumTitles();
  const titles: TitleInfo[] = [];

  for (let t = 1; t <= numTitles; t++) {
    const jsonStr = dvd.describeTitle(t);
    const info = JSON.parse(jsonStr);
    titles.push({
      title: t,
      chapters: info.chapters,
      angles: dvd.getNumAngles(t),
      durationMs: info.duration_ms,
      chapterTimesMs: info.chapter_times_ms,
      vts: info.vts,
      vtsTtn: info.vts_ttn,
    });
  }

  // Navigate into title 1 to start the VM — video/audio attribute
  // queries require the VM to be in a specific VTS.
  if (numTitles > 0) {
    dvd.titlePlay(1);
  }

  const numAudio = dvd.getNumAudioStreams();
  const audioStreams: AudioStream[] = [];
  for (let s = 0; s < numAudio; s++) {
    audioStreams.push({
      stream: s,
      lang: langCodeToString(dvd.getAudioLang(s)),
      channels: dvd.getAudioChannels(s),
      format: dvd.getAudioFormat(s),
    });
  }

  return {
    titleString: dvd.getTitleString(),
    serialString: dvd.getSerialString(),
    videoAspect: dvd.getVideoAspect(),
    videoWidth: dvd.getVideoWidth(),
    videoHeight: dvd.getVideoHeight(),
    titles,
    audioStreams,
    spuStreamCount: dvd.getNumSpuStreams(),
  };
}

/* --- DvdSession: long-lived VM-driven navigation --- */

export class DvdSession {
  private dvd: DvdnavBindings;
  private discPath: string;
  private _structure: DiscStructure | null = null;
  constructor(_mod: DvdnavModule, dvd: DvdnavBindings, discPath: string) {
    this.dvd = dvd;
    this.discPath = discPath;
  }

  getNextEvent(): NavEvent {
    const json = this.dvd.getNextEvent();
    const raw = JSON.parse(json);
    const ev: NavEvent = { event: raw.event };
    if (raw.error) ev.error = raw.error;
    if (raw.cellN !== undefined) ev.cellN = raw.cellN;
    if (raw.pgN !== undefined) ev.pgN = raw.pgN;
    if (raw.pgcLengthMs !== undefined) ev.pgcLengthMs = raw.pgcLengthMs;
    if (raw.cellStartSectors !== undefined) ev.cellStartSectors = raw.cellStartSectors;
    if (raw.firstSector !== undefined) ev.firstSector = raw.firstSector;
    if (raw.lastSector !== undefined) ev.lastSector = raw.lastSector;
    if (raw.title !== undefined) ev.title = raw.title;
    if (raw.part !== undefined) ev.part = raw.part;
    if (raw.isVts !== undefined) ev.isVts = !!raw.isVts;
    if (raw.oldVtsN !== undefined) ev.oldVtsN = raw.oldVtsN;
    if (raw.newVtsN !== undefined) ev.newVtsN = raw.newVtsN;
    if (raw.oldDomain !== undefined) ev.oldDomain = raw.oldDomain;
    if (raw.newDomain !== undefined) ev.newDomain = raw.newDomain;
    if (raw.stillLength !== undefined) ev.stillLength = raw.stillLength;
    if (raw.vobuStartPtm !== undefined) ev.vobuStartPtm = raw.vobuStartPtm;
    if (raw.display !== undefined) ev.display = raw.display;
    if (raw.buttonN !== undefined) ev.buttonN = raw.buttonN;
    if (raw.clut !== undefined) ev.clut = raw.clut;
    return ev;
  }

  titlePlay(title: number): void {
    if (this.dvd.titlePlay(title) !== 0) {
      throw new Error(`titlePlay(${title}) failed: ${this.dvd.error()}`);
    }
  }

  partPlay(title: number, part: number): void {
    if (this.dvd.partPlay(title, part) !== 0) {
      throw new Error(`partPlay(${title}, ${part}) failed: ${this.dvd.error()}`);
    }
  }

  stillSkip(): void {
    this.dvd.stillSkip();
  }

  waitSkip(): void {
    this.dvd.waitSkip();
  }

  getCurrentTitle(): number {
    return this.dvd.getCurrentTitle();
  }

  getCurrentPart(): number {
    return this.dvd.getCurrentPart();
  }

  isInMenu(): boolean {
    return this.dvd.isDomainMenu() === 1;
  }

  isInVts(): boolean {
    return this.dvd.isDomainVts() === 1;
  }

  /* --- Menu / Button (M3) --- */

  getCurrentButton(): number {
    return this.dvd.getCurrentButton();
  }

  getButtons(): ButtonInfo[] {
    return JSON.parse(this.dvd.getButtons());
  }

  buttonActivate(): boolean {
    return this.dvd.buttonActivate() === 0;
  }

  buttonSelect(direction: "up" | "down" | "left" | "right"): boolean {
    const fn = {
      up: this.dvd.buttonSelectUp,
      down: this.dvd.buttonSelectDown,
      left: this.dvd.buttonSelectLeft,
      right: this.dvd.buttonSelectRight,
    }[direction];
    return fn() === 0;
  }

  mouseSelect(x: number, y: number): boolean {
    return this.dvd.mouseSelect(x, y) === 0;
  }

  mouseActivate(x: number, y: number): boolean {
    return this.dvd.mouseActivate(x, y) === 0;
  }

  menuCall(menuId: number): boolean {
    return this.dvd.menuCall(menuId) === 0;
  }

  goUp(): boolean {
    return this.dvd.goUp() === 0;
  }

  /** Last NAV packet's VOBU start PTS (90kHz clock, VOB-absolute) */
  getLastVobuPtm(): number {
    return this.dvd.getLastVobuPtm();
  }

  getDiscStructure(): DiscStructure {
    if (!this._structure) {
      this._structure = queryStructure(this.dvd);
      // queryStructure calls titlePlay(1) to read video/audio attributes,
      // which moves the VM away from the First Play PGC. Reopen the disc
      // so the VM starts fresh when start() is called.
      this.dvd.close();
      this.dvd.open(this.discPath);
    }
    return this._structure;
  }

  /** Reset the VM to First Play PGC state (close + reopen) */
  reset(): void {
    this.dvd.close();
    this.dvd.open(this.discPath);
  }

  close(): void {
    this.dvd.close();
  }
}

/** Create a long-lived DvdSession — loads WASM, fetches IFOs, opens disc */
export async function initSession(): Promise<DvdSession> {
  const mod = await getModule();
  const dvd = bindFunctions(mod);
  const vtsPath = await loadDiscFiles(mod);

  const rc = dvd.open(vtsPath);
  if (rc !== 0) {
    throw new Error(`dvdnav_open failed: ${dvd.error()}`);
  }

  return new DvdSession(mod, dvd, vtsPath);
}

/** One-shot convenience: load WASM, fetch IFOs, open disc, return structure */
export async function openDisc(): Promise<DiscStructure> {
  const session = await initSession();
  return session.getDiscStructure();
}
