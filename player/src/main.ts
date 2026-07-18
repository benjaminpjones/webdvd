import "./style.css";
import { initSession, type DiscStructure } from "./dvdnav";
import { SessionManager } from "./session";
import { MenuOverlay } from "./overlay";

/* --- Library types --- */
interface LibraryDisc {
  slug: string;
  title: string;
  visibility: "public" | "private";
}

interface LibraryResponse {
  discs: LibraryDisc[];
  auth_enabled: boolean;
  authenticated: boolean;
}

/* --- DOM refs --- */
const appEl = document.getElementById("app")!;

/* --- Library view --- */

function showLibrary(data: LibraryResponse) {
  appEl.innerHTML = "";
  appEl.className = "library-view";

  if (data.auth_enabled) {
    const authBar = document.createElement("div");
    authBar.className = "auth-bar";
    if (data.authenticated) {
      const btn = document.createElement("button");
      btn.className = "auth-btn";
      btn.textContent = "Sign out";
      btn.addEventListener("click", () => {
        void (async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          void route();
        })();
      });
      authBar.appendChild(btn);
    } else {
      const btn = document.createElement("button");
      btn.className = "auth-btn";
      btn.textContent = "Sign in";
      btn.addEventListener("click", () => showLoginModal());
      authBar.appendChild(btn);
    }
    appEl.appendChild(authBar);
  }

  const heading = document.createElement("h1");
  heading.textContent = "webdvd";
  heading.className = "library-heading";
  appEl.appendChild(heading);

  const grid = document.createElement("div");
  grid.className = "library-grid";
  appEl.appendChild(grid);

  for (const disc of data.discs) {
    const card = document.createElement("button");
    card.className = "disc-card";
    card.addEventListener("click", () => {
      location.hash = `#/disc/${encodeURIComponent(disc.slug)}`;
    });

    const thumb = document.createElement("div");
    thumb.className = "disc-thumb";
    thumb.textContent = "\uD83D\uDCBF";
    card.appendChild(thumb);

    const title = document.createElement("div");
    title.className = "disc-title";
    title.textContent = disc.title;
    card.appendChild(title);

    if (disc.visibility === "private") {
      const lock = document.createElement("div");
      lock.className = "disc-lock";
      lock.textContent = "\uD83D\uDD13"; // unlocked padlock \u2014 only shown after sign-in
      card.appendChild(lock);
    }

    grid.appendChild(card);
  }
}

function showLoginModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const modal = document.createElement("form");
  modal.className = "modal";
  modal.innerHTML = `
    <h2>Sign in</h2>
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
    <div class="modal-error" hidden></div>
    <div class="modal-buttons">
      <button type="button" class="modal-cancel">Cancel</button>
      <button type="submit" class="modal-submit">Sign in</button>
    </div>
  `;
  overlay.appendChild(modal);

  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  modal.querySelector(".modal-cancel")!.addEventListener("click", close);

  const errEl = modal.querySelector(".modal-error") as HTMLElement;
  modal.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const password = (modal.elements.namedItem("password") as HTMLInputElement).value;
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (resp.ok) {
        close();
        void route();
      } else {
        errEl.textContent = "Invalid password";
        errEl.hidden = false;
      }
    })();
  });

  document.body.appendChild(overlay);
  (modal.querySelector("input[type=password]") as HTMLInputElement).focus();
}

/* --- Player view --- */

function showPlayer(): {
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  discInfoEl: HTMLElement;
  titleSelectEl: HTMLElement;
  discStructureEl: HTMLElement;
  statusEl: HTMLElement;
  remoteEl: HTMLElement;
} {
  appEl.innerHTML = "";
  appEl.className = "";

  // Back button
  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.textContent = "\u2190 Library";
  backBtn.addEventListener("click", () => {
    location.hash = "#/";
  });
  appEl.appendChild(backBtn);

  const playerContainer = document.createElement("div");
  playerContainer.id = "player-container";
  const video = document.createElement("video");
  video.id = "video";
  video.controls = true;
  const overlay = document.createElement("canvas");
  overlay.id = "overlay";
  playerContainer.appendChild(video);
  playerContainer.appendChild(overlay);
  appEl.appendChild(playerContainer);

  const remote = document.createElement("div");
  remote.id = "remote";
  remote.innerHTML = `
    <div class="remote-nav">
      <button data-dir="up" aria-label="Up" title="Up">&#9650;</button>
      <div class="remote-row">
        <button data-dir="left" aria-label="Left" title="Left">&#9664;</button>
        <button data-action="enter" aria-label="Enter" title="Enter">OK</button>
        <button data-dir="right" aria-label="Right" title="Right">&#9654;</button>
      </div>
      <button data-dir="down" aria-label="Down" title="Down">&#9660;</button>
    </div>
    <button data-action="menu" class="remote-menu-btn" title="Return to Menu">Menu</button>
  `;
  appEl.appendChild(remote);

  const controls = document.createElement("div");
  controls.id = "controls";
  controls.innerHTML = `
    <div id="disc-info">Loading disc info...</div>
    <div id="status"></div>
    <div id="title-select"></div>
    <div id="disc-structure">Loading disc structure (WASM)...</div>
  `;
  appEl.appendChild(controls);

  return {
    video,
    overlay,
    discInfoEl: controls.querySelector("#disc-info")!,
    titleSelectEl: controls.querySelector("#title-select")!,
    discStructureEl: controls.querySelector("#disc-structure")!,
    statusEl: controls.querySelector("#status")!,
    remoteEl: remote,
  };
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function displayDiscStructure(el: HTMLElement, structure: DiscStructure) {
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

  el.innerHTML = lines.join("<br>");
}

function buildTitleButtons(el: HTMLElement, structure: DiscStructure, sm: SessionManager) {
  el.innerHTML = "";

  for (const t of structure.titles) {
    const titleBtn = document.createElement("button");
    titleBtn.className = "title-btn";
    titleBtn.setAttribute("data-title", String(t.title));
    titleBtn.textContent = `Title ${t.title} (${formatDuration(t.durationMs)})`;
    titleBtn.addEventListener("click", () => void sm.selectTitle(t.title));
    el.appendChild(titleBtn);
  }
}

function setupRemote(remoteEl: HTMLElement, sm: SessionManager) {
  for (const dir of ["up", "down", "left", "right"] as const) {
    const btn = remoteEl.querySelector(`[data-dir="${dir}"]`);
    btn?.addEventListener("click", () => sm.menuNavigate(dir));
  }

  remoteEl.querySelector("[data-action='enter']")?.addEventListener("click", () => {
    void sm.menuActivate();
  });

  remoteEl.querySelector("[data-action='menu']")?.addEventListener("click", () => {
    void sm.returnToMenu();
  });
}

function setupKeyboard(sm: SessionManager) {
  const handler = (e: KeyboardEvent) => {
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
  };
  document.addEventListener("keydown", handler);
  return handler;
}

function setupOverlayMouse(
  overlay: HTMLCanvasElement,
  menuOverlay: MenuOverlay,
  sm: SessionManager,
) {
  overlay.addEventListener("click", (e) => {
    if (sm.state !== "menu") return;
    const pt = menuOverlay.screenToDvd(e.clientX, e.clientY);
    if (pt) void sm.menuClick(pt.x, pt.y);
  });

  overlay.addEventListener("mousemove", (e) => {
    if (sm.state !== "menu") return;
    const pt = menuOverlay.screenToDvd(e.clientX, e.clientY);
    if (pt) sm.menuHover(pt.x, pt.y);
  });
}

async function openDisc(slug: string) {
  const { video, overlay, discInfoEl, titleSelectEl, discStructureEl, statusEl, remoteEl } =
    showPlayer();

  const menuOverlay = new MenuOverlay(overlay);

  try {
    statusEl.textContent = "Loading WASM module...";

    const session = await initSession(slug);
    const structure = session.getDiscStructure();

    displayDiscStructure(discStructureEl, structure);
    discInfoEl.textContent = `${structure.titleString || slug} — ${structure.titles.length} title(s)`;

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
        if (sm.state !== "menu" && sm.state !== "playing") {
          statusEl.textContent = msg;
        }
      },
    });

    buildTitleButtons(titleSelectEl, structure, sm);
    setupRemote(remoteEl, sm);
    setupKeyboard(sm);
    setupOverlayMouse(overlay, menuOverlay, sm);

    // Build time→sector maps (for full-movie seek bar + scrubbing) before
    // playback; non-blocking failure just disables seek-by-re-transcode.
    await sm.preloadTitleMaps();
    await sm.start();
  } catch (err) {
    console.error("[init] Failed:", err);
    discInfoEl.textContent = `Error: ${String(err)}`;
    statusEl.textContent = "";
  }
}

/* --- Hash router --- */
// #/              → library grid
// #/disc/:slug    → player for that disc

async function route() {
  const hash = location.hash || "#/";
  const discMatch = hash.match(/^#\/disc\/(.+)$/);

  if (discMatch) {
    const slug = decodeURIComponent(discMatch[1]);
    await openDisc(slug);
  } else {
    // Library view
    try {
      appEl.innerHTML = '<div class="loading">Loading library...</div>';
      const resp = await fetch("/api/library");
      if (!resp.ok) throw new Error(`Failed to fetch library: ${resp.statusText}`);
      const data = (await resp.json()) as LibraryResponse;
      showLibrary(data);
    } catch (err) {
      console.error("[init] Failed:", err);
      appEl.innerHTML = `<div class="loading">Error: ${String(err)}</div>`;
    }
  }
}

window.addEventListener("hashchange", () => void route());
void route();
