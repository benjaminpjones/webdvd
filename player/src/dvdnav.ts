/**
 * dvdnav.ts — TypeScript wrapper for the libdvdnav WASM module.
 *
 * Provides DvdSession for long-lived VM-driven navigation (M2+)
 * and openDisc() for one-shot structure queries (backward compat).
 */

const API_BASE = "http://localhost:3000";

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
}

/* --- Public types --- */

export interface NavEvent {
  event: number;
  /* CELL_CHANGE fields */
  cellN?: number;
  pgN?: number;
  pgcLengthMs?: number;
  cellStartMs?: number;
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
  /* Error */
  error?: string;
}

export interface TitleInfo {
  title: number;
  chapters: number;
  angles: number;
  durationMs: number;
  chapterTimesMs: number[];
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
    fetch(`${API_BASE}/api/ifo-list`),
    fetch(`${API_BASE}/api/vob-list`),
  ]);
  if (!ifoRes.ok) throw new Error(`Failed to fetch IFO list: ${ifoRes.statusText}`);
  if (!vobRes.ok) throw new Error(`Failed to fetch VOB list: ${vobRes.statusText}`);

  const ifoFiles: string[] = await ifoRes.json();
  const vobFiles: string[] = await vobRes.json();

  // Fetch all files into MEMFS in parallel
  const fetchFile = async (name: string, endpoint: string) => {
    const resp = await fetch(`${API_BASE}/api/${endpoint}/${name}`);
    if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.statusText}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    mod.FS.writeFile(`${vtsPath}/${name}`, buf);
  };

  await Promise.all([
    ...ifoFiles.map((name) => fetchFile(name, "ifo")),
    ...vobFiles.map((name) => fetchFile(name, "vob")),
  ]);

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
  private _structure: DiscStructure | null = null;

  constructor(_mod: DvdnavModule, dvd: DvdnavBindings) {
    this.dvd = dvd;
  }

  getNextEvent(): NavEvent {
    const json = this.dvd.getNextEvent();
    const raw = JSON.parse(json);
    const ev: NavEvent = { event: raw.event };
    if (raw.error) ev.error = raw.error;
    if (raw.cellN !== undefined) ev.cellN = raw.cellN;
    if (raw.pgN !== undefined) ev.pgN = raw.pgN;
    if (raw.pgcLengthMs !== undefined) ev.pgcLengthMs = raw.pgcLengthMs;
    if (raw.cellStartMs !== undefined) ev.cellStartMs = raw.cellStartMs;
    if (raw.title !== undefined) ev.title = raw.title;
    if (raw.part !== undefined) ev.part = raw.part;
    if (raw.isVts !== undefined) ev.isVts = !!raw.isVts;
    if (raw.oldVtsN !== undefined) ev.oldVtsN = raw.oldVtsN;
    if (raw.newVtsN !== undefined) ev.newVtsN = raw.newVtsN;
    if (raw.oldDomain !== undefined) ev.oldDomain = raw.oldDomain;
    if (raw.newDomain !== undefined) ev.newDomain = raw.newDomain;
    if (raw.stillLength !== undefined) ev.stillLength = raw.stillLength;
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

  getDiscStructure(): DiscStructure {
    if (!this._structure) {
      this._structure = queryStructure(this.dvd);
    }
    return this._structure;
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

  return new DvdSession(mod, dvd);
}

/** One-shot convenience: load WASM, fetch IFOs, open disc, return structure */
export async function openDisc(): Promise<DiscStructure> {
  const session = await initSession();
  return session.getDiscStructure();
}
