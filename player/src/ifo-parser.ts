/**
 * Minimal IFO parser — extracts menu cell sector ranges from PGCI_UT.
 *
 * DVD IFO files use big-endian byte order throughout.
 * Only parses the structures needed to find menu cell playback sectors:
 *   vtsi_mat → pgci_ut → pgci_lu → pgcit → pgci_srp → pgc → cell_playback
 */

export interface CellRange {
  firstSector: number;
  lastSector: number;
}

export interface PgcCells {
  /** PGC entry ID: 0x83=root, 0x84=subpicture, 0x85=audio, 0x86=angle, 0x87=chapter */
  entryId: number;
  /** Merged cell sector ranges for this PGC */
  cells: CellRange[];
}

/** Byte offset of vtsm_pgci_ut (sector pointer) in vtsi_mat_t */
const VTSM_PGCI_UT_OFFSET = 208;

/** Root menu entry ID — loaded first when entering a VTS menu domain */
export const ENTRY_ID_ROOT_MENU = 0x83;

/**
 * Parse menu PGCs from a VTS IFO file, returning per-PGC cell sector ranges.
 * Returns empty array if no menu PGCI_UT exists.
 */
export function parseMenuPgcs(ifoData: ArrayBuffer): PgcCells[] {
  if (ifoData.byteLength < VTSM_PGCI_UT_OFFSET + 4) return [];
  const view = new DataView(ifoData);

  const pgciUtSector = view.getUint32(VTSM_PGCI_UT_OFFSET, false);
  if (pgciUtSector === 0) return [];

  const pgciUtOffset = pgciUtSector * 2048;
  if (pgciUtOffset >= ifoData.byteLength) return [];

  const pgcs: PgcCells[] = [];

  const nrOfLus = view.getUint16(pgciUtOffset, false);

  for (let lu = 0; lu < nrOfLus; lu++) {
    const luOffset = pgciUtOffset + 8 + lu * 8;
    const langStart = view.getUint32(luOffset + 4, false);

    const pgcitOffset = pgciUtOffset + langStart;
    if (pgcitOffset >= ifoData.byteLength) continue;

    const nrOfSrp = view.getUint16(pgcitOffset, false);

    for (let s = 0; s < nrOfSrp; s++) {
      const srpOffset = pgcitOffset + 8 + s * 8;
      const entryId = view.getUint8(srpOffset);
      const pgcStart = view.getUint32(srpOffset + 4, false);

      const pgcOffset = pgcitOffset + pgcStart;
      if (pgcOffset >= ifoData.byteLength) continue;

      const nrOfCells = view.getUint8(pgcOffset + 3);
      if (nrOfCells === 0) continue;

      const cellPbOffset = view.getUint16(pgcOffset + 232, false);
      if (cellPbOffset === 0) continue;

      const ranges: CellRange[] = [];
      for (let c = 0; c < nrOfCells; c++) {
        const cellOffset = pgcOffset + cellPbOffset + c * 24;
        if (cellOffset + 24 > ifoData.byteLength) break;

        const firstSector = view.getUint32(cellOffset + 8, false);
        const lastSector = view.getUint32(cellOffset + 20, false);
        ranges.push({ firstSector, lastSector });
      }

      if (ranges.length > 0) {
        pgcs.push({ entryId, cells: mergeRanges(ranges) });
      }
    }
  }

  return pgcs;
}

/**
 * Check whether a sector range is covered by any of the given loaded ranges.
 */
export function isSectorRangeLoaded(
  firstSector: number,
  lastSector: number,
  loadedRanges: CellRange[],
): boolean {
  return loadedRanges.some(
    (r) => firstSector >= r.firstSector && lastSector <= r.lastSector,
  );
}

/** Merge overlapping/adjacent sector ranges into minimal set. */
export function mergeRanges(ranges: CellRange[]): CellRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.firstSector - b.firstSector);

  const merged: CellRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.firstSector <= prev.lastSector + 1) {
      prev.lastSector = Math.max(prev.lastSector, curr.lastSector);
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}
