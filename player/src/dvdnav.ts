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
  /** Resolve a path to its FS node (MEMFS node exposes usedBytes). */
  lookupPath(path: string): { node: { usedBytes: number } };
}

interface DvdnavModule {
  cwrap(
    name: string,
    returnType: string | null,
    argTypes: string[],
    opts?: { async?: boolean },
  ): (...args: unknown[]) => unknown;
  FS: EmscriptenFS;
  /**
   * On-demand VOB block fetch, registered by loadDiscFiles and invoked from
   * C (EM_ASYNC_JS dvdread_fetch_blocks) whenever libdvdread reads a *.VOB.
   * `path` is the MEMFS path; returns up to `count` 2048-byte blocks starting
   * at `startBlock`.
   */
  onVobRead?: (path: string, startBlock: number, count: number) => Promise<Uint8Array>;
}

interface DvdnavBindings {
  open: (path: string) => number;
  close: () => void;
  error: () => string;
  titlePlay: (title: number) => number;
  partPlay: (title: number, part: number) => number;
  stillSkip: () => number;
  waitSkip: () => number;
  /** Async: drives libdvdnav, which fetches VOB blocks on demand (Asyncify). */
  getNextEvent: () => Promise<string>;
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
  getButtonColors: () => string;
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
  /** Button color group (0–3), indexes into PCI btn_colit */
  btnColn: number;
}

/**
 * Button color table from PCI. 3 color groups × 2 states (select, action).
 * Each uint32 encodes [Ci3:4, Ci2:4, Ci1:4, Ci0:4, A3:4, A2:4, A1:4, A0:4].
 */
export type ButtonColorTable = [[number, number], [number, number], [number, number]];

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
    getNextEvent: mod.cwrap("dvd_get_next_event", "string", [], {
      async: true,
    }) as DvdnavBindings["getNextEvent"],
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
    getButtonColors: w("dvd_get_button_colors", "string", []) as DvdnavBindings["getButtonColors"],
  };
}

/** Convert a 16-bit ISO 639 language code to a 2-char string */
function langCodeToString(code: number): string {
  if (code === 0 || code === 0xffff) return "";
  return String.fromCharCode((code >> 8) & 0xff, code & 0xff);
}

/**
 * Bounds identifying a "dispatcher stub" title PGC: no real content, just a
 * jump pad whose post-commands pick the actual destination. Both the load-time
 * scan (openTitleWindow) and the runtime check (traverseDispatcherStub) use
 * these, so they must agree on what counts as a stub.
 */
export const STUB_MAX_MS = 1000;
export const STUB_MAX_SECTORS = 512;

/** State for VTS menu VOB loading */
export interface LoadState {
  vtsPath: string;
  mod: DvdnavModule;
  /** Disc slug for API calls */
  slug: string;
  /** Per-VTS: parsed PGC cell info from IFO */
  vtsMenuPgcs: Map<number, import("./ifo-parser").PgcCells[]>;
  /**
   * Fetch a sector range of a VOB from the server, with caching. Backs both
   * the VM's on-demand reads (via mod.onVobRead) and SPU demuxing (via
   * getMenuVobData), so blocks the VM already pulled are reused for free.
   */
  fetchVob: (vobName: string, startBlock: number, count: number) => Promise<Uint8Array>;
  /**
   * Make a title-VOB sector range readable by the VM. Title VOBs are normally
   * 0-byte placeholders (see loadDiscFiles) so the VM hits EOF and skips them;
   * opening a window gives the covering VOB parts their real size and serves
   * those sectors from the server, letting the VM actually play through the
   * cell and run its post-commands. Returns false if the range maps to no
   * known VOB part. Sectors are titleset-relative (as in IFO cell_playback).
   */
  openTitleWindow: (vts: number, firstSector: number, lastSector: number) => boolean;
}

/**
 * Fetch IFO/BUP files and VMGM VOB eagerly, then background-fetch VTS menu
 * VOBs. Returns a LoadState that tracks which VTS VOBs are ready.
 */
async function loadDiscFiles(mod: DvdnavModule, slug: string): Promise<LoadState> {
  const apiBase = `/api/disc/${encodeURIComponent(slug)}`;
  /** Fetch from the disc API — all disc fetches must go through this. */
  const discFetch = (path: string, init?: RequestInit) => fetch(`${apiBase}${path}`, init);

  const vtsPath = "/dvd/VIDEO_TS";
  mod.FS.mkdir("/dvd");
  mod.FS.mkdir(vtsPath);

  // Fetch IFO/BUP and VOB file lists + preload ifo-parser module in parallel
  const ifoParserPromise = import("./ifo-parser");
  const [ifoRes, vobRes] = await Promise.all([discFetch("/ifo-list"), discFetch("/vob-list")]);
  if (!ifoRes.ok) throw new Error(`Failed to fetch IFO list: ${ifoRes.statusText}`);
  if (!vobRes.ok) throw new Error(`Failed to fetch VOB list: ${vobRes.statusText}`);

  const ifoFiles = (await ifoRes.json()) as string[];
  const allVobs = (await vobRes.json()) as string[];

  const fetchFile = async (name: string, endpoint: string) => {
    const resp = await discFetch(`/${endpoint}/${name}`);
    if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.statusText}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    mod.FS.writeFile(`${vtsPath}/${name}`, buf);
  };

  // Preload all IFO/BUP files into MEMFS — small, and libdvdread/libdvdnav
  // read them synchronously during open and navigation.
  await Promise.all(ifoFiles.map((name) => fetchFile(name, "ifo")));

  // --- On-demand VOB backing ---------------------------------------------
  // VOBs are NOT preloaded. Each gets a 0-byte MEMFS placeholder whose
  // reported size (node.usedBytes) matches the real file, so libdvdread
  // computes the correct block count from stat() without us allocating the
  // bytes. Blocks are fetched from the server only when the VM reads them
  // (see mod.onVobRead below, driven from dvd_input.c).
  const sizes = await Promise.all(
    allVobs.map(async (name) => {
      const r = await discFetch(`/vob-size/${name}`);
      const size = r.ok ? (((await r.json()) as { size: number }).size ?? 0) : 0;
      return [name, size] as const;
    }),
  );
  // Only MENU VOBs (VIDEO_TS.VOB, VTS_nn_0.VOB) are routinely read by the VM,
  // served from their preloaded NAV maps below. Title VOBs (VTS_nn_1.VOB …)
  // read as empty: their video is delivered by the server transcoder, never the
  // VM, and empty reads make the VM give up on auto-play intro titles (e.g.
  // studio-logo animations the First Play PGC jumps to) instead of streaming
  // all of them block-by-block. The one exception is a dispatcher-stub cell the
  // VM must actually play through to reach its post-commands — see
  // openTitleWindow, which makes exactly those sectors readable.
  const isMenuVob = (name: string) => name === "VIDEO_TS.VOB" || /^VTS_\d+_0\.VOB$/.test(name);

  /**
   * Title VOB parts per VTS, in playback order with their titleset-relative
   * sector spans. libdvdread presents VTS_nn_1..9.VOB as one logical stream and
   * IFO cell sectors index into that concatenation, so mapping a cell's sector
   * range back to a file + file-relative block needs these running offsets.
   */
  interface TitleVobPart {
    name: string;
    path: string;
    size: number;
    startSector: number;
    endSector: number;
  }
  const titleVobsByVts = new Map<number, TitleVobPart[]>();
  for (const [name, size] of [...sizes].sort(([a], [b]) => a.localeCompare(b))) {
    const m = name.match(/^VTS_(\d+)_(\d+)\.VOB$/);
    if (!m || m[2] === "0") continue; // _0 is the menu VOB, not part of the title stream
    const vts = parseInt(m[1], 10);
    const parts = titleVobsByVts.get(vts) ?? [];
    const startSector = parts.length > 0 ? parts[parts.length - 1].endSector + 1 : 0;
    parts.push({
      name,
      path: `${vtsPath}/${name}`,
      size,
      startSector,
      endSector: startSector + Math.floor(size / 2048) - 1,
    });
    titleVobsByVts.set(vts, parts);
  }

  /** Title VOB parts currently readable, keyed by file name → sector window. */
  const titleWindows = new Map<string, { first: number; last: number; part: TitleVobPart }>();

  const openTitleWindow = (vts: number, firstSector: number, lastSector: number): boolean => {
    const parts = titleVobsByVts.get(vts);
    if (!parts) return false;
    let opened = false;
    for (const part of parts) {
      if (part.endSector < firstSector || part.startSector > lastSector) continue;
      titleWindows.set(part.name, {
        first: Math.max(firstSector, part.startSector),
        last: Math.min(lastSector, part.endSector),
        part,
      });
      // Give just this part its real size. libdvdread caches a file's size when
      // it opens it, so this only takes effect if it happens before the VM
      // first enters the title domain — hence the load-time scan below rather
      // than opening windows reactively. Every other title VOB keeps size 0 and
      // still reads as EOF, so intro titles are skipped exactly as before.
      mod.FS.lookupPath(part.path).node.usedBytes = part.size;
      opened = true;
    }
    return opened;
  };

  for (const [name, size] of sizes) {
    const p = `${vtsPath}/${name}`;
    mod.FS.writeFile(p, new Uint8Array(0));
    // MEMFS getattr returns node.usedBytes as st_size, so this makes stat()
    // report the real size with no allocation. VOB content never flows
    // through MEMFS reads (intercepted in dvd_input.c), so empty contents are
    // harmless.
    if (isMenuVob(name)) {
      mod.FS.lookupPath(p).node.usedBytes = size;
    }
  }

  const EMPTY = new Uint8Array(0);

  // Preload NAV packs for each menu VOB. The server walks the VOB and returns
  // ONLY the NAV packs (a few hundred KB) as [u32 LE sector][2048 bytes]
  // records, instead of the hundreds of MB of menu video. The VM reads its
  // navigation data from these — reconstructed as a sparse VOB (NAV packs at
  // their sectors, zeros elsewhere) — at memory speed, so even a long animated
  // menu reaches its interactive point instantly. The VM never needs the video
  // (the transcoder serves that), so zeros for non-NAV sectors are fine.
  const navMaps = new Map<string, Map<number, Uint8Array>>();
  const parseNavStream = (buf: Uint8Array): Map<number, Uint8Array> => {
    const map = new Map<number, Uint8Array>();
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let pos = 0; pos + 2052 <= buf.length; pos += 2052) {
      map.set(dv.getUint32(pos, true), buf.subarray(pos + 4, pos + 4 + 2048));
    }
    return map;
  };
  await Promise.all(
    allVobs.filter(isMenuVob).map(async (name) => {
      const resp = await discFetch(`/menu-nav/${name}`);
      if (resp.ok) navMaps.set(name, parseNavStream(new Uint8Array(await resp.arrayBuffer())));
    }),
  );

  // C → JS bridge (dvd_input.c). Serve menu-VOB reads from the preloaded NAV
  // map — NAV pack where one exists, zeros elsewhere — with no network during
  // navigation. Title VOBs report empty (EOF) so the VM skips intro titles
  // instead of streaming them.
  mod.onVobRead = async (path: string, startBlock: number, count: number) => {
    const name = path.slice(path.lastIndexOf("/") + 1);

    // Title VOB inside an open window (see openTitleWindow): serve the real
    // bytes so the VM can play through the cell. `startBlock` is file-relative;
    // the window is in titleset-relative sectors.
    const win = titleWindows.get(name);
    if (win) {
      const from = win.part.startSector + startBlock;
      const to = from + count - 1;
      if (to < win.first || from > win.last) return EMPTY;
      const clampedFrom = Math.max(from, win.first);
      const clampedTo = Math.min(to, win.last);
      const data = await fetchVob(
        name,
        clampedFrom - win.part.startSector,
        clampedTo - clampedFrom + 1,
      );
      if (data.length === 0) return EMPTY;
      if (clampedFrom === from && data.length === count * 2048) return data;
      const out = new Uint8Array(count * 2048);
      out.set(
        data.subarray(0, Math.min(data.length, out.length - (clampedFrom - from) * 2048)),
        (clampedFrom - from) * 2048,
      );
      return out;
    }

    const navMap = navMaps.get(name);
    if (!navMap) return EMPTY;
    const out = new Uint8Array(count * 2048);
    for (let i = 0; i < count; i++) {
      const nav = navMap.get(startBlock + i);
      if (nav) out.set(nav, i * 2048);
    }
    return out;
  };

  // Real VOB bytes for SPU demux (getMenuVobData) — fetched on demand with a
  // small LRU cache. The NAV-only maps above carry no subpicture data, so the
  // button-highlight overlay reads real sectors from here.
  const blockCache = new Map<string, Uint8Array>();
  const CACHE_CAP = 256;
  const fetchVob = async (
    vobName: string,
    startBlock: number,
    count: number,
  ): Promise<Uint8Array> => {
    if (count <= 0) return EMPTY;
    const key = `${vobName}:${startBlock}:${count}`;
    const hit = blockCache.get(key);
    if (hit) {
      blockCache.delete(key);
      blockCache.set(key, hit); // refresh LRU position
      return hit;
    }
    const end = startBlock + count - 1;
    const resp = await discFetch(`/vob-range/${vobName}?start=${startBlock}&end=${end}`);
    if (!resp.ok) return EMPTY;
    const data = new Uint8Array(await resp.arrayBuffer());
    if (blockCache.size >= CACHE_CAP) {
      const oldest = blockCache.keys().next().value;
      if (oldest !== undefined) blockCache.delete(oldest);
    }
    blockCache.set(key, data);
    return data;
  };

  // Parse menu PGC cell info from each VTS IFO (menu cell sector ranges for
  // SPU demux + cell timings). IFOs are already in MEMFS; the refetch is a
  // browser-cache hit thanks to the immutable Cache-Control header.
  const { parseMenuPgcs, parseTitlePgcs } = await ifoParserPromise;
  const vtsMenuPgcs = new Map<number, import("./ifo-parser").PgcCells[]>();
  await Promise.all(
    ifoFiles.map(async (ifo) => {
      const m = ifo.match(/^VTS_(\d+)_0\.IFO$/);
      if (!m) return;
      const resp = await discFetch(`/ifo/${ifo}`);
      if (!resp.ok) return;
      const vts = parseInt(m[1], 10);
      const buf = await resp.arrayBuffer();
      vtsMenuPgcs.set(vts, parseMenuPgcs(buf));

      // Open a read window over every dispatcher-stub title PGC — a degenerate
      // PGC (a fraction of a second over a handful of sectors) that exists only
      // to run a post-command chain selecting the real destination. The VM has
      // to play through one to reach those commands, and this must be set up
      // before the disc is opened, so scan for them here rather than waiting
      // for the VM to report the cell. Stubs are a few dozen sectors, so this
      // is effectively free. See SessionManager.traverseDispatcherStub.
      for (const pgc of parseTitlePgcs(buf)) {
        const sectors = pgc.lastSector - pgc.firstSector + 1;
        if (pgc.durationMs > STUB_MAX_MS) continue;
        if (sectors <= 0 || sectors > STUB_MAX_SECTORS) continue;
        openTitleWindow(vts, pgc.firstSector, pgc.lastSector);
      }
    }),
  );

  return { vtsPath, mod, slug, vtsMenuPgcs, fetchVob, openTitleWindow };
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
  public readonly slug: string;
  constructor(
    _mod: DvdnavModule,
    dvd: DvdnavBindings,
    discPath: string,
    slug: string,
    loadState?: LoadState,
  ) {
    this.dvd = dvd;
    this.discPath = discPath;
    this.slug = slug;
    this.loadState = loadState ?? null;
  }

  /**
   * Previously pre-fetched a menu cell's sectors into MEMFS. Now a no-op:
   * the VM fetches VOB blocks on demand as it reads them (dvd_input.c →
   * mod.onVobRead), so there's nothing to pre-load. Kept so callers in the
   * driveVM loop don't need restructuring; always reports "nothing newly
   * loaded".
   */
  ensureMenuCellLoaded(_vtsN: number, _firstSector: number, _lastSector: number): Promise<boolean> {
    return Promise.resolve(false);
  }

  async getNextEvent(): Promise<NavEvent> {
    const json = await this.dvd.getNextEvent();
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

  /** Get button color table from current PCI (3 groups × 2 states) */
  getButtonColors(): ButtonColorTable {
    return JSON.parse(this.dvd.getButtonColors()) as ButtonColorTable;
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

  /**
   * Get raw VOB data for a menu cell's sector range (for SPU demuxing).
   * Fetches the range on demand via the shared cache — blocks the VM already
   * pulled while navigating into this menu cell are served from cache.
   * Returns null if unavailable.
   */
  async getMenuVobData(
    vtsN: number,
    firstSector: number,
    lastSector: number,
  ): Promise<Uint8Array | null> {
    if (!this.loadState) return null;
    // VTS 0 = VMGM (VIDEO_TS.VOB), VTS > 0 = VTS menu VOBs
    const vobName = vtsN === 0 ? "VIDEO_TS.VOB" : `VTS_${String(vtsN).padStart(2, "0")}_0.VOB`;
    const count = lastSector - firstSector + 1;
    const data = await this.loadState.fetchVob(vobName, firstSector, count);
    return data.length > 0 ? data : null;
  }

  /**
   * Get the raw (unmerged) cell ranges for all menu PGCs in a VTS.
   * Each cell has firstSector, lastSector, and durationMs from the IFO.
   * Returns null if IFO data isn't available for this VTS.
   */
  getMenuCellTimings(vtsN: number): import("./ifo-parser").CellRange[] | null {
    if (!this.loadState) return null;
    const pgcs = this.loadState.vtsMenuPgcs.get(vtsN);
    if (!pgcs) return null;
    return pgcs.flatMap((p) => p.rawCells);
  }

  /**
   * Let the VM read through a short title cell (see LoadState.openTitleWindow)
   * so its post-commands run. Used for dispatcher-stub PGCs, which exist only
   * to jump somewhere else and have no video worth transcoding.
   */
  openTitleWindow(vtsN: number, firstSector: number, lastSector: number): boolean {
    return this.loadState?.openTitleWindow(vtsN, firstSector, lastSector) ?? false;
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
export async function initSession(slug: string): Promise<DvdSession> {
  // Reset module so each session gets a fresh WASM instance + clean MEMFS
  modulePromise = null;
  const mod = await getModule();
  const dvd = bindFunctions(mod);
  const loadState = await loadDiscFiles(mod, slug);

  const rc = dvd.open(loadState.vtsPath);
  if (rc !== 0) {
    throw new Error(`dvdnav_open failed: ${dvd.error()}`);
  }

  return new DvdSession(mod, dvd, loadState.vtsPath, slug, loadState);
}

/** One-shot convenience: load WASM, fetch IFOs, open disc, return structure */
export async function openDisc(slug: string): Promise<DiscStructure> {
  const session = await initSession(slug);
  return session.getDiscStructure();
}
