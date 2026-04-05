/**
 * spu-demux.ts — Extract DVD subpicture (SPU) packets from MPEG-2 Program Stream data.
 *
 * DVD VOB files are MPEG-2 PS containers with interleaved video, audio, and
 * subpicture streams. Subpictures are carried in private_stream_1 (stream_id 0xBD)
 * with substream IDs 0x20–0x3F. An SPU unit may span multiple PES packets;
 * the first two bytes of the SPU declare its total size.
 */

export interface SpuPacket {
  /** Presentation timestamp in 90kHz clock ticks (from PES header) */
  pts: number;
  /** Reassembled SPU data (header + pixel data + control sequences) */
  data: Uint8Array;
}

/**
 * Demux subpicture packets from raw MPEG-2 PS (VOB) data.
 *
 * @param vobData  Raw VOB bytes (may be a sector range slice)
 * @param streamIndex  Subpicture stream index (0 = substream 0x20, 1 = 0x21, etc.). Defaults to 0.
 * @returns Array of fully reassembled SPU packets
 */
export function demuxSubpictures(vobData: Uint8Array, streamIndex = 0): SpuPacket[] {
  const targetSubstream = 0x20 + streamIndex;
  const packets: SpuPacket[] = [];

  // Partial SPU accumulation state
  let accum: Uint8Array | null = null;
  let accumOffset = 0;
  let accumPts = 0;
  let expectedSize = 0;

  let pos = 0;
  const len = vobData.length;

  while (pos < len - 3) {
    // Scan for start code prefix: 00 00 01
    if (vobData[pos] !== 0x00 || vobData[pos + 1] !== 0x00 || vobData[pos + 2] !== 0x01) {
      pos++;
      continue;
    }

    const startCodeByte = vobData[pos + 3];

    // Pack header (0xBA) — skip it
    if (startCodeByte === 0xba) {
      // MPEG-2 pack header is 14 bytes total
      pos += 14;
      // Skip any stuffing bytes
      if (pos <= len) {
        const stuffing = vobData[pos - 1] & 0x07;
        pos += stuffing;
      }
      continue;
    }

    // System header (0xBB) or other non-PES — skip by reading length
    if (startCodeByte !== 0xbd) {
      // Not private_stream_1 — skip this PES packet
      if (pos + 5 >= len) break;
      const pesLen = (vobData[pos + 4] << 8) | vobData[pos + 5];
      pos += 6 + pesLen;
      continue;
    }

    // private_stream_1 (0xBD) — may contain subpicture data
    if (pos + 5 >= len) break;
    const pesLength = (vobData[pos + 4] << 8) | vobData[pos + 5];
    const pesStart = pos + 6;
    const pesEnd = pesStart + pesLength;

    if (pesEnd > len) break;

    // Parse PES header to extract PTS and find payload start
    const pesFlags = vobData[pesStart + 1];
    const ptsFlag = (pesFlags & 0x80) !== 0;
    const headerDataLength = vobData[pesStart + 2];
    const payloadStart = pesStart + 3 + headerDataLength;

    let pts = 0;
    if (ptsFlag && pesStart + 7 <= len) {
      pts = parsePts(vobData, pesStart + 3);
    }

    if (payloadStart >= pesEnd) {
      pos = pesEnd;
      continue;
    }

    // First byte of payload is substream ID
    const substreamId = vobData[payloadStart];
    if (substreamId !== targetSubstream) {
      pos = pesEnd;
      continue;
    }

    // SPU payload starts after the substream ID byte
    const spuPayload = vobData.subarray(payloadStart + 1, pesEnd);

    if (accum === null) {
      // Start of a new SPU unit — first two bytes are total size
      if (spuPayload.length < 2) {
        pos = pesEnd;
        continue;
      }
      expectedSize = (spuPayload[0] << 8) | spuPayload[1];
      if (expectedSize < 4) {
        pos = pesEnd;
        continue;
      }
      accum = new Uint8Array(expectedSize);
      accumOffset = 0;
      accumPts = pts;
    }

    // Copy payload into accumulation buffer
    const copyLen = Math.min(spuPayload.length, expectedSize - accumOffset);
    accum.set(spuPayload.subarray(0, copyLen), accumOffset);
    accumOffset += copyLen;

    // Check if SPU is complete
    if (accumOffset >= expectedSize) {
      packets.push({ pts: accumPts, data: accum });
      accum = null;
      accumOffset = 0;
      expectedSize = 0;
    }

    pos = pesEnd;
  }

  return packets;
}

/**
 * Parse a 33-bit PTS from a PES header.
 * Layout: [0010 xxx1] [xxxx xxxx] [xxxx xxx1] [xxxx xxxx] [xxxx xxx1]
 */
function parsePts(data: Uint8Array, offset: number): number {
  const byte0 = data[offset];
  const byte1 = data[offset + 1];
  const byte2 = data[offset + 2];
  const byte3 = data[offset + 3];
  const byte4 = data[offset + 4];

  // Extract 33-bit PTS (safe within JS number precision)
  const pts =
    ((byte0 >> 1) & 0x07) * 0x40000000 + // bits 32-30
    (byte1 << 22) + // bits 29-22
    ((byte2 >> 1) << 15) + // bits 21-15
    (byte3 << 7) + // bits 14-7
    (byte4 >> 1); // bits 6-0

  return pts;
}
