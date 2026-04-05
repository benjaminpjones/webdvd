/**
 * overlay.ts — Canvas overlay for DVD subpicture rendering (M3)
 *
 * Renders decoded SPU bitmaps with CLUT palette coloring and per-button
 * highlight state overrides from PCI data. Falls back to no overlay when
 * no SPU data is available.
 */

import type { MenuState } from "./session";

const DVD_WIDTH = 720;
const DVD_HEIGHT = 480;

export class MenuOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.canvas.width = DVD_WIDTH;
    this.canvas.height = DVD_HEIGHT;
  }

  render(menu: MenuState): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, DVD_WIDTH, DVD_HEIGHT);

    if (menu.spuImage && menu.clut.length === 16) {
      this.renderSpu(menu);
    }
  }

  private renderSpu(menu: MenuState): void {
    const spu = menu.spuImage!;
    const clut = menu.clut;
    const { x, y, width, height, pixels, colorIndices, alphaValues } = spu;

    if (width <= 0 || height <= 0) return;

    const imageData = this.ctx.createImageData(width, height);
    const data = imageData.data;

    // Pre-compute RGBA for the 4 SPU color indices
    type Rgba = [number, number, number, number];
    const baseRgba: Rgba[] = [];
    for (let i = 0; i < 4; i++) {
      baseRgba.push(clutEntryToRgba(clut[colorIndices[i]], alphaValues[i]));
    }

    // Build per-button override maps if we have button color info
    const selectedButton = menu.currentButton;
    const btnOverrides = menu.buttonColors ? buildButtonOverrides(menu, clut) : null;

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const pixelIdx = row * width + col;
        const colorIdx = pixels[pixelIdx]; // 0-3
        const outIdx = pixelIdx * 4;

        // Check if this pixel is inside the selected button's region
        let rgba: Rgba = baseRgba[colorIdx];
        if (btnOverrides && selectedButton > 0) {
          const dvdX = x + col;
          const dvdY = y + row;
          for (const btn of menu.buttons) {
            if (btn.buttonN !== selectedButton) continue;
            if (dvdX >= btn.x0 && dvdX <= btn.x1 && dvdY >= btn.y0 && dvdY <= btn.y1) {
              const override = btnOverrides.get(btn.buttonN);
              if (override) rgba = override[colorIdx];
            }
            break;
          }
        }

        data[outIdx] = rgba[0];
        data[outIdx + 1] = rgba[1];
        data[outIdx + 2] = rgba[2];
        data[outIdx + 3] = rgba[3];
      }
    }

    this.ctx.putImageData(imageData, x, y);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, DVD_WIDTH, DVD_HEIGHT);
  }

  screenToDvd(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = DVD_WIDTH / rect.width;
    const scaleY = DVD_HEIGHT / rect.height;
    const x = Math.round((clientX - rect.left) * scaleX);
    const y = Math.round((clientY - rect.top) * scaleY);
    if (x < 0 || x >= DVD_WIDTH || y < 0 || y >= DVD_HEIGHT) return null;
    return { x, y };
  }
}

/**
 * Convert a CLUT entry (uint32: 0x00_Y_Cr_Cb) and 4-bit alpha to RGBA.
 */
function clutEntryToRgba(entry: number, alpha4: number): [number, number, number, number] {
  const y = (entry >> 16) & 0xff;
  const cr = (entry >> 8) & 0xff;
  const cb = entry & 0xff;

  const r = Math.max(0, Math.min(255, Math.round(y + 1.402 * (cr - 128))));
  const g = Math.max(
    0,
    Math.min(255, Math.round(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128))),
  );
  const b = Math.max(0, Math.min(255, Math.round(y + 1.772 * (cb - 128))));

  // 4-bit alpha (0=transparent, 15=opaque) → 8-bit
  const a = Math.round((alpha4 / 15) * 255);

  return [r, g, b, a];
}

/**
 * Build per-button RGBA override arrays from PCI button color table.
 * Returns a map: buttonN → [rgba for index 0, rgba for index 1, rgba for index 2, rgba for index 3]
 */
function buildButtonOverrides(
  menu: MenuState,
  clut: number[],
): Map<number, [number, number, number, number][]> {
  const colorTable = menu.buttonColors!;
  const overrides = new Map<number, [number, number, number, number][]>();

  for (const btn of menu.buttons) {
    // btn_coln is 1-indexed in the color table (0 = use SPU defaults)
    const groupIdx = btn.btnColn;
    if (groupIdx === 0 || groupIdx > 3) continue;

    // btn_coli[groupIdx-1][0] = select state colors/alpha
    const selectVal = colorTable[groupIdx - 1][0];
    // Unpack: [Ci3:4, Ci2:4, Ci1:4, Ci0:4, A3:4, A2:4, A1:4, A0:4]
    const ci3 = (selectVal >> 28) & 0x0f;
    const ci2 = (selectVal >> 24) & 0x0f;
    const ci1 = (selectVal >> 20) & 0x0f;
    const ci0 = (selectVal >> 16) & 0x0f;
    const a3 = (selectVal >> 12) & 0x0f;
    const a2 = (selectVal >> 8) & 0x0f;
    const a1 = (selectVal >> 4) & 0x0f;
    const a0 = selectVal & 0x0f;

    overrides.set(btn.buttonN, [
      clutEntryToRgba(clut[ci0] ?? 0, a0),
      clutEntryToRgba(clut[ci1] ?? 0, a1),
      clutEntryToRgba(clut[ci2] ?? 0, a2),
      clutEntryToRgba(clut[ci3] ?? 0, a3),
    ]);
  }

  return overrides;
}
