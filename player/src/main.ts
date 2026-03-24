import "./style.css";
import { openDisc, type DiscStructure } from "./dvdnav";

const API_BASE = "http://localhost:3000";

interface DiscInfo {
  path: string;
  titlesets: number[];
  vob_count: number;
}

const video = document.getElementById("video") as HTMLVideoElement;
const discInfoEl = document.getElementById("disc-info")!;
const titlesetSelectEl = document.getElementById("titleset-select")!;
const discStructureEl = document.getElementById("disc-structure")!;

async function loadDiscInfo(): Promise<DiscInfo> {
  const res = await fetch(`${API_BASE}/api/disc`);
  if (!res.ok) throw new Error(`Failed to load disc info: ${res.statusText}`);
  return res.json();
}

function playTitleset(titleset: number) {
  video.src = `${API_BASE}/api/transcode/${titleset}`;
  video.load();
  video.play();

  document.querySelectorAll(".titleset-btn").forEach((btn) => {
    btn.classList.toggle(
      "active",
      btn.getAttribute("data-titleset") === String(titleset),
    );
  });
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function displayDiscStructure(structure: DiscStructure) {
  const lines: string[] = [];

  if (structure.titleString) {
    lines.push(`<strong>${structure.titleString}</strong>`);
  }
  if (structure.serialString) {
    lines.push(`Serial: ${structure.serialString}`);
  }

  const aspect = structure.videoAspect === 0 ? "4:3" : structure.videoAspect === 2 ? "16:9" : `${structure.videoAspect}`;
  lines.push(`Video: ${structure.videoWidth}x${structure.videoHeight} (${aspect})`);

  if (structure.audioStreams.length > 0) {
    const audioDesc = structure.audioStreams
      .map((a) => {
        const lang = a.lang || "??";
        return `${lang} (${a.channels}ch)`;
      })
      .join(", ");
    lines.push(`Audio: ${audioDesc}`);
  }

  if (structure.spuStreamCount > 0) {
    lines.push(`Subtitles: ${structure.spuStreamCount} stream(s)`);
  }

  lines.push("");
  for (const t of structure.titles) {
    const duration = formatDuration(t.durationMs);
    const angles = t.angles > 1 ? `, ${t.angles} angles` : "";
    lines.push(`Title ${t.title}: ${t.chapters} chapter(s), ${duration}${angles}`);
  }

  discStructureEl.innerHTML = lines.join("<br>");
}

async function init() {
  try {
    const disc = await loadDiscInfo();
    discInfoEl.textContent = `${disc.path} — ${disc.vob_count} VOB files, ${disc.titlesets.length} title set(s)`;

    titlesetSelectEl.innerHTML = "";
    for (const ts of disc.titlesets) {
      const btn = document.createElement("button");
      btn.className = "titleset-btn";
      btn.setAttribute("data-titleset", String(ts));
      btn.textContent = `Title Set ${ts}`;
      btn.addEventListener("click", () => playTitleset(ts));
      titlesetSelectEl.appendChild(btn);
    }

    // Auto-play the first titleset
    if (disc.titlesets.length > 0) {
      playTitleset(disc.titlesets[0]);
    }
  } catch (err) {
    discInfoEl.textContent = `Error: ${err}`;
  }

  // Load disc structure via WASM (in parallel with video playback)
  try {
    const structure = await openDisc();
    console.log("[dvdnav] Disc structure:", structure);
    displayDiscStructure(structure);
  } catch (err) {
    console.error("[dvdnav] Failed to open disc via WASM:", err);
    discStructureEl.textContent = `WASM: ${err}`;
  }
}

init();
