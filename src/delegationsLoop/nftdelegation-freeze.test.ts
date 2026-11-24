import * as fc from 'fast-check';
import {
  findLastBlockBefore,
  readNftDelegationFreeze,
  resolveFreezeBlock,
  splitAtFreeze
} from './nftdelegation-freeze';

const T = Date.UTC(2026, 10, 24) / 1000;

describe('readNftDelegationFreeze', () => {
  it('is off when neither setting is there', () => {
    expect(readNftDelegationFreeze({})).toEqual({ kind: 'NONE' });
    expect(
      readNftDelegationFreeze({
        NFTDELEGATION_FREEZE_BLOCK: ' ',
        IDENTITY_FREEZE_AT: ''
      })
    ).toEqual({ kind: 'NONE' });
  });

  it('reads the freeze block, which wins over the time', () => {
    expect(
      readNftDelegationFreeze({
        NFTDELEGATION_FREEZE_BLOCK: '24000000',
        IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z'
      })
    ).toEqual({ kind: 'BLOCK', block: 24_000_000 });
  });

  it.each([
    ['2026-11-24T00:00:00Z', T],
    ['2026-11-24T00:00:00.000Z', T],
    ['2026-11-24T00:00:00+00:00', T],
    [String(T * 1000), T],
    [String(T * 1000 + 1), T + 1]
  ])('reads IDENTITY_FREEZE_AT=%s', (raw, atSeconds) => {
    expect(readNftDelegationFreeze({ IDENTITY_FREEZE_AT: raw })).toEqual({
      kind: 'TIME',
      atSeconds
    });
  });

  it.each(['0', '-5', '12.5', 'abc', '1e7'])(
    'stops on a freeze block of %s',
    (raw) => {
      expect(() =>
        readNftDelegationFreeze({ NFTDELEGATION_FREEZE_BLOCK: raw })
      ).toThrow('NFTDELEGATION_FREEZE_BLOCK');
    }
  );

  it.each(['2026-11-24 00:00', '2026-11-24T00:00:00', 'tomorrow'])(
    'stops on a freeze time of %s',
    (raw) => {
      expect(() =>
        readNftDelegationFreeze({ IDENTITY_FREEZE_AT: raw })
      ).toThrow('IDENTITY_FREEZE_AT');
    }
  );
});

/** A chain whose block b is stamped stamps[b]. */
function chain(stamps: number[]) {
  const reads: number[] = [];
  return {
    reads,
    head: { block: stamps.length - 1, timestamp: stamps[stamps.length - 1] },
    timestampOf: async (block: number) => {
      reads.push(block);
      if (block < 0 || block >= stamps.length) {
        throw new Error(`no block ${block}`);
      }
      return stamps[block];
    }
  };
}

describe('findLastBlockBefore', () => {
  it('finds b with ts(b) < T <= ts(b + 1) on 12 s slots', async () => {
    // Block 1000 is the first at or after T.
    const stamps = Array.from({ length: 1201 }, (_, b) => T - 12_000 + 12 * b);
    const { head, timestampOf } = chain(stamps);
    expect(stamps[999]).toBeLessThan(T);
    expect(stamps[1000]).toBe(T);
    await expect(findLastBlockBefore(T, head, timestampOf)).resolves.toBe(999);
  });

  it('walks back past an estimate that is too late (missed slots)', async () => {
    // Long gaps after T make the 12 s estimate land after the boundary.
    const stamps = Array.from({ length: 200 }, (_, b) =>
      b < 100 ? T - 1000 + b : T + (b - 100) * 600
    );
    const { head, timestampOf } = chain(stamps);
    await expect(findLastBlockBefore(T, head, timestampOf)).resolves.toBe(99);
  });

  it('matches a linear scan on any increasing chain', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 40 }), {
          minLength: 2,
          maxLength: 300
        }),
        fc.nat(),
        async (gaps, pick) => {
          const stamps: number[] = [];
          gaps.reduce((t, gap) => {
            stamps.push(t + gap);
            return t + gap;
          }, 1_000);
          const at = stamps[1 + (pick % (stamps.length - 1))];
          const expected = stamps.filter((ts) => ts < at).length - 1;
          const { head, timestampOf } = chain(stamps);
          expect(await findLastBlockBefore(at, head, timestampOf)).toBe(
            expected
          );
        }
      )
    );
  });

  it('refuses a head that is still before T', async () => {
    const { timestampOf } = chain([T - 2, T - 1]);
    await expect(
      findLastBlockBefore(T, { block: 1, timestamp: T - 1 }, timestampOf)
    ).rejects.toThrow('before the freeze time');
  });
});

describe('resolveFreezeBlock', () => {
  const head = { block: 50, timestamp: T + 100 };
  const never = async () => {
    throw new Error('no block read expected');
  };

  it('has no freeze block without a setting', async () => {
    await expect(
      resolveFreezeBlock({ kind: 'NONE' }, head, never)
    ).resolves.toBeNull();
  });

  it('uses a configured block as given', async () => {
    await expect(
      resolveFreezeBlock({ kind: 'BLOCK', block: 42 }, head, never)
    ).resolves.toBe(42);
  });

  it('has no freeze block while the head is before T', async () => {
    await expect(
      resolveFreezeBlock(
        { kind: 'TIME', atSeconds: T },
        { block: 50, timestamp: T - 1 },
        never
      )
    ).resolves.toBeNull();
  });

  it('searches for the block once the head reaches T', async () => {
    const stamps = Array.from({ length: 51 }, (_, b) => T - 40 * 12 + 12 * b);
    const { timestampOf } = chain(stamps);
    await expect(
      resolveFreezeBlock(
        { kind: 'TIME', atSeconds: T },
        { block: 50, timestamp: stamps[50] },
        timestampOf
      )
    ).resolves.toBe(39);
  });
});

describe('splitAtFreeze', () => {
  it.each([
    ['no freeze', 10, 20, null, { from: 10, to: 20 }, null],
    ['the head at the freeze block', 10, 20, 20, { from: 10, to: 20 }, null],
    ['the head before it', 10, 20, 25, { from: 10, to: 20 }, null],
    [
      'the freeze inside the range',
      10,
      20,
      15,
      { from: 10, to: 15 },
      { from: 16, to: 20 }
    ],
    [
      'the freeze at the start',
      10,
      20,
      10,
      { from: 10, to: 10 },
      { from: 11, to: 20 }
    ],
    ['the range after the freeze', 16, 20, 15, null, { from: 16, to: 20 }],
    ['an empty range', 21, 20, 15, null, null]
  ])('splits %s', (_, start, latest, freezeBlock, apply, record) => {
    expect(splitAtFreeze(start, latest, freezeBlock)).toEqual({
      apply,
      record
    });
  });

  it('never applies a block after the freeze, and covers every block once', () => {
    fc.assert(
      fc.property(
        fc.nat(1000),
        fc.nat(1000),
        fc.option(fc.nat(1200), { nil: null }),
        (start, length, freezeBlock) => {
          const latest = start + length;
          const { apply, record } = splitAtFreeze(start, latest, freezeBlock);
          if (apply && freezeBlock !== null) {
            expect(apply.to).toBeLessThanOrEqual(freezeBlock);
          }
          if (record) {
            expect(freezeBlock).not.toBeNull();
            expect(record.from).toBeGreaterThan(freezeBlock!);
          }
          const covered =
            (apply ? apply.to - apply.from + 1 : 0) +
            (record ? record.to - record.from + 1 : 0);
          expect(covered).toBe(latest - start + 1);
          if (apply && record) {
            expect(record.from).toBe(apply.to + 1);
          }
        }
      )
    );
  });
});
