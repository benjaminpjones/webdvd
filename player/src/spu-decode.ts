/**
 * spu-decode.ts — DVD subpicture (SPU) packet decoder.
 *
 * Parses the Display Control Sequence (DCSQ) chain and RLE-decodes
 * the 2-bit indexed bitmap. DVD SPU bitmaps use 4 colors from a
 * palette (CLUT) with per-color alpha, rendered as interlaced
 * top/bottom fields.
 *
 * Reference: http://dvd.sourceforge.net/dvdinfo/spu.html
 */

export interface SpuImage {
  /** Display area top-left X in DVD coordinates (720x480) */
  x: number;
  /** Display area top-left Y */
  y: number;
  /** Display area width */
  width: number;
  /** Display area height */
  height: number;
  /**
   * Indexed pixel data (values 0–3), row-major, size = width * height.
   * Each value is an index into colorIndices/alphaValues.
   */
  pixels: Uint8Array;
  /** 4 CLUT indices (each 0–15, referencing the 16-color PGC palette) */
  colorIndices: [number, number, number, number];
  /** 4 alpha values (each 0–15, where 0=transparent, 15=opaque) */
  alphaValues: [number, number, number, number];
}

/** DCSQ command IDs */
const CMD_END = 0xff;
const CMD_SET_COLOR = 0x03;
const CMD_SET_ALPHA = 0x04;
const CMD_SET_AREA = 0x05;
const CMD_SET_OFFSETS = 0x06;
const CMD_FORCE_DISPLAY = 0x00;
const CMD_START_DISPLAY = 0x01;
const CMD_STOP_DISPLAY = 0x02;

/**
 * Decode a reassembled SPU packet into an indexed bitmap.
 *
 * @param data  Complete SPU packet bytes (starts with 2-byte size, 2-byte DCSQ offset)
 * @returns Decoded image, or null if the packet cannot be decoded
 */
export function decodeSpuPacket(data: Uint8Array): SpuImage | null {
  if (data.length < 4) return null;

  const dcsqOffset = (data[2] << 8) | data[3];
  if (dcsqOffset >= data.length) return null;

  // Parse DCSQ chain — walk linked list of display control sequences.
  // We use the last complete set of parameters found.
  let colorIndices: [number, number, number, number] = [0, 0, 0, 0];
  let alphaValues: [number, number, number, number] = [0, 0, 0, 0];
  let x0 = 0,
    y0 = 0,
    x1 = 0,
    y1 = 0;
  let topFieldOffset = 0;
  let bottomFieldOffset = 0;
  let hasArea = false;

  let dcsqPos = dcsqOffset;
  const visited = new Set<number>();

  while (dcsqPos < data.length && !visited.has(dcsqPos)) {
    visited.add(dcsqPos);

    // DCSQ header: 2 bytes delay (in 90kHz/1024 units), 2 bytes next DCSQ offset
    if (dcsqPos + 4 > data.length) break;
    const nextDcsq = (data[dcsqPos + 2] << 8) | data[dcsqPos + 3];
    let cmdPos = dcsqPos + 4;

    // Parse commands in this DCSQ
    while (cmdPos < data.length) {
      const cmd = data[cmdPos++];

      if (cmd === CMD_END) break;

      switch (cmd) {
        case CMD_FORCE_DISPLAY:
        case CMD_START_DISPLAY:
        case CMD_STOP_DISPLAY:
          // No additional bytes
          break;

        case CMD_SET_COLOR:
          // 2 bytes: [C3 C2] [C1 C0] — 4-bit CLUT indices, stored as [index0..3]
          if (cmdPos + 2 > data.length) return null;
          colorIndices = [
            data[cmdPos + 1] & 0x0f, // C0 (background)
            (data[cmdPos + 1] >> 4) & 0x0f, // C1 (pattern)
            data[cmdPos] & 0x0f, // C2 (emphasis 1)
            (data[cmdPos] >> 4) & 0x0f, // C3 (emphasis 2)
          ];
          cmdPos += 2;
          break;

        case CMD_SET_ALPHA:
          // 2 bytes: [A3 A2] [A1 A0] — 4-bit alpha values, stored as [index0..3]
          if (cmdPos + 2 > data.length) return null;
          alphaValues = [
            data[cmdPos + 1] & 0x0f, // A0
            (data[cmdPos + 1] >> 4) & 0x0f, // A1
            data[cmdPos] & 0x0f, // A2
            (data[cmdPos] >> 4) & 0x0f, // A3
          ];
          cmdPos += 2;
          break;

        case CMD_SET_AREA:
          // 6 bytes defining the display rectangle
          // [x0 hi:4 | x0 lo:8] [x1 hi:4 | x1 lo:8] (3 bytes for x0/x1)
          // [y0 hi:4 | y0 lo:8] [y1 hi:4 | y1 lo:8] (3 bytes for y0/y1)
          if (cmdPos + 6 > data.length) return null;
          x0 = (data[cmdPos] << 4) | (data[cmdPos + 1] >> 4);
          x1 = ((data[cmdPos + 1] & 0x0f) << 8) | data[cmdPos + 2];
          y0 = (data[cmdPos + 3] << 4) | (data[cmdPos + 4] >> 4);
          y1 = ((data[cmdPos + 4] & 0x0f) << 8) | data[cmdPos + 5];
          hasArea = true;
          cmdPos += 6;
          break;

        case CMD_SET_OFFSETS:
          // 4 bytes: top field offset (2), bottom field offset (2)
          if (cmdPos + 4 > data.length) return null;
          topFieldOffset = (data[cmdPos] << 8) | data[cmdPos + 1];
          bottomFieldOffset = (data[cmdPos + 2] << 8) | data[cmdPos + 3];
          cmdPos += 4;
          break;

        default:
          // Unknown command — can't safely skip, stop parsing
          break;
      }
    }

    // If next DCSQ points to itself, we're done
    if (nextDcsq === dcsqPos) break;
    dcsqPos = nextDcsq;
  }

  if (!hasArea || topFieldOffset === 0) return null;

  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  if (width <= 0 || height <= 0 || width > 720 || height > 480) return null;

  const pixels = new Uint8Array(width * height);

  // Decode top field (even lines: 0, 2, 4, ...)
  decodeField(data, topFieldOffset, dcsqOffset, pixels, width, height, 0);
  // Decode bottom field (odd lines: 1, 3, 5, ...)
  decodeField(data, bottomFieldOffset, dcsqOffset, pixels, width, height, 1);

  return { x: x0, y: y0, width, height, pixels, colorIndices, alphaValues };
}

/**
 * RLE decode one field (top or bottom) of an SPU bitmap.
 *
 * Nibble-based variable-length coding. Each code encodes (length, color):
 * - Bottom 2 bits = color index (0–3)
 * - Upper bits = run length
 * - Read 1–4 nibbles, accumulating into a value, stopping when the
 *   accumulated value exceeds the threshold for that nibble count:
 *   1 nibble: value >= 0x04 → length 1–3
 *   2 nibbles: value >= 0x10 → length 4–15
 *   3 nibbles: value >= 0x40 → length 16–63
 *   4 nibbles: always stop → length 0–255 (0 = fill rest of line)
 */
function decodeField(
  data: Uint8Array,
  startOffset: number,
  endOffset: number,
  pixels: Uint8Array,
  width: number,
  height: number,
  fieldStart: number, // 0 for top field, 1 for bottom field
): void {
  const nibbleReader = new NibbleReader(data, startOffset, endOffset);

  for (let row = fieldStart; row < height; row += 2) {
    let col = 0;
    while (col < width) {
      const code = readRleCode(nibbleReader);
      const color = code & 0x03;
      let length = code >> 2;

      if (length === 0) {
        // Fill to end of line
        length = width - col;
      }

      length = Math.min(length, width - col);
      const rowOffset = row * width;
      for (let i = 0; i < length; i++) {
        pixels[rowOffset + col + i] = color;
      }
      col += length;
    }
    // Align to next byte boundary at end of each line
    nibbleReader.alignToByte();
  }
}

/** Read a variable-length RLE code from the nibble stream */
function readRleCode(reader: NibbleReader): number {
  // Read up to 4 nibbles, stopping early when we have enough bits
  let value = reader.readNibble();
  if (value >= 0x04) return value; // 1 nibble: length 1-3

  value = (value << 4) | reader.readNibble();
  if (value >= 0x10) return value; // 2 nibbles: length 4-15

  value = (value << 4) | reader.readNibble();
  if (value >= 0x40) return value; // 3 nibbles: length 16-63

  value = (value << 4) | reader.readNibble(); // 4 nibbles: length 0-255
  return value;
}

class NibbleReader {
  private data: Uint8Array;
  private bytePos: number;
  private highNibble: boolean; // true = read high nibble next
  private endOffset: number;

  constructor(data: Uint8Array, startOffset: number, endOffset: number) {
    this.data = data;
    this.bytePos = startOffset;
    this.highNibble = true;
    this.endOffset = endOffset;
  }

  readNibble(): number {
    if (this.bytePos >= this.endOffset) return 0;
    const byte = this.data[this.bytePos];
    if (this.highNibble) {
      this.highNibble = false;
      return (byte >> 4) & 0x0f;
    } else {
      this.highNibble = true;
      this.bytePos++;
      return byte & 0x0f;
    }
  }

  alignToByte(): void {
    if (!this.highNibble) {
      this.highNibble = true;
      this.bytePos++;
    }
  }
}
