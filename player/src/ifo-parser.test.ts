import { describe, test, expect } from "vitest";
import {
  parseMenuPgcs,
  parseTitlePgcs,
  buildTimeSectorMap,
  lookupCellForMs,
  mergeRanges,
  isSectorRangeLoaded,
  ENTRY_ID_ROOT_MENU,
  type CellRange,
} from "./ifo-parser";

describe("buildTimeSectorMap", () => {
  const cells: CellRange[] = [
    { firstSector: 100, lastSector: 199, durationMs: 60_000 },
    { firstSector: 200, lastSector: 299, durationMs: 30_000 },
    { firstSector: 300, lastSector: 399, durationMs: 90_000 },
  ];

  test("accumulates cell start times into a timeline", () => {
    expect(buildTimeSectorMap(cells)).toEqual([
      { startMs: 0, endMs: 60_000, firstSector: 100 },
      { startMs: 60_000, endMs: 90_000, firstSector: 200 },
      { startMs: 90_000, endMs: 180_000, firstSector: 300 },
    ]);
  });

  test("empty cells → empty map", () => {
    expect(buildTimeSectorMap([])).toEqual([]);
  });
});

describe("lookupCellForMs", () => {
  const map = buildTimeSectorMap([
    { firstSector: 100, lastSector: 199, durationMs: 60_000 },
    { firstSector: 200, lastSector: 299, durationMs: 30_000 },
    { firstSector: 300, lastSector: 399, durationMs: 90_000 },
  ]);

  test("finds the cell covering a time (snaps to cell start)", () => {
    expect(lookupCellForMs(map, 75_000)?.firstSector).toBe(200); // in 2nd cell
    expect(lookupCellForMs(map, 60_000)?.firstSector).toBe(200); // boundary → next cell
    expect(lookupCellForMs(map, 10_000)?.firstSector).toBe(100);
    expect(lookupCellForMs(map, 120_000)?.firstSector).toBe(300);
  });

  test("clamps below zero to the first cell and past the end to the last", () => {
    expect(lookupCellForMs(map, -5)?.firstSector).toBe(100);
    expect(lookupCellForMs(map, 999_999)?.firstSector).toBe(300);
  });

  test("empty map → null", () => {
    expect(lookupCellForMs([], 1000)).toBeNull();
  });
});

describe("parseTitlePgcs", () => {
  // Craft a minimal VTS IFO: VTS_PGCIT pointer at 0xCC → sector 1, one PGC with
  // two cells. Mirrors the real byte layout the parser walks.
  function buildTitleIfo(): ArrayBuffer {
    const buf = new ArrayBuffer(4096);
    const view = new DataView(buf);
    view.setUint32(204, 1, false); // VTS_PGCIT at sector 1 (byte 2048)
    const base = 2048;
    view.setUint16(base, 1, false); // nr_of_srp = 1
    const pgcStart = 16;
    view.setUint32(base + 8 + 4, pgcStart, false); // srp[0].pgc_start_byte
    const pgc = base + pgcStart;
    view.setUint8(pgc + 3, 2); // nr_of_cells = 2
    const cellPb = 236;
    view.setUint16(pgc + 232, cellPb, false); // cell_playback offset
    const writeCell = (i: number, durBytes: number[], first: number, last: number) => {
      const o = pgc + cellPb + i * 24;
      durBytes.forEach((b, k) => view.setUint8(o + 4 + k, b));
      view.setUint32(o + 8, first, false);
      view.setUint32(o + 20, last, false);
    };
    // 1 min (m=0x01) @ 30fps rate flag (0xC0), then 30s
    writeCell(0, [0x00, 0x01, 0x00, 0xc0], 500, 1499);
    writeCell(1, [0x00, 0x00, 0x30, 0xc0], 1500, 2999);
    return buf;
  }

  test("parses title PGC cells and durations", () => {
    const pgcs = parseTitlePgcs(buildTitleIfo());
    expect(pgcs).toHaveLength(1);
    expect(pgcs[0].firstSector).toBe(500);
    expect(pgcs[0].lastSector).toBe(2999);
    expect(pgcs[0].cells).toHaveLength(2);
    expect(pgcs[0].durationMs).toBe(90_000); // 60s + 30s
  });

  test("returns empty for a buffer with no VTS_PGCIT pointer", () => {
    expect(parseTitlePgcs(new ArrayBuffer(512))).toEqual([]);
  });
});

describe("mergeRanges", () => {
  test("returns empty for empty input", () => {
    expect(mergeRanges([])).toEqual([]);
  });

  test("returns single range unchanged", () => {
    expect(mergeRanges([{ firstSector: 10, lastSector: 20, durationMs: 0 }])).toEqual([
      { firstSector: 10, lastSector: 20, durationMs: 0 },
    ]);
  });

  test("merges overlapping ranges", () => {
    const result = mergeRanges([
      { firstSector: 0, lastSector: 10, durationMs: 100 },
      { firstSector: 5, lastSector: 15, durationMs: 100 },
    ]);
    expect(result).toEqual([{ firstSector: 0, lastSector: 15, durationMs: 200 }]);
  });

  test("merges adjacent ranges", () => {
    const result = mergeRanges([
      { firstSector: 0, lastSector: 10, durationMs: 100 },
      { firstSector: 11, lastSector: 20, durationMs: 100 },
    ]);
    expect(result).toEqual([{ firstSector: 0, lastSector: 20, durationMs: 200 }]);
  });

  test("keeps non-overlapping ranges separate", () => {
    const result = mergeRanges([
      { firstSector: 0, lastSector: 10, durationMs: 100 },
      { firstSector: 20, lastSector: 30, durationMs: 100 },
    ]);
    expect(result).toEqual([
      { firstSector: 0, lastSector: 10, durationMs: 100 },
      { firstSector: 20, lastSector: 30, durationMs: 100 },
    ]);
  });

  test("sorts unsorted input", () => {
    const result = mergeRanges([
      { firstSector: 20, lastSector: 30, durationMs: 100 },
      { firstSector: 0, lastSector: 10, durationMs: 100 },
    ]);
    expect(result).toEqual([
      { firstSector: 0, lastSector: 10, durationMs: 100 },
      { firstSector: 20, lastSector: 30, durationMs: 100 },
    ]);
  });

  test("merges multiple overlapping ranges into one", () => {
    const result = mergeRanges([
      { firstSector: 0, lastSector: 5, durationMs: 50 },
      { firstSector: 3, lastSector: 10, durationMs: 50 },
      { firstSector: 8, lastSector: 20, durationMs: 50 },
    ]);
    expect(result).toEqual([{ firstSector: 0, lastSector: 20, durationMs: 150 }]);
  });
});

describe("isSectorRangeLoaded", () => {
  const loaded: CellRange[] = [
    { firstSector: 0, lastSector: 100, durationMs: 0 },
    { firstSector: 200, lastSector: 300, durationMs: 0 },
  ];

  test("returns true when fully contained", () => {
    expect(isSectorRangeLoaded(10, 50, loaded)).toBe(true);
    expect(isSectorRangeLoaded(0, 100, loaded)).toBe(true);
    expect(isSectorRangeLoaded(200, 300, loaded)).toBe(true);
  });

  test("returns false when not covered", () => {
    expect(isSectorRangeLoaded(50, 150, loaded)).toBe(false);
    expect(isSectorRangeLoaded(101, 199, loaded)).toBe(false);
    expect(isSectorRangeLoaded(301, 400, loaded)).toBe(false);
  });

  test("returns false for empty loaded ranges", () => {
    expect(isSectorRangeLoaded(0, 10, [])).toBe(false);
  });
});

describe("parseMenuPgcs", () => {
  test("returns empty for buffer with no PGCI_UT", () => {
    // 256 bytes of zeros — pgci_ut sector pointer at offset 208 is 0
    const buf = new ArrayBuffer(256);
    expect(parseMenuPgcs(buf)).toEqual([]);
  });

  test("returns empty for truncated buffer", () => {
    const buf = new ArrayBuffer(100);
    expect(parseMenuPgcs(buf)).toEqual([]);
  });

  test("parses synthetic IFO with known structure", () => {
    // Build a minimal IFO with one PGC containing two cells.
    // Layout:
    //   Byte 208: vtsm_pgci_ut sector pointer → sector 1 (byte 2048)
    //   Byte 2048: pgci_ut_t { nr_of_lus: 1, ... }
    //   Byte 2056: pgci_lu { lang_code, lang_start → 8 }
    //   Byte 2056: pgcit_t at pgci_ut + lang_start(8)
    //     nr_of_srp: 1
    //   Byte 2064: pgci_srp { entry_id: 0x83, pgc_start → 16 }
    //   Byte 2072: pgc_t at pgcit + pgc_start(16)
    //     byte 3: nr_of_cells = 2
    //     byte 232-233: cell_playback_offset = 240
    //   Byte 2072+240: cell_playback[0] (24 bytes)
    //     offset 8: first_sector = 0
    //     offset 20: last_sector = 50
    //   Byte 2072+264: cell_playback[1] (24 bytes)
    //     offset 8: first_sector = 100
    //     offset 20: last_sector = 200

    const size = 4096;
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);

    // vtsm_pgci_ut at offset 208 → sector 1
    view.setUint32(208, 1, false);

    const pgciUtOff = 2048;

    // pgci_ut: nr_of_lus = 1
    view.setUint16(pgciUtOff, 1, false);

    // pgci_lu[0]: lang_start = 8 (relative to pgci_ut)
    view.setUint32(pgciUtOff + 8 + 4, 8, false);

    // pgcit at pgciUtOff + 8
    const pgcitOff = pgciUtOff + 8;
    // nr_of_srp = 1
    view.setUint16(pgcitOff, 1, false);

    // pgci_srp[0]: entry_id = 0x83, pgc_start = 16
    const srpOff = pgcitOff + 8;
    view.setUint8(srpOff, 0x83);
    view.setUint32(srpOff + 4, 16, false);

    // pgc at pgcitOff + 16
    const pgcOff = pgcitOff + 16;
    // nr_of_cells = 2
    view.setUint8(pgcOff + 3, 2);
    // cell_playback_offset = 240
    view.setUint16(pgcOff + 232, 240, false);

    // cell_playback[0]: first_sector=0, last_sector=50
    const cell0 = pgcOff + 240;
    view.setUint32(cell0 + 8, 0, false);
    view.setUint32(cell0 + 20, 50, false);

    // cell_playback[1]: first_sector=100, last_sector=200
    const cell1 = pgcOff + 264;
    view.setUint32(cell1 + 8, 100, false);
    view.setUint32(cell1 + 20, 200, false);

    const pgcs = parseMenuPgcs(buf);

    expect(pgcs).toHaveLength(1);
    expect(pgcs[0].entryId).toBe(ENTRY_ID_ROOT_MENU);
    expect(pgcs[0].cells).toEqual([
      { firstSector: 0, lastSector: 50, durationMs: 0 },
      { firstSector: 100, lastSector: 200, durationMs: 0 },
    ]);
  });
});
