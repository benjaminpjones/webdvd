import "./style.css";
import { initSession, type DiscStructure } from "./dvdnav";
import { SessionManager } from "./session";

const video = document.getElementById("video") as HTMLVideoElement;
const discInfoEl = document.getElementById("disc-info")!;
const titleSelectEl = document.getElementById("title-select")!;
const discStructureEl = document.getElementById("disc-structure")!;
const statusEl = document.getElementById("status")!;

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

function buildTitleButtons(structure: DiscStructure, sm: SessionManager) {
  titleSelectEl.innerHTML = "";

  for (const t of structure.titles) {
    // Title button
    const titleBtn = document.createElement("button");
    titleBtn.className = "title-btn";
    titleBtn.setAttribute("data-title", String(t.title));
    titleBtn.textContent = `Title ${t.title} (${formatDuration(t.durationMs)})`;
    titleBtn.addEventListener("click", () => sm.selectTitle(t.title));
    titleSelectEl.appendChild(titleBtn);

    // Chapter buttons (if more than 1 chapter)
    if (t.chapters > 1) {
      const chapterDiv = document.createElement("span");
      chapterDiv.className = "chapter-buttons";
      for (let c = 1; c <= t.chapters; c++) {
        const chapBtn = document.createElement("button");
        chapBtn.className = "chapter-btn";
        chapBtn.textContent = `Ch ${c}`;
        chapBtn.addEventListener("click", () => sm.selectChapter(t.title, c));
        chapterDiv.appendChild(chapBtn);
      }
      titleSelectEl.appendChild(chapterDiv);
    }
  }
}

async function init() {
  try {
    statusEl.textContent = "Loading WASM module...";

    const session = await initSession();
    const structure = session.getDiscStructure();

    console.log("[dvdnav] Disc structure:", structure);
    displayDiscStructure(structure);
    discInfoEl.textContent = `${structure.titleString || "DVD"} — ${structure.titles.length} title(s)`;

    const sm = new SessionManager(session, video, structure, {
      onStateChange: (state) => {
        statusEl.textContent = state === "loading" ? "Loading..." :
          state === "playing" ? `Playing title ${sm.title}, chapter ${sm.part}` :
          state === "stopped" ? "Stopped" : "";
      },
      onLog: (msg) => {
        // Shown in console via SessionManager, also update status briefly
        statusEl.textContent = msg;
      },
    });

    buildTitleButtons(structure, sm);

    // Auto-play via First Play PGC
    await sm.start();
  } catch (err) {
    console.error("[init] Failed:", err);
    discInfoEl.textContent = `Error: ${err}`;
    statusEl.textContent = "";
  }
}

init();
