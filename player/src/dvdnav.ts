/**
 * dvdnav.ts — TypeScript wrapper for the libdvdnav WASM module.
 *
 * Loads the Emscripten module, fetches IFO files from the server into
 * MEMFS, opens the disc via dvdnav, and returns structured disc info.
 */

const API_BASE = "http://localhost:3000";

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

let modulePromise: Promise<DvdnavModule> | null = null;

async function getModule(): Promise<DvdnavModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // Load the Emscripten MODULARIZE factory from /public/wasm/.
      // We use a <script> tag because Vite blocks import() of JS in /public.
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

/** Fetch all IFO/BUP files from server and write them into Emscripten MEMFS */
async function loadIfoFiles(mod: DvdnavModule): Promise<string> {
  const res = await fetch(`${API_BASE}/api/ifo-list`);
  if (!res.ok) throw new Error(`Failed to fetch IFO list: ${res.statusText}`);
  const filenames: string[] = await res.json();

  const vtsPath = "/dvd/VIDEO_TS";
  mod.FS.mkdir("/dvd");
  mod.FS.mkdir(vtsPath);

  await Promise.all(
    filenames.map(async (name) => {
      const resp = await fetch(`${API_BASE}/api/ifo/${name}`);
      if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.statusText}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      mod.FS.writeFile(`${vtsPath}/${name}`, buf);
    }),
  );

  console.log(`[dvdnav] Loaded ${filenames.length} IFO/BUP files into MEMFS`);
  return vtsPath;
}

/** Load WASM, fetch IFOs, open disc, return structure */
export async function openDisc(): Promise<DiscStructure> {
  const mod = await getModule();
  const dvd = bindFunctions(mod);

  const vtsPath = await loadIfoFiles(mod);

  const rc = dvd.open(vtsPath);
  if (rc !== 0) {
    throw new Error(`dvdnav_open failed: ${dvd.error()}`);
  }

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
