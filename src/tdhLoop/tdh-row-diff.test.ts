import { EntityMetadata } from 'typeorm';
import {
  RowDiffColumns,
  rowsToWrite,
  RowWrites,
  snapshotRows
} from '@/tdhLoop/tdh-row-diff';

type Column = {
  propertyName: string;
  databaseName: string;
  type: string;
  isNullable: boolean;
  default: unknown;
  embeddedMetadata: undefined;
  getEntityValue: (row: Record<string, unknown>) => unknown;
};

function column(
  name: string,
  type: string,
  extra: Partial<Column> = {}
): Column {
  return {
    propertyName: name,
    databaseName: name,
    type,
    isNullable: false,
    default: undefined,
    embeddedMetadata: undefined,
    getEntityValue: (row) => row[name],
    ...extra
  };
}

const columns = [
  column('wallet', 'varchar'),
  column('season', 'int'),
  column('tdh', 'int'),
  column('boost', 'double'),
  column('date', 'datetime'),
  column('ranks', 'json', { isNullable: true }),
  column('rate', 'double', { isNullable: true, default: 0 })
];
const metadata = {
  columns,
  primaryColumns: [columns[0], columns[1]]
} as unknown as EntityMetadata;

const base = {
  wallet: '0xabc',
  season: 1,
  tdh: 12,
  boost: 1.25,
  date: new Date('2026-11-09T23:59:59Z'),
  ranks: [{ id: 1, rank: 3 }],
  rate: 0.5
};

function writes(
  stored: object,
  computed: object,
  columns?: RowDiffColumns
): RowWrites<object> {
  return rowsToWrite(
    metadata,
    [computed],
    snapshotRows(metadata, [stored]),
    () => false,
    columns
  );
}

/** Whether `computed` is written over `stored`, outside the delete scope. */
function written(stored: object, computed: object): boolean {
  return writes(stored, computed).upserts.length === 1;
}

describe('partial TDH writes: what counts as unchanged', () => {
  it('skips a row stored as computed, whatever the JSON key order', () => {
    expect(
      written(base, {
        ...base,
        ranks: [{ rank: 3, id: 1 }],
        date: new Date(base.date)
      })
    ).toBe(false);
  });

  it('compares integer columns as MySQL rounds a written number, half away from zero', () => {
    expect(written({ ...base, tdh: 12 }, { ...base, tdh: 12.4 })).toBe(false);
    expect(written({ ...base, tdh: 13 }, { ...base, tdh: 12.5 })).toBe(false);
    expect(written({ ...base, tdh: -13 }, { ...base, tdh: -12.5 })).toBe(false);
    expect(written({ ...base, tdh: 12 }, { ...base, tdh: 12.5 })).toBe(true);
    expect(written({ ...base, tdh: 12 }, { ...base, tdh: 12.6 })).toBe(true);
  });

  it('writes any changed value, including one inside the JSON', () => {
    expect(written(base, { ...base, boost: 1.2500001 })).toBe(true);
    expect(written(base, { ...base, ranks: [{ id: 1, rank: 4 }] })).toBe(true);
    expect(
      written(base, { ...base, ranks: [{ id: 1, rank: 3, extra: 1 }] })
    ).toBe(true);
    expect(
      written({ ...base, ranks: [{ id: 1, rank: 3, extra: 1 }] }, base)
    ).toBe(true);
    expect(written(base, { ...base, ranks: [] })).toBe(true);
    // A key's exact case is stored, though MySQL matches it either way.
    expect(written(base, { ...base, wallet: '0xABC' })).toBe(true);
  });

  it('writes a row whose stored form it cannot know', () => {
    // datetime(0) rounds fractional seconds.
    expect(
      written(base, { ...base, date: new Date('2026-11-09T23:59:59.400Z') })
    ).toBe(true);
    // Undefined is written as DEFAULT: known only for a nullable column
    // without one.
    expect(written({ ...base, rate: 0 }, { ...base, rate: undefined })).toBe(
      true
    );
    expect(written({ ...base, rate: null }, { ...base, rate: undefined })).toBe(
      true
    );
    expect(
      written({ ...base, ranks: null }, { ...base, ranks: undefined })
    ).toBe(false);
    expect(written(base, { ...base, tdh: Number.NaN })).toBe(true);
  });

  it('writes a new row, and always one in the delete scope', () => {
    expect(written(base, { ...base, season: 2 })).toBe(true);
    expect(
      rowsToWrite(metadata, [base], snapshotRows(metadata, [base]), () => true)
        .upserts
    ).toHaveLength(1);
  });

  it('keeps the snapshot as it was when the same objects change afterwards', () => {
    // Ranking updates the snapshot's own objects in place.
    const row = { ...base, ranks: [{ id: 1, rank: 3 }] };
    const stored = snapshotRows(metadata, [row]);
    row.ranks[0].rank = 5;

    expect(rowsToWrite(metadata, [row], stored, () => false).upserts).toEqual([
      row
    ]);
  });

  it('does not compare a column the transaction sets again for every row', () => {
    const recomputed: RowDiffColumns = { recomputed: ['rate'] };
    expect(writes(base, { ...base, rate: 0 }, recomputed)).toEqual({
      upserts: [],
      refreshes: []
    });
    const changed = { ...base, rate: 0, tdh: 13 };
    expect(writes(base, changed, recomputed).upserts).toEqual([changed]);
  });

  it('refreshes only the refreshed column of a row that differs nowhere else', () => {
    const refreshed: RowDiffColumns = { refreshed: 'date' };
    const later = { ...base, date: new Date('2026-11-10T04:34:11.500Z') };
    expect(writes(base, later, refreshed)).toEqual({
      upserts: [],
      refreshes: [later]
    });
    const changed = { ...later, boost: 1.3 };
    expect(writes(base, changed, refreshed)).toEqual({
      upserts: [changed],
      refreshes: []
    });
    expect(writes(base, { ...base }, refreshed)).toEqual({
      upserts: [],
      refreshes: []
    });
    // In the delete scope or new: written in full.
    expect(
      rowsToWrite(
        metadata,
        [later],
        snapshotRows(metadata, [base]),
        () => true,
        refreshed
      ).upserts
    ).toEqual([later]);
    const added = { ...later, season: 2 };
    expect(writes(base, added, refreshed).upserts).toEqual([added]);
  });

  it('rejects key or unknown columns as recomputed or refreshed', () => {
    expect(() => writes(base, base, { refreshed: 'wallet' })).toThrow();
    expect(() => writes(base, base, { recomputed: ['season'] })).toThrow();
    expect(() => writes(base, base, { refreshed: 'missing' })).toThrow();
  });
});
