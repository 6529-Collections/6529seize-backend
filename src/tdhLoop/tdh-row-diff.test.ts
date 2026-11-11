import { EntityMetadata } from 'typeorm';
import {
  canonicalJson,
  PartialTableWrite,
  RowDiffColumns,
  rowsToWrite,
  RowWrites,
  snapshotRows,
  storedJson
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
  tableName: 'rows',
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

/** Nothing in scope, unless given. */
function write(
  extra: Partial<PartialTableWrite> = {},
  diffColumns?: RowDiffColumns
): PartialTableWrite {
  return { columns: diffColumns, inScope: () => false, ...extra };
}

function writes(
  stored: object[],
  computed: object[],
  how: PartialTableWrite = write()
): RowWrites<object> {
  return rowsToWrite(
    metadata,
    computed,
    snapshotRows(metadata, stored, how.columns),
    how
  );
}

/** Whether `computed` is upserted over `stored`. */
function written(stored: object, computed: object): boolean {
  return writes([stored], [computed]).upserts.length === 1;
}

describe('partial TDH writes: what counts as unchanged', () => {
  it('skips a row stored as computed, whatever the JSON key order', () => {
    expect(
      writes(
        [base],
        [{ ...base, ranks: [{ rank: 3, id: 1 }], date: new Date(base.date) }]
      )
    ).toEqual({ upserts: [], refreshes: [], deletes: [] });
  });

  it('compares integer columns as MySQL rounds a written number, half away from zero', () => {
    expect(written({ ...base, tdh: 12 }, { ...base, tdh: 12.4 })).toBe(false);
    expect(written({ ...base, tdh: 13 }, { ...base, tdh: 12.5 })).toBe(false);
    expect(written({ ...base, tdh: -13 }, { ...base, tdh: -12.5 })).toBe(false);
    expect(written({ ...base, tdh: 12 }, { ...base, tdh: 12.5 })).toBe(true);
    expect(written({ ...base, tdh: 12 }, { ...base, tdh: 12.6 })).toBe(true);
  });

  it('compares a stored bigint read as text with its computed number', () => {
    expect(written({ ...base, tdh: '12' }, base)).toBe(false);
    expect(written({ ...base, season: '1' }, base)).toBe(false);
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
    expect(written(base, { ...base, ranks: [{ id: '1', rank: 3 }] })).toBe(
      true
    );
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
    // Even when the stored value has the same fraction (not from datetime(0)).
    const fraction = new Date('2026-11-09T23:59:59.400Z');
    expect(
      written({ ...base, date: fraction }, { ...base, date: fraction })
    ).toBe(true);
    expect(written({ ...base, ranks: '{not json' }, base)).toBe(true);
  });

  it('writes a new row', () => {
    const added = { ...base, season: 2 };
    expect(writes([base], [added]).upserts).toEqual([added]);
  });

  it('compares rows in scope too, deleting the stored ones that changed or are gone', () => {
    const inScope = write({
      inScope: (key) => key('wallet') === '0xabc'
    });
    const other = { ...base, wallet: '0xdef' };
    const season2 = { ...base, season: 2 };

    // Unchanged: nothing to do.
    expect(writes([base, season2, other], [base, season2], inScope)).toEqual({
      upserts: [],
      refreshes: [],
      deletes: []
    });
    // Changed: deleted, then written again in full.
    const changed = { ...base, tdh: 13 };
    expect(writes([base, other], [changed, other], inScope)).toEqual({
      upserts: [changed],
      refreshes: [],
      deletes: [['0xabc', 1]]
    });
    // Gone from the computed rows: deleted; outside the scope: left alone.
    expect(writes([base, season2, other], [base], inScope)).toEqual({
      upserts: [],
      refreshes: [],
      deletes: [['0xabc', 2]]
    });
  });

  it('keeps the snapshot as it was when the same objects change afterwards', () => {
    // Ranking updates the snapshot's own objects in place.
    const row = { ...base, ranks: [{ id: 1, rank: 3 }] };
    const stored = snapshotRows(metadata, [row]);
    row.ranks[0].rank = 5;

    expect(rowsToWrite(metadata, [row], stored, write()).upserts).toEqual([
      row
    ]);
  });

  it('does not compare a column the transaction sets again for every row', () => {
    const recomputed = write({}, { recomputed: ['rate'] });
    expect(writes([base], [{ ...base, rate: 0 }], recomputed)).toEqual({
      upserts: [],
      refreshes: [],
      deletes: []
    });
    const changed = { ...base, rate: 0, tdh: 13 };
    expect(writes([base], [changed], recomputed).upserts).toEqual([changed]);
  });

  it('refreshes only the refreshed column of a row that differs nowhere else', () => {
    const refreshed = write({}, { refreshed: 'date' });
    const later = { ...base, date: new Date('2026-11-10T04:34:11.500Z') };
    expect(writes([base], [later], refreshed)).toEqual({
      upserts: [],
      refreshes: [later],
      deletes: []
    });
    const changed = { ...later, boost: 1.3 };
    expect(writes([base], [changed], refreshed).upserts).toEqual([changed]);
    expect(writes([base], [{ ...base }], refreshed)).toEqual({
      upserts: [],
      refreshes: [],
      deletes: []
    });
    // A key matched in another case is written in full, never refreshed: the
    // refresh joins on the exact key text.
    const recased = { ...later, wallet: '0xABC' };
    expect(writes([base], [recased], refreshed)).toEqual({
      upserts: [recased],
      refreshes: [],
      deletes: []
    });
    // A row in scope, otherwise unchanged, is refreshed, not deleted.
    expect(
      writes(
        [base],
        [later],
        write({ inScope: () => true }, { refreshed: 'date' })
      )
    ).toEqual({ upserts: [], refreshes: [later], deletes: [] });
    const added = { ...later, season: 2 };
    expect(writes([base], [added], refreshed).upserts).toEqual([added]);
  });

  it('rejects key or unknown columns, and stored rows read for other columns', () => {
    expect(() =>
      writes([base], [base], write({}, { refreshed: 'wallet' }))
    ).toThrow();
    expect(() =>
      writes([base], [base], write({}, { recomputed: ['season'] }))
    ).toThrow();
    expect(() =>
      writes([base], [base], write({}, { refreshed: 'missing' }))
    ).toThrow();
    expect(() =>
      rowsToWrite(
        metadata,
        [base],
        snapshotRows(metadata, [base]),
        write({}, { refreshed: 'date' })
      )
    ).toThrow();
  });
});

describe('JSON as MySQL stores it', () => {
  /** `stored` as MySQL reads it back: its keys in MySQL's order. */
  const same = (computed: unknown, stored: unknown) =>
    canonicalJson(computed) === storedJson(stored);

  it('matches a computed value with what MySQL reads back for it', () => {
    // MySQL orders keys by length, then bytewise.
    expect(same({ rank: 3, id: 1 }, { id: 1, rank: 3 })).toBe(true);
    expect(
      same(
        { total: 1, memes_card_sets: { b: 2, a: 1 } },
        {
          total: 1,
          memes_card_sets: { a: 1, b: 2 }
        }
      )
    ).toBe(true);
    expect(same({ a: 1, b: undefined, c: () => 1 }, { a: 1 })).toBe(true);
    expect(same([undefined, () => 1], [null, null])).toBe(true);
    expect(same({ a: Number.NaN, b: Infinity }, { a: null, b: null })).toBe(
      true
    );
    expect(same({ at: new Date(0) }, { at: '1970-01-01T00:00:00.000Z' })).toBe(
      true
    );
    expect(same(-0, 0)).toBe(true);
    // JSON.parse puts index-like keys first.
    expect(same({ a: 1, '10': 2 }, JSON.parse('{"a": 1, "10": 2}'))).toBe(true);
  });

  it('tells apart values that differ', () => {
    expect(same({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(same({ a: 1 }, { a: '1' })).toBe(false);
    expect(same([1, 2], [2, 1])).toBe(false);
    expect(same({}, [])).toBe(false);
    expect(same(true, 'true')).toBe(false);
    expect(same(27.900000000000002, 27.9)).toBe(false);
    expect(same({ a: BigInt(1) }, { a: 1 })).toBe(false);
  });

  it('counts a stored object out of MySQL order as changed, never the reverse', () => {
    expect(same({ b: 2, ab: 1 }, { ab: 1, b: 2 })).toBe(false);
    expect(
      written(
        { ...base, ranks: { ab: 1, b: 2 } },
        { ...base, ranks: { ab: 1, b: 2 } }
      )
    ).toBe(true);
  });
});
