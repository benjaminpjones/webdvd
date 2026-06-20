/* Petal Press — a cozy collect / dry / craft game.
 * No dependencies, no build step. Pure DOM + CSS so it deploys
 * straight to GitHub Pages as static files. */

(() => {
  "use strict";

  // ---- Palette --------------------------------------------------------
  const COLORS = {
    pink: { var: "var(--pink)", emoji: "🌸", name: "pink" },
    yellow: { var: "var(--yellow)", emoji: "🌻", name: "yellow" },
    purple: { var: "var(--purple)", emoji: "🪻", name: "purple" },
    red: { var: "var(--red)", emoji: "🌹", name: "red" },
    blue: { var: "var(--blue)", emoji: "🪻", name: "blue" },
  };
  const FLOWER_EMOJI = {
    pink: "🌸",
    yellow: "🌻",
    purple: "🌷",
    red: "🌹",
    blue: "💐",
  };

  const DRY_MS = 5000; // time for a petal to dry
  const REGROW_MS = 6000; // time for a flower to re-bloom
  const RACK_SIZE = 8; // slots on the drying board
  const GARDEN_SIZE = 9; // flowers in the garden

  // ---- State ----------------------------------------------------------
  let uid = 0;
  const state = {
    flowers: [], // {color, bloom:true|false, regrowAt}
    fresh: [], // {id, color}
    rack: new Array(RACK_SIZE).fill(null), // {id, color, dryAt} | null
    dry: [], // {id, color}
    craft: null, // {name, cols, rows, cells:[{color|null, filled}]}
    craftIndex: -1,
    stats: { crafts: 0, collected: 0, score: 0 },
  };

  // ---- Craft patterns -------------------------------------------------
  // Char map: . = empty, letters map to colours below.
  const LEGEND = { p: "pink", y: "yellow", u: "purple", r: "red", b: "blue" };
  const CRAFTS = [
    {
      name: "Heart",
      art: [
        ".pp.pp.",
        "ppppppp",
        "ppppppp",
        ".ppppp.",
        "..ppp..",
        "...p...",
      ],
    },
    {
      name: "Sunflower",
      art: [
        "..y.y..",
        ".yyyyy.",
        "yyrryyy",
        "yyrryyy",
        ".yyyyy.",
        "..y.y..",
      ],
    },
    {
      name: "Butterfly",
      art: [
        "bb.b.bb",
        "bub.bub",
        "bbb.bbb",
        ".b.u.b.",
        "bbb.bbb",
        "bu.b.ub",
      ],
    },
    {
      name: "Tulip Bunch",
      art: [
        "r.p.u.r",
        "rrppuur",
        "rrppuur",
        ".rppuu.",
        "..yyy..",
        "...y...",
      ],
    },
    {
      name: "Rainbow",
      art: [
        "rrrrrrr",
        "yyyyyyy",
        "ppppppp",
        "uuuuuuu",
        "bbbbbbb",
      ],
    },
  ];

  // ---- DOM refs -------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const gardenEl = $("garden");
  const freshEl = $("fresh");
  const rackEl = $("rack");
  const dryEl = $("dry");
  const craftEl = $("craft");
  const craftNameEl = $("craft-name");
  const toastEl = $("toast");

  // ---- Helpers --------------------------------------------------------
  function makePetal(color, { dried = false } = {}) {
    const el = document.createElement("button");
    el.className = "petal" + (dried ? " dried" : "");
    el.style.setProperty("--c", COLORS[color].var);
    el.style.animation = "pop-in .25s ease";
    el.setAttribute("aria-label", `${color} ${dried ? "dried " : ""}petal`);
    return el;
  }

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  function updateStats() {
    $("stat-crafts").textContent = state.stats.crafts;
    $("stat-collected").textContent = state.stats.collected;
    $("stat-score").textContent = state.stats.score;
  }

  // ---- Garden ---------------------------------------------------------
  function initGarden() {
    const palette = Object.keys(COLORS);
    state.flowers = Array.from({ length: GARDEN_SIZE }, () => ({
      color: palette[Math.floor(Math.random() * palette.length)],
      bloom: true,
      regrowAt: 0,
    }));
    renderGarden();
  }

  function renderGarden() {
    gardenEl.innerHTML = "";
    state.flowers.forEach((f, i) => {
      const btn = document.createElement("button");
      btn.className = "flower" + (f.bloom ? "" : " wilted");
      btn.disabled = !f.bloom;
      btn.innerHTML = `<span>${FLOWER_EMOJI[f.color]}</span>`;
      if (!f.bloom) {
        const bar = document.createElement("div");
        bar.className = "regrow-bar";
        bar.innerHTML = "<i></i>";
        btn.appendChild(bar);
      }
      btn.addEventListener("click", () => pickFlower(i));
      gardenEl.appendChild(btn);
    });
  }

  function pickFlower(i) {
    const f = state.flowers[i];
    if (!f.bloom) return;
    const count = 2 + Math.floor(Math.random() * 2); // 2–3 petals
    for (let k = 0; k < count; k++) {
      state.fresh.push({ id: ++uid, color: f.color });
    }
    state.stats.collected += count;
    f.bloom = false;
    f.regrowAt = Date.now() + REGROW_MS;
    // re-roll colour so the garden stays varied
    const palette = Object.keys(COLORS);
    f.color = palette[Math.floor(Math.random() * palette.length)];
    renderGarden();
    renderFresh();
    updateStats();
    toast(`+${count} ${COLORS[state.fresh[state.fresh.length - 1].color].name} petals`);
  }

  // ---- Fresh tray -----------------------------------------------------
  function renderFresh() {
    freshEl.innerHTML = "";
    state.fresh.forEach((p) => {
      const el = makePetal(p.color);
      el.title = "Tap to dry on the board";
      el.addEventListener("click", () => moveToRack(p.id));
      freshEl.appendChild(el);
    });
  }

  function moveToRack(id) {
    const slot = state.rack.indexOf(null);
    if (slot === -1) {
      toast("The drying board is full!");
      return;
    }
    const idx = state.fresh.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const [p] = state.fresh.splice(idx, 1);
    state.rack[slot] = { id: p.id, color: p.color, dryAt: Date.now() + DRY_MS };
    renderFresh();
    renderRack();
  }

  // ---- Drying rack ----------------------------------------------------
  function renderRack() {
    rackEl.innerHTML = "";
    for (let i = 0; i < RACK_SIZE; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = state.rack[i];
      if (item) {
        const wrap = document.createElement("div");
        wrap.className = "drying";
        const ring = document.createElement("div");
        ring.className = "ring";
        const petal = makePetal(item.color);
        petal.style.animation = "none";
        wrap.appendChild(ring);
        wrap.appendChild(petal);
        wrap.dataset.idx = i;
        petal.addEventListener("click", () => collectDried(i));
        slot.appendChild(wrap);
      }
      rackEl.appendChild(slot);
    }
    tickRack(); // paint initial progress
  }

  function collectDried(i) {
    const item = state.rack[i];
    if (!item || Date.now() < item.dryAt) return;
    state.dry.push({ id: item.id, color: item.color });
    state.rack[i] = null;
    renderRack();
    renderDry();
  }

  // Update drying rings + flower regrowth on an animation loop.
  function tickRack() {
    const now = Date.now();
    rackEl.querySelectorAll(".drying").forEach((wrap) => {
      const i = +wrap.dataset.idx;
      const item = state.rack[i];
      if (!item) return;
      const remaining = item.dryAt - now;
      const p = Math.max(0, Math.min(1, 1 - remaining / DRY_MS));
      wrap.querySelector(".ring").style.setProperty("--p", (p * 100).toFixed(1) + "%");
      wrap.classList.toggle("done", remaining <= 0);
    });
  }

  function loop() {
    tickRack();
    const now = Date.now();
    let gardenDirty = false;
    state.flowers.forEach((f) => {
      if (!f.bloom) {
        if (now >= f.regrowAt) {
          f.bloom = true;
          gardenDirty = true;
        }
      }
    });
    if (gardenDirty) renderGarden();
    // animate regrow bars
    state.flowers.forEach((f, i) => {
      if (!f.bloom) {
        const btn = gardenEl.children[i];
        const bar = btn && btn.querySelector(".regrow-bar i");
        if (bar) {
          const prog = 1 - (f.regrowAt - now) / REGROW_MS;
          bar.style.width = Math.max(0, Math.min(1, prog)) * 100 + "%";
        }
      }
    });
    requestAnimationFrame(loop);
  }

  // ---- Dried tray -----------------------------------------------------
  function renderDry() {
    dryEl.innerHTML = "";
    state.dry.forEach((p) => {
      const el = makePetal(p.color, { dried: true });
      el.title = "Tap to press into the craft";
      el.addEventListener("click", () => pressIntoCraft(p.id));
      dryEl.appendChild(el);
    });
    highlightWantedColors();
  }

  // ---- Craft ----------------------------------------------------------
  function loadCraft(index) {
    const def = CRAFTS[index % CRAFTS.length];
    const rows = def.art.length;
    const cols = Math.max(...def.art.map((r) => r.length));
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ch = def.art[r][c] || ".";
        const color = LEGEND[ch] || null;
        cells.push({ color, filled: false });
      }
    }
    state.craft = { name: def.name, cols, rows, cells };
    state.craftIndex = index;
    craftNameEl.textContent = def.name;
    renderCraft();
  }

  function renderCraft() {
    const { cols, cells } = state.craft;
    craftEl.style.gridTemplateColumns = `repeat(${cols}, 30px)`;
    craftEl.innerHTML = "";
    cells.forEach((cell) => {
      const el = document.createElement("div");
      if (!cell.color) {
        el.className = "cell empty";
      } else if (cell.filled) {
        el.className = "cell filled";
        el.style.setProperty("--c", COLORS[cell.color].var);
      } else {
        el.className = "cell slot-open";
        el.style.setProperty("--c", COLORS[cell.color].var);
      }
      craftEl.appendChild(el);
    });
    highlightWantedColors();
  }

  // Pulse open slots whose colour we currently have a dried petal for.
  function highlightWantedColors() {
    if (!state.craft) return;
    const have = new Set(state.dry.map((p) => p.color));
    const cellEls = craftEl.children;
    state.craft.cells.forEach((cell, i) => {
      const el = cellEls[i];
      if (el && el.classList.contains("slot-open")) {
        el.classList.toggle("wanted", have.has(cell.color));
      }
    });
  }

  function pressIntoCraft(id) {
    const pIdx = state.dry.findIndex((p) => p.id === id);
    if (pIdx === -1) return;
    const color = state.dry[pIdx].color;
    const cellIdx = state.craft.cells.findIndex(
      (c) => c.color === color && !c.filled
    );
    if (cellIdx === -1) {
      toast(`No ${COLORS[color].name} spot left — try another colour`);
      return;
    }
    state.craft.cells[cellIdx].filled = true;
    state.dry.splice(pIdx, 1);
    state.stats.score += 5;
    renderDry();
    renderCraft();
    updateStats();

    if (state.craft.cells.every((c) => !c.color || c.filled)) {
      finishCraft();
    }
  }

  function finishCraft() {
    state.stats.crafts += 1;
    state.stats.score += 50;
    updateStats();
    celebrate();
    toast(`🎀 "${state.craft.name}" complete!  +50`);
    setTimeout(() => loadCraft(state.craftIndex + 1), 1400);
  }

  // ---- Confetti -------------------------------------------------------
  function celebrate() {
    const colors = Object.values(COLORS).map((c) => c.var);
    for (let i = 0; i < 80; i++) {
      const c = document.createElement("div");
      c.className = "confetti";
      c.style.left = Math.random() * 100 + "vw";
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 1.6 + Math.random() * 1.4 + "s";
      c.style.animationDelay = Math.random() * 0.4 + "s";
      c.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 3400);
    }
  }

  // ---- Help modal -----------------------------------------------------
  $("help-btn").addEventListener("click", () => $("help").classList.remove("hidden"));
  $("help-close").addEventListener("click", () => $("help").classList.add("hidden"));
  $("help").addEventListener("click", (e) => {
    if (e.target === $("help")) $("help").classList.add("hidden");
  });

  // ---- Boot -----------------------------------------------------------
  function start() {
    initGarden();
    renderFresh();
    renderRack();
    renderDry();
    loadCraft(0);
    updateStats();
    requestAnimationFrame(loop);
    if (!localStorage.getItem("petalPressSeen")) {
      $("help").classList.remove("hidden");
      localStorage.setItem("petalPressSeen", "1");
    }
  }

  start();
})();
