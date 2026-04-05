import { describe, test, expect } from "vitest";
import { decodeSpuPacket } from "./spu-decode";

/**
 * Build a minimal SPU packet with known RLE data.
 *
 * SPU packet structure:
 *   [0-1]  Total packet size (2 bytes)
 *   [2-3]  Offset to DCSQ (2 bytes)
 *   [4..]  Pixel data (RLE encoded, top/bottom fields)
 *   [dcsq] Display Control Sequence chain
 */
function buildSpuPacket(opts: {
  topFieldRle: number[];
  bottomFieldRle: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  colorIndices?: [number, number, number, number];
  alphaValues?: [number, number, number, number];
}): Uint8Array {
  const colors = opts.colorIndices ?? [0, 1, 2, 3];
  const alphas = opts.alphaValues ?? [0, 15, 15, 15];

  // Pixel data starts at offset 4
  const topFieldOffset = 4;
  const bottomFieldOffset = topFieldOffset + opts.topFieldRle.length;
  const dcsqOffset = bottomFieldOffset + opts.bottomFieldRle.length;

  // Build DCSQ
  const dcsq = buildDcsq({
    dcsqOffset,
    x0: opts.x0,
    y0: opts.y0,
    x1: opts.x1,
    y1: opts.y1,
    topFieldOffset,
    bottomFieldOffset,
    colorIndices: colors,
    alphaValues: alphas,
  });

  const totalSize = dcsqOffset + dcsq.length;

  const packet = new Uint8Array(totalSize);
  // Header
  packet[0] = (totalSize >> 8) & 0xff;
  packet[1] = totalSize & 0xff;
  packet[2] = (dcsqOffset >> 8) & 0xff;
  packet[3] = dcsqOffset & 0xff;
  // Pixel data
  packet.set(opts.topFieldRle, topFieldOffset);
  packet.set(opts.bottomFieldRle, bottomFieldOffset);
  // DCSQ
  packet.set(dcsq, dcsqOffset);

  return packet;
}

function buildDcsq(opts: {
  dcsqOffset: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  topFieldOffset: number;
  bottomFieldOffset: number;
  colorIndices: [number, number, number, number];
  alphaValues: [number, number, number, number];
}): number[] {
  const [c0, c1, c2, c3] = opts.colorIndices;
  const [a0, a1, a2, a3] = opts.alphaValues;

  return [
    // Delay (2 bytes) — 0 = immediate
    0x00,
    0x00,
    // Next DCSQ offset (2 bytes) — points to itself = end
    (opts.dcsqOffset >> 8) & 0xff,
    opts.dcsqOffset & 0xff,
    // CMD: FORCE_DISPLAY (0x00)
    0x00,
    // CMD: SET_COLOR (0x03) + 2 bytes [C3C2, C1C0]
    0x03,
    (c3 << 4) | c2,
    (c1 << 4) | c0,
    // CMD: SET_ALPHA (0x04) + 2 bytes [A3A2, A1A0]
    0x04,
    (a3 << 4) | a2,
    (a1 << 4) | a0,
    // CMD: SET_AREA (0x05) + 6 bytes
    0x05,
    (opts.x0 >> 4) & 0xff,
    ((opts.x0 & 0x0f) << 4) | ((opts.x1 >> 8) & 0x0f),
    opts.x1 & 0xff,
    (opts.y0 >> 4) & 0xff,
    ((opts.y0 & 0x0f) << 4) | ((opts.y1 >> 8) & 0x0f),
    opts.y1 & 0xff,
    // CMD: SET_OFFSETS (0x06) + 4 bytes
    0x06,
    (opts.topFieldOffset >> 8) & 0xff,
    opts.topFieldOffset & 0xff,
    (opts.bottomFieldOffset >> 8) & 0xff,
    opts.bottomFieldOffset & 0xff,
    // CMD: END (0xFF)
    0xff,
  ];
}

/**
 * Encode an RLE nibble sequence as bytes.
 * Each pair of nibbles becomes one byte.
 * If odd number of nibbles, the last nibble goes in the high bits
 * and is padded with 0 in the low bits.
 */
function nibblesToBytes(nibbles: number[]): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < nibbles.length; i += 2) {
    const hi = nibbles[i];
    const lo = i + 1 < nibbles.length ? nibbles[i + 1] : 0;
    bytes.push((hi << 4) | lo);
  }
  return bytes;
}

/**
 * Encode an RLE code for the given length and color (nibble sequence).
 * - len 1-3:   1 nibble  (value = (len << 2) | color, >= 0x04)
 * - len 4-15:  2 nibbles (value = (len << 2) | color, >= 0x10)
 * - len 16-63: 3 nibbles (value = (len << 2) | color, >= 0x40)
 * - len 0 (fill rest): 4 nibbles of 0 + color in bottom 2 bits
 */
function rleCode(length: number, color: number): number[] {
  const value = (length << 2) | (color & 3);

  if (length >= 1 && length <= 3) {
    // 1 nibble
    return [value & 0x0f];
  } else if (length >= 4 && length <= 15) {
    // 2 nibbles
    return [(value >> 4) & 0x0f, value & 0x0f];
  } else if (length >= 16 && length <= 63) {
    // 3 nibbles
    return [(value >> 8) & 0x0f, (value >> 4) & 0x0f, value & 0x0f];
  } else {
    // 4 nibbles (length 0 = fill rest of line, or length 64+)
    return [(value >> 12) & 0x0f, (value >> 8) & 0x0f, (value >> 4) & 0x0f, value & 0x0f];
  }
}

describe("decodeSpuPacket", () => {
  test("decodes a simple 4x2 bitmap", () => {
    // 4 pixels wide, 2 lines tall (1 top field line, 1 bottom field line)
    // Top field (line 0): 4 pixels of color 1
    // Bottom field (line 1): 4 pixels of color 2
    const topNibbles = rleCode(4, 1); // 2 nibbles: length 4, color 1
    const bottomNibbles = rleCode(4, 2);

    const topRle = nibblesToBytes(topNibbles);
    const bottomRle = nibblesToBytes(bottomNibbles);

    const packet = buildSpuPacket({
      topFieldRle: topRle,
      bottomFieldRle: bottomRle,
      x0: 100,
      y0: 200,
      x1: 103,
      y1: 201,
      colorIndices: [0, 5, 10, 15],
      alphaValues: [0, 15, 15, 15],
    });

    const result = decodeSpuPacket(packet);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(100);
    expect(result!.y).toBe(200);
    expect(result!.width).toBe(4);
    expect(result!.height).toBe(2);
    expect(result!.colorIndices).toEqual([0, 5, 10, 15]);
    expect(result!.alphaValues).toEqual([0, 15, 15, 15]);

    // Check pixel data: row 0 = all color 1, row 1 = all color 2
    expect(Array.from(result!.pixels)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  test("decodes mixed colors in a single line", () => {
    // 6 pixels wide, 2 lines tall
    // Top field: 2 pixels color 0, 2 pixels color 1, 2 pixels color 3
    // Bottom field: 6 pixels color 2
    const topNibbles = [...rleCode(2, 0), ...rleCode(2, 1), ...rleCode(2, 3)];
    const bottomNibbles = rleCode(6, 2);

    const topRle = nibblesToBytes(topNibbles);
    const bottomRle = nibblesToBytes(bottomNibbles);

    const packet = buildSpuPacket({
      topFieldRle: topRle,
      bottomFieldRle: bottomRle,
      x0: 0,
      y0: 0,
      x1: 5,
      y1: 1,
    });

    const result = decodeSpuPacket(packet);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(6);
    expect(result!.height).toBe(2);
    // Row 0 (top field): 0,0,1,1,3,3
    // Row 1 (bottom field): 2,2,2,2,2,2
    expect(Array.from(result!.pixels)).toEqual([0, 0, 1, 1, 3, 3, 2, 2, 2, 2, 2, 2]);
  });

  test("handles fill-to-end-of-line (length 0)", () => {
    // 8 pixels wide, 2 lines
    // Top field: 3 pixels color 1, then fill rest with color 0 (5 pixels)
    // Bottom field: fill entire line with color 3
    const topNibbles = [...rleCode(3, 1), ...rleCode(0, 0)];
    const bottomNibbles = rleCode(0, 3);

    const topRle = nibblesToBytes(topNibbles);
    const bottomRle = nibblesToBytes(bottomNibbles);

    const packet = buildSpuPacket({
      topFieldRle: topRle,
      bottomFieldRle: bottomRle,
      x0: 0,
      y0: 0,
      x1: 7,
      y1: 1,
    });

    const result = decodeSpuPacket(packet);
    expect(result).not.toBeNull();
    expect(Array.from(result!.pixels)).toEqual([
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0, // top field
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3, // bottom field
    ]);
  });

  test("decodes 4-line bitmap with interlaced fields", () => {
    // 4 pixels wide, 4 lines tall
    // Top field: lines 0, 2
    // Bottom field: lines 1, 3
    const topNibbles = [
      ...rleCode(4, 1), // line 0
      ...rleCode(4, 3), // line 2
    ];
    const bottomNibbles = [
      ...rleCode(4, 2), // line 1
      ...rleCode(4, 0), // line 3
    ];

    const topRle = nibblesToBytes(topNibbles);
    const bottomRle = nibblesToBytes(bottomNibbles);

    const packet = buildSpuPacket({
      topFieldRle: topRle,
      bottomFieldRle: bottomRle,
      x0: 10,
      y0: 20,
      x1: 13,
      y1: 23,
    });

    const result = decodeSpuPacket(packet);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(4);
    expect(result!.height).toBe(4);
    expect(Array.from(result!.pixels)).toEqual([
      1,
      1,
      1,
      1, // line 0 (top field)
      2,
      2,
      2,
      2, // line 1 (bottom field)
      3,
      3,
      3,
      3, // line 2 (top field)
      0,
      0,
      0,
      0, // line 3 (bottom field)
    ]);
  });

  test("returns null for too-short data", () => {
    expect(decodeSpuPacket(new Uint8Array([0, 2]))).toBeNull();
    expect(decodeSpuPacket(new Uint8Array([]))).toBeNull();
  });

  test("returns null for invalid DCSQ offset", () => {
    const packet = new Uint8Array([0, 10, 0xff, 0xff, 0, 0, 0, 0, 0, 0]);
    expect(decodeSpuPacket(packet)).toBeNull();
  });
});
