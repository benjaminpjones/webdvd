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
  /** Cell playback duration in milliseconds (from IFO BCD playback_time) */
  durationMs: number;
}

export interface PgcCells {
  /** PGC entry ID: 0x83=root, 0x84=subpicture, 0x85=audio, 0x86=angle, 0x87=chapter */
  entryId: number;
  /** Merged cell sector ranges for this PGC */
  cells: CellRange[];
  /** Original (unmerged) cell ranges with individual durations */
  rawCells: CellRange[];
}

/** Parse BCD-encoded DVD playback_time (4 bytes) to milliseconds. */
function parseDvdTime(view: DataView, offset: number): number {
  const h = bcd(view.getUint8(offset));
  const m = bcd(view.getUint8(offset + 1));
  const s = bcd(view.getUint8(offset + 2));
  const frameByte = view.getUint8(offset + 3);
  const frames = bcd(frameByte & 0x3f);
  const rateFlag = (frameByte >> 6) & 0x03;
  const fps = rateFlag === 3 ? 30 : rateFlag === 1 ? 25 : 30; // 0x03=29.97, 0x01=25
  return (h * 3600 + m * 60 + s) * 1000 + Math.round((frames / fps) * 1000);
}

function bcd(b: number): number {
  return ((b >> 4) & 0x0f) * 10 + (b & 0x0f);
}

/** Byte offset of vtsm_pgci_ut (menu PGC table sector pointer) in vtsi_mat_t */
const VTSM_PGCI_UT_OFFSET = 208;

/** Byte offset of vts_pgcit (title PGC table sector pointer) in vtsi_mat_t */
const VTS_PGCIT_OFFSET = 204;

/** Read a PGC's cell_playback table (firstSector/lastSector/durationMs per cell). */
function readPgcCells(view: DataView, byteLength: number, pgcOffset: number): CellRange[] {
  const nrOfCells = view.getUint8(pgcOffset + 3);
  if (nrOfCells === 0) return [];

  const cellPbOffset = view.getUint16(pgcOffset + 232, false);
  if (cellPbOffset === 0) return [];

  const ranges: CellRange[] = [];
  for (let c = 0; c < nrOfCells; c++) {
    const cellOffset = pgcOffset + cellPbOffset + c * 24;
    if (cellOffset + 24 > byteLength) break;

    const durationMs = parseDvdTime(view, cellOffset + 4);
    const firstSector = view.getUint32(cellOffset + 8, false);
    const lastSector = view.getUint32(cellOffset + 20, false);
    ranges.push({ firstSector, lastSector, durationMs });
  }
  return ranges;
}

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

      const ranges = readPgcCells(view, ifoData.byteLength, pgcOffset);
      if (ranges.length > 0) {
        pgcs.push({ entryId, cells: mergeRanges(ranges), rawCells: ranges });
      }
    }
  }

  return pgcs;
}

export interface TitlePgc {
  /** VOB-absolute first sector of the PGC's first cell. */
  firstSector: number;
  /** VOB-absolute last sector of the PGC's last cell. */
  lastSector: number;
  /** Total PGC playback time in ms (sum of cell durations). */
  durationMs: number;
  /** Cells in playback order (NOT merged — order defines the timeline). */
  cells: CellRange[];
}

/**
 * Parse the title PGCs (VTS_PGCIT) from a VTS IFO, returning each PGC's ordered
 * cell list. Unlike the menu table this is a direct PGCIT (no language-unit
 * layer). Used to build a time→sector map for seeking within a title.
 */
export function parseTitlePgcs(ifoData: ArrayBuffer): TitlePgc[] {
  if (ifoData.byteLength < VTS_PGCIT_OFFSET + 4) return [];
  const view = new DataView(ifoData);

  const pgcitSector = view.getUint32(VTS_PGCIT_OFFSET, false);
  if (pgcitSector === 0) return [];

  const base = pgcitSector * 2048;
  if (base + 8 > ifoData.byteLength) return [];

  const nrOfSrp = view.getUint16(base, false);
  const out: TitlePgc[] = [];

  for (let s = 0; s < nrOfSrp; s++) {
    const srpOffset = base + 8 + s * 8;
    if (srpOffset + 8 > ifoData.byteLength) break;

    const pgcStart = view.getUint32(srpOffset + 4, false);
    const pgcOffset = base + pgcStart;
    if (pgcOffset + 236 > ifoData.byteLength) continue;

    const cells = readPgcCells(view, ifoData.byteLength, pgcOffset);
    if (cells.length === 0) continue;

    const durationMs = cells.reduce((sum, c) => sum + c.durationMs, 0);
    out.push({
      firstSector: cells[0].firstSector,
      lastSector: cells[cells.length - 1].lastSector,
      durationMs,
      cells,
    });
  }

  return out;
}

/** One entry of a title's time→sector map: cell [startMs, endMs) → firstSector. */
export interface TimeSectorEntry {
  startMs: number;
  endMs: number;
  firstSector: number;
}

/** Build a cumulative time→sector map from a PGC's ordered cells. */
export function buildTimeSectorMap(cells: CellRange[]): TimeSectorEntry[] {
  const map: TimeSectorEntry[] = [];
  let t = 0;
  for (const c of cells) {
    map.push({ startMs: t, endMs: t + c.durationMs, firstSector: c.firstSector });
    t += c.durationMs;
  }
  return map;
}

/**
 * Find the cell covering `ms` in a time→sector map. Seeking lands at that
 * cell's start (its `firstSector` / `startMs`) — the nearest VOBU-aligned
 * boundary at or before the requested time. Clamps to the ends of the map.
 */
export function lookupCellForMs(map: TimeSectorEntry[], ms: number): TimeSectorEntry | null {
  if (map.length === 0) return null;
  if (ms <= 0) return map[0];
  for (const entry of map) {
    if (ms >= entry.startMs && ms < entry.endMs) return entry;
  }
  return map[map.length - 1];
}

/**
 * Check whether a sector range is covered by any of the given loaded ranges.
 */
export function isSectorRangeLoaded(
  firstSector: number,
  lastSector: number,
  loadedRanges: CellRange[],
): boolean {
  return loadedRanges.some((r) => firstSector >= r.firstSector && lastSector <= r.lastSector);
}

/** Merge overlapping/adjacent sector ranges into minimal set. */
export function mergeRanges(ranges: CellRange[]): CellRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.firstSector - b.firstSector);

  const merged: CellRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.firstSector <= prev.lastSector + 1) {
      prev.lastSector = Math.max(prev.lastSector, curr.lastSector);
      prev.durationMs += curr.durationMs;
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}
