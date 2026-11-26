import * as fc from 'fast-check';
import {
  canonicalRow,
  diffSnapshots,
  snapshotRows
} from '@/rebuild/snapshot/table-snapshot';

describe('table snapshots', () => {
  it('canonicalizes column order, buffers and volatile columns', () => {
    expect(
      canonicalRow(
        { b: Buffer.from([1, 2]), a: 1, updated_at: '2026-01-01' },
        new Set(['updated_at'])
      )
    ).toBe('{"a":1,"b":"0x0102"}');
  });

  it('gives the same digest whatever the column order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-z]{1,5}$/),
          fc.oneof(fc.integer(), fc.string(), fc.constant(null))
        ),
        (row) => {
          const reversed = Object.fromEntries(Object.entries(row).reverse());
          expect(snapshotRows('t', [row], []).digest).toBe(
            snapshotRows('t', [reversed], []).digest
          );
        }
      )
    );
  });

  it('orders rows without a primary key by content', () => {
    const one = { v: 1 };
    const two = { v: 2 };
    expect(snapshotRows('t', [one, two], []).digest).toBe(
      snapshotRows('t', [two, one], []).digest
    );
  });

  it('matches rows by content when the primary key is volatile', () => {
    const volatile = new Set(['id']);
    const before = snapshotRows(
      't',
      [
        { id: 1, v: 'a' },
        { id: 2, v: 'b' }
      ],
      ['id'],
      volatile
    );
    // A rebuild that numbers the same rows anew, in another order.
    const renumbered = snapshotRows(
      't',
      [
        { id: 7, v: 'b' },
        { id: 8, v: 'a' }
      ],
      ['id'],
      volatile
    );
    expect(diffSnapshots(before, renumbered).same).toBe(true);
    const changed = snapshotRows(
      't',
      [
        { id: 7, v: 'b' },
        { id: 8, v: 'c' }
      ],
      ['id'],
      volatile
    );
    const diff = diffSnapshots(before, changed);
    expect(diff.same).toBe(false);
    expect(diff.missing).toHaveLength(1);
    expect(diff.extra).toHaveLength(1);
  });

  it('reports rows only before, only after and changed, by primary key', () => {
    const before = snapshotRows(
      't',
      [
        { id: 1, v: 'a' },
        { id: 2, v: 'b' },
        { id: 3, v: 'c' }
      ],
      ['id']
    );
    const after = snapshotRows(
      't',
      [
        { id: 2, v: 'b' },
        { id: 3, v: 'changed' },
        { id: 4, v: 'd' }
      ],
      ['id']
    );
    expect(diffSnapshots(before, after)).toEqual({
      table: 't',
      rowsBefore: 3,
      rowsAfter: 3,
      same: false,
      missing: ['[1]'],
      extra: ['[4]'],
      changed: ['[3]']
    });
    expect(diffSnapshots(before, before).same).toBe(true);
  });
});
