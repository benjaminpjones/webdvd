import "./style.css";
import { initSession, type DiscStructure } from "./dvdnav";
import { SessionManager } from "./session";
import { MenuOverlay } from "./overlay";

const video = document.getElementById("video") as HTMLVideoElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
const discInfoEl = document.getElementById("disc-info")!;
const titleSelectEl = document.getElementById("title-select")!;
const discStructureEl = document.getElementById("disc-structure")!;
const statusEl = document.getElementById("status")!;
const remoteEl = document.getElementById("remote")!;

const menuOverlay = new MenuOverlay(overlay);

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

  const aspect =
    structure.videoAspect === 0
      ? "4:3"
      : structure.videoAspect === 2
        ? "16:9"
        : `${structure.videoAspect}`;
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
    titleBtn.addEventListener("click", () => void sm.selectTitle(t.title));
    titleSelectEl.appendChild(titleBtn);
  }
}

function setupRemote(sm: SessionManager) {
  // Arrow buttons
  for (const dir of ["up", "down", "left", "right"] as const) {
    const btn = remoteEl.querySelector(`[data-dir="${dir}"]`);
    btn?.addEventListener("click", () => sm.menuNavigate(dir));
  }

  // Enter button
  remoteEl.querySelector("[data-action='enter']")?.addEventListener("click", () => {
    void sm.menuActivate();
  });

  // Menu button (return to root menu, DVD_MENU_Root = 3)
  remoteEl.querySelector("[data-action='menu']")?.addEventListener("click", () => {
    void sm.returnToMenu();
  });
}

function setupKeyboard(sm: SessionManager) {
  document.addEventListener("keydown", (e) => {
    if (sm.state !== "menu") return;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        sm.menuNavigate("up");
        break;
      case "ArrowDown":
        e.preventDefault();
        sm.menuNavigate("down");
        break;
      case "ArrowLeft":
        e.preventDefault();
        sm.menuNavigate("left");
        break;
      case "ArrowRight":
        e.preventDefault();
        sm.menuNavigate("right");
        break;
      case "Enter":
        e.preventDefault();
        void sm.menuActivate();
        break;
    }
  });
}

function setupOverlayMouse(sm: SessionManager) {
  overlay.addEventListener("click", (e) => {
    if (sm.state !== "menu") return;
    const pt = menuOverlay.screenToDvd(e.clientX, e.clientY);
    console.log(
      `[mouse] click screen=(${e.clientX},${e.clientY}) dvd=${pt ? `(${pt.x},${pt.y})` : "null"}`,
    );
    if (pt) void sm.menuClick(pt.x, pt.y);
  });

  let hoverLog = 0;
  overlay.addEventListener("mousemove", (e) => {
    if (sm.state !== "menu") return;
    const pt = menuOverlay.screenToDvd(e.clientX, e.clientY);
    if (pt) {
      // Log every 30th hover to avoid spam
      if (hoverLog++ % 30 === 0) {
        const rect = overlay.getBoundingClientRect();
        console.log(
          `[mouse] hover screen=(${e.clientX},${e.clientY}) dvd=(${pt.x},${pt.y}) overlay=${Math.round(rect.width)}x${Math.round(rect.height)} buttons: ${sm.menuState?.buttons.map((b) => `#${b.buttonN}:(${b.x0},${b.y0})-(${b.x1},${b.y1})`).join(" ")}`,
        );
      }
      sm.menuHover(pt.x, pt.y);
    }
  });
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
        statusEl.textContent =
          state === "loading"
            ? "Loading..."
            : state === "playing"
              ? `Playing title ${sm.title}, chapter ${sm.part}`
              : state === "menu"
                ? "Menu"
                : state === "stopped"
                  ? "Stopped"
                  : "";

        // Toggle overlay interactivity in menu state
        const inMenu = state === "menu";
        overlay.style.pointerEvents = inMenu ? "auto" : "none";
        overlay.style.cursor = inMenu ? "pointer" : "default";

        if (!inMenu) menuOverlay.clear();
      },
      onMenuChange: (menu) => {
        if (menu) {
          menuOverlay.render(menu);
        } else {
          menuOverlay.clear();
        }
      },
      onLog: (msg) => {
        // Don't overwrite "Menu" / "Playing" state display with log messages
        if (sm.state !== "menu" && sm.state !== "playing") {
          statusEl.textContent = msg;
        }
      },
    });

    buildTitleButtons(structure, sm);
    setupRemote(sm);
    setupKeyboard(sm);
    setupOverlayMouse(sm);

    // Auto-play via First Play PGC
    await sm.start();
  } catch (err) {
    console.error("[init] Failed:", err);
    discInfoEl.textContent = `Error: ${String(err)}`;
    statusEl.textContent = "";
  }
}

void init();
