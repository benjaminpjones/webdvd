import "./style.css";

const API_BASE = "http://localhost:3000";

interface DiscInfo {
  path: string;
  titlesets: number[];
  vob_count: number;
}

const video = document.getElementById("video") as HTMLVideoElement;
const discInfoEl = document.getElementById("disc-info")!;
const titlesetSelectEl = document.getElementById("titleset-select")!;

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
}

init();
