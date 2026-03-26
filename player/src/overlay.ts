/**
 * overlay.ts — Canvas overlay for DVD menu button highlights (M3)
 *
 * Draws colored rectangles on the canvas overlay to indicate button positions
 * and the currently selected button. Coordinates are in DVD space (720x480 NTSC)
 * and scaled to the canvas display size.
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
    // Set internal resolution to DVD space — CSS handles display scaling
    this.canvas.width = DVD_WIDTH;
    this.canvas.height = DVD_HEIGHT;
  }

  render(menu: MenuState): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, DVD_WIDTH, DVD_HEIGHT);

    for (const btn of menu.buttons) {
      const isCurrent = btn.buttonN === menu.currentButton;
      const x = btn.x0;
      const y = btn.y0;
      const w = btn.x1 - btn.x0;
      const h = btn.y1 - btn.y0;

      if (isCurrent) {
        // Selected button: bright highlight
        ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
      } else {
        // Other buttons: subtle outline
        ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);
      }
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, DVD_WIDTH, DVD_HEIGHT);
  }

  /**
   * Convert a click position on the canvas element to DVD coordinates.
   * Returns null if the click is outside the video area.
   */
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
