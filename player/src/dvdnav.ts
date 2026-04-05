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
  cwrap(
    name: string,
    returnType: string | null,
    argTypes: string[],
  ): (...args: unknown[]) => unknown;
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
  firstSector?: number; // VOB-absolute first sector of the cell
  lastSector?: number; // VOB-absolute last sector of the cell
  pgcLastSector?: number; // VOB-absolute last sector of the PGC's final cell
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
  vts: number; // VTS (titleset) number this title belongs to
  vtsTtn: number; // title number within the VTS
  firstSector: number; // VOB-absolute first sector of PGC's first cell
  lastSector: number; // VOB-absolute last sector of PGC's last cell
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
      const factory = await new Promise<(opts?: object) => Promise<DvdnavModule>>(
        (resolve, reject) => {
          const script = document.createElement("script");
          script.src = "/wasm/dvdnav.js";
          script.onload = () => {
            const fn = (globalThis as Record<string, unknown>)["createDvdnavModule"];
            if (typeof fn === "function") {
              resolve(fn as (opts?: object) => Promise<DvdnavModule>);
            } else {
              reject(new Error("createDvdnavModule not found on globalThis"));
            }
          };
          script.onerror = () => reject(new Error("Failed to load /wasm/dvdnav.js"));
          document.head.appendChild(script);
        },
      );
      return factory();
    })();
  }
  return modulePromise;
}

function bindFunctions(mod: DvdnavModule): DvdnavBindings {
  const w = (name: string, ret: string | null, args: string[]) => mod.cwrap(name, ret, args);
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
    getNumAudioStreams: w(
      "dvd_get_num_audio_streams",
      "number",
      [],
    ) as DvdnavBindings["getNumAudioStreams"],
    getAudioLang: w("dvd_get_audio_lang", "number", ["number"]) as DvdnavBindings["getAudioLang"],
    getAudioChannels: w("dvd_get_audio_channels", "number", [
      "number",
    ]) as DvdnavBindings["getAudioChannels"],
    getAudioFormat: w("dvd_get_audio_format", "number", [
      "number",
    ]) as DvdnavBindings["getAudioFormat"],
    getNumSpuStreams: w(
      "dvd_get_num_spu_streams",
      "number",
      [],
    ) as DvdnavBindings["getNumSpuStreams"],
    getSpuLang: w("dvd_get_spu_lang", "number", ["number"]) as DvdnavBindings["getSpuLang"],
    describeTitle: w("dvd_describe_title", "string", ["number"]) as DvdnavBindings["describeTitle"],
    /* Menu / Button (M3) */
    getCurrentButton: w(
      "dvd_get_current_button",
      "number",
      [],
    ) as DvdnavBindings["getCurrentButton"],
    getButtons: w("dvd_get_buttons", "string", []) as DvdnavBindings["getButtons"],
    buttonActivate: w("dvd_button_activate", "number", []) as DvdnavBindings["buttonActivate"],
    buttonSelectUp: w("dvd_button_select_up", "number", []) as DvdnavBindings["buttonSelectUp"],
    buttonSelectDown: w(
      "dvd_button_select_down",
      "number",
      [],
    ) as DvdnavBindings["buttonSelectDown"],
    buttonSelectLeft: w(
      "dvd_button_select_left",
      "number",
      [],
    ) as DvdnavBindings["buttonSelectLeft"],
    buttonSelectRight: w(
      "dvd_button_select_right",
      "number",
      [],
    ) as DvdnavBindings["buttonSelectRight"],
    mouseSelect: w("dvd_mouse_select", "number", [
      "number",
      "number",
    ]) as DvdnavBindings["mouseSelect"],
    mouseActivate: w("dvd_mouse_activate", "number", [
      "number",
      "number",
    ]) as DvdnavBindings["mouseActivate"],
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

/** State for VTS menu VOB loading */
export interface LoadState {
  vtsPath: string;
  mod: DvdnavModule;
  /** Per-VTS: parsed PGC cell info from IFO */
  vtsMenuPgcs: Map<number, import("./ifo-parser").PgcCells[]>;
  /** Per-VTS: sector ranges already loaded in MEMFS */
  loadedSectors: Map<number, import("./ifo-parser").CellRange[]>;
  /** Per-VTS: full VOB buffer (kept in JS for incremental updates) */
  vobBuffers: Map<number, Uint8Array>;
}

/**
 * Fetch IFO/BUP files and VMGM VOB eagerly, then background-fetch VTS menu
 * VOBs. Returns a LoadState that tracks which VTS VOBs are ready.
 */
async function loadDiscFiles(mod: DvdnavModule): Promise<LoadState> {
  const vtsPath = "/dvd/VIDEO_TS";
  mod.FS.mkdir("/dvd");
  mod.FS.mkdir(vtsPath);

  // Fetch IFO/BUP and VOB file lists + preload ifo-parser module in parallel
  const ifoParserPromise = import("./ifo-parser");
  const [ifoRes, vobRes] = await Promise.all([fetch(`/api/ifo-list`), fetch(`/api/vob-list`)]);
  if (!ifoRes.ok) throw new Error(`Failed to fetch IFO list: ${ifoRes.statusText}`);
  if (!vobRes.ok) throw new Error(`Failed to fetch VOB list: ${vobRes.statusText}`);

  const ifoFiles = (await ifoRes.json()) as string[];
  const allVobs = (await vobRes.json()) as string[];

  const fetchFile = async (name: string, endpoint: string) => {
    const resp = await fetch(`/api/${endpoint}/${name}`);
    if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.statusText}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    mod.FS.writeFile(`${vtsPath}/${name}`, buf);
  };

  // --- Phase 1 (blocking): IFOs/BUPs + VMGM VOB ---
  const vmgmVobs = allVobs.filter((name) => name.startsWith("VIDEO_TS"));
  await Promise.all([
    ...ifoFiles.map((name) => fetchFile(name, "ifo")),
    ...vmgmVobs.map((name) => fetchFile(name, "vob")),
  ]);

  // Create 0-byte placeholders for ALL VTS VOBs (menu + title).
  // libdvdread needs these files to exist or DVDOpenFile fails.
  const vmgmSet = new Set(vmgmVobs);
  if (!vmgmSet.has("VIDEO_TS.VOB")) {
    mod.FS.writeFile(`${vtsPath}/VIDEO_TS.VOB`, new Uint8Array(0));
    console.log("[dvdnav] Created empty VIDEO_TS.VOB placeholder");
  }
  for (const ifo of ifoFiles) {
    const m = ifo.match(/^(VTS_\d+)_0\.IFO$/);
    if (m) {
      mod.FS.writeFile(`${vtsPath}/${m[1]}_0.VOB`, new Uint8Array(0));
      mod.FS.writeFile(`${vtsPath}/${m[1]}_1.VOB`, new Uint8Array(0));
    }
  }

  console.log(
    `[dvdnav] Phase 1: loaded ${ifoFiles.length} IFO/BUP + ${vmgmVobs.length} VMGM VOB files`,
  );

  // --- Phase 2 (blocking): VTS menu VOB loading with per-PGC partial fetch ---
  const vtsMenuPgcs = new Map<number, import("./ifo-parser").PgcCells[]>();
  const loadedSectors = new Map<number, import("./ifo-parser").CellRange[]>();
  const vobBuffers = new Map<number, Uint8Array>();

  // ifo-parser was preloaded in parallel with Phase 1
  const { parseMenuPgcs, ENTRY_ID_ROOT_MENU } = await ifoParserPromise;

  const vtsMenuVobs = allVobs.filter((name) => name.match(/^VTS_\d+_0\.VOB$/));

  // Load all VTS menu VOBs before returning — eliminates MEMFS timing race
  // with C code that opens VOB files during dvdnav_get_next_block.
  await Promise.all(
    vtsMenuVobs.map(async (vobName) => {
      const m = vobName.match(/^VTS_(\d+)_0\.VOB$/);
      if (!m) return;
      const vtsN = parseInt(m[1], 10);
      const ifoName = `VTS_${m[1]}_0.IFO`;

      // Check VOB size via HEAD to decide full vs partial loading
      const headResp = await fetch(`/api/vob/${vobName}`, { method: "HEAD" });
      if (!headResp.ok) return;
      const totalSize = parseInt(headResp.headers.get("content-length") ?? "0", 10);

      if (totalSize > 1024 * 1024) {
        // Large VOB — try per-PGC partial loading
        const ifoResp = await fetch(`/api/ifo/${ifoName}`);
        let pgcs: import("./ifo-parser").PgcCells[] = [];
        if (ifoResp.ok) {
          pgcs = parseMenuPgcs(await ifoResp.arrayBuffer());
          vtsMenuPgcs.set(vtsN, pgcs);
        }

        const rootPgc = pgcs.find((p) => p.entryId === ENTRY_ID_ROOT_MENU) ?? pgcs[0];
        const cellRanges = rootPgc?.cells ?? [];
        const rootBytes = cellRanges.reduce(
          (sum, r) => sum + (r.lastSector - r.firstSector + 1) * 2048,
          0,
        );

        const buf = new Uint8Array(totalSize);
        vobBuffers.set(vtsN, buf);

        if (rootBytes > 0 && rootBytes < totalSize * 0.75) {
          // Fetch only root PGC cells
          const fetches = cellRanges.map(async (range) => {
            const resp = await fetch(
              `/api/vob-range/${vobName}?start=${range.firstSector}&end=${range.lastSector}`,
            );
            if (!resp.ok) return 0;
            const data = new Uint8Array(await resp.arrayBuffer());
            buf.set(data, range.firstSector * 2048);
            return data.byteLength;
          });
          const sizes = await Promise.all(fetches);
          const bytesLoaded = sizes.reduce((a, b) => a + b, 0);

          mod.FS.writeFile(`${vtsPath}/${vobName}`, buf);
          loadedSectors.set(vtsN, [...cellRanges]);

          const pct = ((bytesLoaded / totalSize) * 100).toFixed(1);
          console.log(
            `[dvdnav] Loaded ${vobName}: ${bytesLoaded} of ${totalSize} bytes (${pct}%, root PGC only)`,
          );
        } else {
          // Root covers most of VOB — download full
          const resp = await fetch(`/api/vob/${vobName}`);
          if (!resp.ok) return;
          const data = new Uint8Array(await resp.arrayBuffer());
          buf.set(data);
          mod.FS.writeFile(`${vtsPath}/${vobName}`, buf);
          const totalSectors = Math.ceil(data.byteLength / 2048);
          loadedSectors.set(vtsN, [{ firstSector: 0, lastSector: totalSectors - 1 }]);
          console.log(`[dvdnav] Loaded ${vobName} (${data.byteLength} bytes)`);
        }
      } else {
        // Small VOB — download fully
        const resp = await fetch(`/api/vob/${vobName}`);
        if (!resp.ok) return;
        const data = new Uint8Array(await resp.arrayBuffer());
        if (data.byteLength > 0) {
          mod.FS.writeFile(`${vtsPath}/${vobName}`, data);
          vobBuffers.set(vtsN, data);
          const totalSectors = Math.ceil(data.byteLength / 2048);
          loadedSectors.set(vtsN, [{ firstSector: 0, lastSector: totalSectors - 1 }]);
          console.log(`[dvdnav] Loaded ${vobName} (${data.byteLength} bytes)`);
        }
        // Parse IFO for on-demand metadata
        const ifoResp = await fetch(`/api/ifo/${ifoName}`);
        if (ifoResp.ok) {
          const pgcs = parseMenuPgcs(await ifoResp.arrayBuffer());
          vtsMenuPgcs.set(vtsN, pgcs);
        }
      }
    }),
  );

  console.log(`[dvdnav] Phase 2: loaded ${vtsMenuVobs.length} VTS menu VOBs`);

  return { vtsPath, mod, vtsMenuPgcs, loadedSectors, vobBuffers };
}

/** Raw JSON shape returned by dvd_describe_title() in the C glue */
interface RawTitleDesc {
  chapters: number;
  duration_ms: number;
  chapter_times_ms: number[];
  vts: number;
  vts_ttn: number;
  firstSector?: number;
  lastSector?: number;
}

/** Query disc structure from an open dvdnav handle */
function queryStructure(dvd: DvdnavBindings): DiscStructure {
  const numTitles = dvd.getNumTitles();
  const titles: TitleInfo[] = [];

  for (let t = 1; t <= numTitles; t++) {
    const jsonStr = dvd.describeTitle(t);
    const info = JSON.parse(jsonStr) as RawTitleDesc;
    titles.push({
      title: t,
      chapters: info.chapters,
      angles: dvd.getNumAngles(t),
      durationMs: info.duration_ms,
      chapterTimesMs: info.chapter_times_ms,
      vts: info.vts,
      vtsTtn: info.vts_ttn,
      firstSector: info.firstSector ?? 0,
      lastSector: info.lastSector ?? 0,
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
  private loadState: LoadState | null = null;
  constructor(_mod: DvdnavModule, dvd: DvdnavBindings, discPath: string, loadState?: LoadState) {
    this.dvd = dvd;
    this.discPath = discPath;
    this.loadState = loadState ?? null;
  }

  /**
   * Ensure a menu cell's sectors are loaded in MEMFS.
   * If the cell's sector range is already loaded, returns immediately.
   * Otherwise fetches from the server and patches the VOB buffer.
   */
  async ensureMenuCellLoaded(
    vtsN: number,
    firstSector: number,
    lastSector: number,
  ): Promise<boolean> {
    if (!this.loadState) return false;
    if (vtsN <= 0) return false;

    const { isSectorRangeLoaded, mergeRanges } = await import("./ifo-parser");

    const loaded = this.loadState.loadedSectors.get(vtsN) ?? [];
    if (isSectorRangeLoaded(firstSector, lastSector, loaded)) {
      return false; // already loaded
    }

    const vobName = `VTS_${String(vtsN).padStart(2, "0")}_0.VOB`;
    console.log(`[dvdnav] On-demand loading sectors ${firstSector}-${lastSector} from ${vobName}`);

    const resp = await fetch(`/api/vob-range/${vobName}?start=${firstSector}&end=${lastSector}`);
    if (!resp.ok) {
      console.warn(`[dvdnav] Failed to fetch sectors: ${resp.statusText}`);
      return false;
    }

    const data = new Uint8Array(await resp.arrayBuffer());
    const buf = this.loadState.vobBuffers.get(vtsN);
    if (buf) {
      const byteOffset = firstSector * 2048;
      buf.set(data, byteOffset);
      this.loadState.mod.FS.writeFile(`${this.loadState.vtsPath}/${vobName}`, buf);
    }

    // Track the newly loaded range
    loaded.push({ firstSector, lastSector });
    this.loadState.loadedSectors.set(vtsN, mergeRanges(loaded));

    console.log(
      `[dvdnav] Loaded ${data.byteLength} bytes for sectors ${firstSector}-${lastSector}`,
    );
    return true;
  }

  getNextEvent(): NavEvent {
    const json = this.dvd.getNextEvent();
    const raw = JSON.parse(json) as NavEvent & { isVts?: number | boolean };
    const ev: NavEvent = { event: raw.event };
    if (raw.error) ev.error = raw.error;
    if (raw.cellN !== undefined) ev.cellN = raw.cellN;
    if (raw.pgN !== undefined) ev.pgN = raw.pgN;
    if (raw.pgcLengthMs !== undefined) ev.pgcLengthMs = raw.pgcLengthMs;
    if (raw.cellStartSectors !== undefined) ev.cellStartSectors = raw.cellStartSectors;
    if (raw.firstSector !== undefined) ev.firstSector = raw.firstSector;
    if (raw.lastSector !== undefined) ev.lastSector = raw.lastSector;
    if (raw.pgcLastSector !== undefined) ev.pgcLastSector = raw.pgcLastSector;
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
    return JSON.parse(this.dvd.getButtons()) as ButtonInfo[];
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
  const loadState = await loadDiscFiles(mod);

  const rc = dvd.open(loadState.vtsPath);
  if (rc !== 0) {
    throw new Error(`dvdnav_open failed: ${dvd.error()}`);
  }

  return new DvdSession(mod, dvd, loadState.vtsPath, loadState);
}

/** One-shot convenience: load WASM, fetch IFOs, open disc, return structure */
export async function openDisc(): Promise<DiscStructure> {
  const session = await initSession();
  return session.getDiscStructure();
}
