/**
 * mp4-codec.ts — derive an MSE codec string from an fMP4 init segment.
 *
 * The player must declare an exact codec string when it creates a
 * `SourceBuffer` (Safari rejects a MIME type that doesn't match the actual
 * bitstream). Rather than hard-code a string that has to be kept in lockstep
 * with the server's ffmpeg flags — a coupling that silently breaks Safari when
 * either side drifts — we parse the codec parameters straight out of the bytes
 * the server sends. Whatever ffmpeg emits, we declare exactly that.
 *
 * Only the handful of boxes needed to reach the sample entries are walked:
 *   moov → trak → mdia → minf → stbl → stsd → {avc1|avc3|mp4a} → {avcC|esds}
 */

export interface CodecInfo {
  /** Full MIME type ready for `MediaSource.addSourceBuffer`. */
  mime: string;
  /** e.g. "avc1.640028", if a video track is present. */
  video?: string;
  /** e.g. "mp4a.40.2", if an audio track is present. */
  audio?: string;
}

interface Box {
  type: string;
  payloadStart: number;
  payloadEnd: number;
  end: number; // byte after the whole box
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function boxType(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

/** Read the box header at `start`, or null if it doesn't fit in [start, end). */
function readBox(buf: Uint8Array, start: number, end: number): Box | null {
  if (start + 8 > end) return null;
  let size = readU32(buf, start);
  let headerSize = 8;
  if (size === 1) {
    // 64-bit largesize. We never emit boxes >4GB, so the high word is 0.
    if (start + 16 > end) return null;
    size = readU32(buf, start + 12);
    headerSize = 16;
  } else if (size === 0) {
    size = end - start; // extends to the end of the buffer
  }
  return {
    type: boxType(buf, start + 4),
    payloadStart: start + headerSize,
    payloadEnd: start + size,
    end: start + size,
  };
}

/** Find the first child box of `type` within [start, end). */
function findBox(buf: Uint8Array, start: number, end: number, type: string): Box | null {
  let pos = start;
  while (pos + 8 <= end) {
    const box = readBox(buf, pos, end);
    if (!box || box.end <= pos) return null;
    if (box.type === type) return box;
    pos = box.end;
  }
  return null;
}

/** Collect every child box of `type` within [start, end). */
function findBoxes(buf: Uint8Array, start: number, end: number, type: string): Box[] {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const box = readBox(buf, pos, end);
    if (!box || box.end <= pos) break;
    if (box.type === type) out.push(box);
    pos = box.end;
  }
  return out;
}

/** Walk a chain of nested single-child container boxes. */
function descend(buf: Uint8Array, box: Box, path: string[]): Box | null {
  let cur: Box | null = box;
  for (const type of path) {
    if (!cur) return null;
    cur = findBox(buf, cur.payloadStart, cur.payloadEnd, type);
  }
  return cur;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0").toUpperCase();
}

/**
 * Extract the video codec string from an avc1/avc3 sample entry.
 * `avc1.PPCCLL` = profile / constraint flags / level, read from the avcC box.
 */
function videoCodec(buf: Uint8Array, entry: Box): string | null {
  // VisualSampleEntry has a 78-byte fixed header before its child boxes.
  const avcC = findBox(buf, entry.payloadStart + 78, entry.payloadEnd, "avcC");
  if (!avcC || avcC.payloadStart + 4 > avcC.payloadEnd) return null;
  const profile = buf[avcC.payloadStart + 1];
  const compat = buf[avcC.payloadStart + 2];
  const level = buf[avcC.payloadStart + 3];
  return `${entry.type}.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
}

/** Read one MPEG-4 descriptor header (tag + variable-length size). */
function readDescriptor(
  buf: Uint8Array,
  pos: number,
  end: number,
): { tag: number; contentStart: number } | null {
  if (pos >= end) return null;
  const tag = buf[pos++];
  // Length is 1–4 bytes, 7 bits each, high bit = continue.
  for (let i = 0; i < 4; i++) {
    if (pos >= end) return null;
    const b = buf[pos++];
    if ((b & 0x80) === 0) break;
  }
  return { tag, contentStart: pos };
}

const ES_DESCR = 0x03;
const DECODER_CONFIG_DESCR = 0x04;
const DEC_SPECIFIC_INFO = 0x05;

/**
 * Extract the audio codec string from an mp4a sample entry via its esds box.
 * Returns `mp4a.OO.A` (object-type-indication / audio-object-type), e.g.
 * "mp4a.40.2" for AAC-LC. Falls back to null on any malformed structure.
 */
function audioCodec(buf: Uint8Array, entry: Box): string | null {
  // AudioSampleEntry has a 28-byte fixed header before its child boxes.
  const esds = findBox(buf, entry.payloadStart + 28, entry.payloadEnd, "esds");
  if (!esds) return null;
  const end = esds.payloadEnd;
  let pos = esds.payloadStart + 4; // skip FullBox version + flags

  const es = readDescriptor(buf, pos, end);
  if (!es || es.tag !== ES_DESCR) return null;
  // ES_Descriptor: ES_ID (2) + flags (1). We assume no dependency/URL/OCR
  // fields (flags 0), which is what ffmpeg emits for AAC.
  pos = es.contentStart + 3;

  const dc = readDescriptor(buf, pos, end);
  if (!dc || dc.tag !== DECODER_CONFIG_DESCR) return null;
  const oti = buf[dc.contentStart];
  // objectTypeIndication (1) + streamType/bufferSize (4) + bitrates (8) = 13
  pos = dc.contentStart + 13;

  const dsi = readDescriptor(buf, pos, end);
  if (!dsi || dsi.tag !== DEC_SPECIFIC_INFO || dsi.contentStart >= end) {
    // No AudioSpecificConfig — declare the object type without the AOT suffix.
    return `mp4a.${hex2(oti)}`;
  }
  // AudioSpecificConfig: audioObjectType is the top 5 bits of the first byte.
  const aot = (buf[dsi.contentStart] >> 3) & 0x1f;
  return `mp4a.${hex2(oti)}.${aot}`;
}

/**
 * Parse an fMP4 initialization segment (ftyp + moov) and return the codec
 * string(s) it declares. Returns null if the moov box isn't fully present yet
 * (caller should read more bytes) or if no recognizable track is found.
 */
export function parseInitSegmentCodecs(buf: Uint8Array): CodecInfo | null {
  const moov = findBox(buf, 0, buf.length, "moov");
  if (!moov || moov.end > buf.length) return null; // not fully buffered yet

  let video: string | undefined;
  let audio: string | undefined;

  for (const trak of findBoxes(buf, moov.payloadStart, moov.payloadEnd, "trak")) {
    const stsd = descend(buf, trak, ["mdia", "minf", "stbl", "stsd"]);
    if (!stsd) continue;
    // stsd is a FullBox: version+flags (4) + entry_count (4), then sample entries.
    const entry = readBox(buf, stsd.payloadStart + 8, stsd.payloadEnd);
    if (!entry) continue;
    if (entry.type === "avc1" || entry.type === "avc3") {
      video = videoCodec(buf, entry) ?? video;
    } else if (entry.type === "mp4a") {
      audio = audioCodec(buf, entry) ?? "mp4a.40.2";
    }
  }

  const codecs = [video, audio].filter(Boolean);
  if (codecs.length === 0) return null;
  return { mime: `video/mp4; codecs="${codecs.join(", ")}"`, video, audio };
}
