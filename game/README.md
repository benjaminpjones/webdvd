# 🌸 Petal Press

A cozy little browser game: **collect** petals from flowers, **dry** them on a
board, and **press** them into pretty crafts.

No build step, no dependencies — just static HTML/CSS/JS, so it deploys straight
to GitHub Pages.

## Play locally

Open `index.html` in a browser, or serve the folder:

```bash
cd game
python3 -m http.server 8000
# then visit http://localhost:8000
```

## How to play

1. **Garden** — tap a blooming flower to gather petals into the *Fresh* tray.
   Flowers re-bloom after a short while.
2. **Drying Board** — tap a fresh petal to lay it on the board. Wait for the ring
   to fill, then it becomes a *dried* petal.
3. **Craft** — tap a dried petal to press it into a matching coloured spot on the
   pattern. Fill the whole picture to complete the craft and start a new one.

## Deployment

The included GitHub Actions workflow (`.github/workflows/pages.yml`) publishes
the `game/` folder to GitHub Pages on every push to `main` (or via manual
dispatch). Enable it once under **Settings → Pages → Build and deployment →
Source: GitHub Actions**.

## Files

| File         | Purpose                                  |
| ------------ | ---------------------------------------- |
| `index.html` | Markup + layout                          |
| `style.css`  | Cottagecore styling, animations          |
| `game.js`    | Game state, garden/rack/craft logic      |
