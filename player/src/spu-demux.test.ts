import { describe, test, expect } from "vitest";
import { demuxSubpictures } from "./spu-demux";

/**
 * Build a minimal MPEG-2 PS fragment containing a private_stream_1 PES packet
 * with a subpicture payload.
 */
function buildPesPacket(opts: {
  substreamId: number;
  payload: number[];
  pts?: number;
}): Uint8Array {
  const { substreamId, payload, pts } = opts;
  const hasPts = pts !== undefined && pts > 0;

  // PES header: flags + optional PTS
  const ptsBytes = hasPts ? encodePts(pts) : [];
  const headerDataLength = ptsBytes.length;
  const pesFlags = hasPts ? 0x80 : 0x00; // PTS present flag

  // PES header extension: [flags1, flags2, headerDataLength, ...ptsBytes]
  const pesHeader = [0x80, pesFlags, headerDataLength, ...ptsBytes];

  // Payload: substream ID + actual data
  const fullPayload = [substreamId, ...payload];

  // PES packet: [start code] [stream_id=0xBD] [length]
  const pesLength = pesHeader.length + fullPayload.length;
  const packet = [
    0x00,
    0x00,
    0x01,
    0xbd, // start code + private_stream_1
    (pesLength >> 8) & 0xff,
    pesLength & 0xff, // PES length
    ...pesHeader,
    ...fullPayload,
  ];

  return new Uint8Array(packet);
}

/** Encode a 33-bit PTS into 5 bytes */
function encodePts(pts: number): number[] {
  return [
    0x21 | (((pts >> 30) & 0x07) << 1), // 0010 xxx1
    (pts >> 22) & 0xff,
    (((pts >> 15) & 0x7f) << 1) | 1,
    (pts >> 7) & 0xff,
    ((pts & 0x7f) << 1) | 1,
  ];
}

/** Concatenate Uint8Arrays */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

describe("demuxSubpictures", () => {
  test("extracts a single SPU packet from a PES stream", () => {
    // SPU header: 2 bytes size (total = 10), 2 bytes DCSQ offset
    const spuPayload = [0, 10, 0, 4, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
    const pes = buildPesPacket({
      substreamId: 0x20,
      payload: spuPayload,
      pts: 90000, // 1 second
    });

    const packets = demuxSubpictures(pes);
    expect(packets).toHaveLength(1);
    expect(packets[0].pts).toBe(90000);
    expect(packets[0].data).toHaveLength(10);
    expect(packets[0].data[0]).toBe(0);
    expect(packets[0].data[1]).toBe(10);
  });

  test("ignores non-subpicture substreams", () => {
    // Audio substream (0x80) should be ignored
    const spuPayload = [0, 6, 0, 4, 0xaa, 0xbb];
    const pes = buildPesPacket({
      substreamId: 0x80,
      payload: spuPayload,
    });

    const packets = demuxSubpictures(pes);
    expect(packets).toHaveLength(0);
  });

  test("filters by stream index", () => {
    const spu0 = buildPesPacket({
      substreamId: 0x20,
      payload: [0, 6, 0, 4, 0x11, 0x22],
      pts: 100,
    });
    const spu1 = buildPesPacket({
      substreamId: 0x21,
      payload: [0, 6, 0, 4, 0x33, 0x44],
      pts: 200,
    });

    const stream = concat(spu0, spu1);

    const packets0 = demuxSubpictures(stream, 0);
    expect(packets0).toHaveLength(1);
    expect(packets0[0].pts).toBe(100);

    const packets1 = demuxSubpictures(stream, 1);
    expect(packets1).toHaveLength(1);
    expect(packets1[0].pts).toBe(200);
  });

  test("reassembles multi-packet SPU", () => {
    // SPU total size = 12, split across 2 PES packets
    const part1 = buildPesPacket({
      substreamId: 0x20,
      payload: [0, 12, 0, 4, 0xaa, 0xbb], // first 6 bytes
      pts: 45000,
    });
    const part2 = buildPesPacket({
      substreamId: 0x20,
      payload: [0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22], // remaining 6 bytes
    });

    const stream = concat(part1, part2);
    const packets = demuxSubpictures(stream);
    expect(packets).toHaveLength(1);
    expect(packets[0].data).toHaveLength(12);
    expect(packets[0].pts).toBe(45000);
    // Verify reassembly: first byte should be size high byte
    expect(packets[0].data[0]).toBe(0);
    expect(packets[0].data[1]).toBe(12);
    expect(packets[0].data[6]).toBe(0xcc);
  });

  test("extracts multiple SPU packets", () => {
    const spu1 = buildPesPacket({
      substreamId: 0x20,
      payload: [0, 6, 0, 4, 0x11, 0x22],
      pts: 1000,
    });
    const spu2 = buildPesPacket({
      substreamId: 0x20,
      payload: [0, 6, 0, 4, 0x33, 0x44],
      pts: 2000,
    });

    const stream = concat(spu1, spu2);
    const packets = demuxSubpictures(stream);
    expect(packets).toHaveLength(2);
    expect(packets[0].pts).toBe(1000);
    expect(packets[1].pts).toBe(2000);
  });

  test("returns empty for data with no subpictures", () => {
    // A PES packet with video stream_id (0xE0), not private_stream_1
    const videoPacket = new Uint8Array([
      0x00, 0x00, 0x01, 0xe0, 0x00, 0x06, 0x80, 0x00, 0x00, 0xaa, 0xbb, 0xcc,
    ]);
    const packets = demuxSubpictures(videoPacket);
    expect(packets).toHaveLength(0);
  });

  test("returns empty for empty input", () => {
    expect(demuxSubpictures(new Uint8Array(0))).toHaveLength(0);
  });
});
