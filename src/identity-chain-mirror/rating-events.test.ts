import {
  ChainFeedRecord,
  ChainRating,
  ChainRatingTotal
} from '@/chain-gateway/chain-gateway.types';
import {
  categoryKey,
  ledgerKeyOf,
  ledgerRowOfRating,
  ratingChangesOf,
  ratingEventOrigin,
  totalIn,
  totalKeyOf,
  writerText
} from './rating-events';

const R = '0x' + 'aa'.repeat(32);
const T = '0x' + 'bb'.repeat(32);
const CAT = '0x' + 'cc'.repeat(32);
const tx = (opName: string, opType: number | string = 0x0701) => ({
  kind: 'tx' as const,
  txId: '0x' + '11'.repeat(32),
  opType,
  opName
});
const system = (
  step:
    | 'IMPORT'
    | 'RATING_SCAN'
    | 'BINDING'
    | 'MEMBERSHIP_DAY'
    | 'QUEUE'
    | 'SYSTEM'
) => ({ kind: 'system' as const, step });

describe('ratingEventOrigin', () => {
  it.each([
    ['a RATING_SET transaction', tx('RATING_SET'), false, 'OPERATION'],
    ['a RATING_SET by its opType', tx('', '1793'), false, 'OPERATION'],
    ['another transaction', tx('IDENTITY_MERGE', 0x0110), false, 'UNKNOWN'],
    ['the rating scan', system('RATING_SCAN'), false, 'CAP_CUT'],
    ['the import', system('IMPORT'), true, 'IMPORT'],
    ['other system work', system('SYSTEM'), false, 'UNKNOWN'],
    ['no writer, the import marker', null, true, 'IMPORT'],
    ['no writer, not the import', null, false, 'UNKNOWN'],
    ['no writer, no marker', null, null, 'UNKNOWN']
  ] as const)('%s', (_name, writer, byImport, origin) => {
    expect(ratingEventOrigin(writer, byImport)).toBe(origin);
  });

  it('keeps the writer short and readable', () => {
    expect(writerText(tx('RATING_SET'))).toBe('tx:RATING_SET');
    expect(writerText(system('RATING_SCAN'))).toBe('system:RATING_SCAN');
    expect(writerText(null)).toBeNull();
    expect(writerText(tx('X'.repeat(60)))!.length).toBe(40);
  });
});

describe('ratingChangesOf', () => {
  const rating = (
    keyFields: Record<string, unknown>,
    value: number | null,
    extra: Partial<ChainFeedRecord> = {}
  ): ChainFeedRecord => ({
    family: '0x0701',
    name: 'Rating',
    key: '0x',
    value: value === null ? null : '0x01',
    keyFields,
    valueFields: value === null ? null : { value, index: 2 },
    ...extra
  });

  const ZERO = '0x' + '00'.repeat(32);

  it('reads REP and NIC ratings of identities, removals as 0, category names and totals', () => {
    const read = ratingChangesOf([
      {
        height: 7,
        slot: 7,
        root: '0x',
        time: 1_764_000_084_000,
        records: [
          {
            family: '0x0705',
            name: 'Category',
            key: '0x',
            value: '0x01',
            keyFields: { categoryId: CAT },
            valueFields: { name: 'Kind', createdHeight: 7 }
          },
          rating(
            { rater: R, matter: 1, targetKind: 1, target: T, category: CAT },
            5,
            { writer: tx('RATING_SET'), byImport: false }
          ),
          rating(
            { rater: R, matter: 2, targetKind: 1, target: T, category: ZERO },
            null,
            { byImport: true }
          ),
          {
            family: '0x0704',
            name: 'RatingTotal',
            key: '0x',
            value: '0x01',
            keyFields: { targetKind: 1, target: T, matter: 1, category: CAT },
            // The sum is an i128: it may come as a string.
            valueFields: { sum: '-12', raters: 3 }
          },
          {
            family: '0x0704',
            name: 'RatingTotal',
            key: '0x',
            value: null,
            keyFields: { targetKind: 1, target: T, matter: 2, category: ZERO },
            valueFields: null
          },
          // Not an identity's: left out, not a problem.
          rating(
            { rater: R, matter: 1, targetKind: 2, target: T, category: CAT },
            1
          ),
          // Not readable: named.
          rating(
            { rater: 'x', matter: 1, targetKind: 1, target: T, category: CAT },
            1,
            { key: '0x01' }
          ),
          rating(
            { rater: R, matter: 9, targetKind: 1, target: T, category: CAT },
            1,
            { key: '0x02' }
          ),
          rating(
            { rater: R, matter: 1, targetKind: 1, target: T, category: ZERO },
            1,
            { key: '0x03' }
          ),
          // A value without its fields is never a removal.
          rating(
            { rater: R, matter: 1, targetKind: 1, target: T, category: CAT },
            1,
            { key: '0x04', valueFields: null }
          )
        ]
      }
    ]);
    expect(read.categoryNames).toEqual(new Map([[CAT, 'Kind']]));
    expect(read.unreadable).toEqual(['7:0x01', '7:0x02', '7:0x03', '7:0x04']);
    expect(read.totals).toEqual(
      new Map([
        [
          7,
          new Map([
            [
              totalKeyOf({
                targetKind: 1,
                target: T,
                matterCode: 1,
                category: CAT
              }),
              -12
            ],
            [
              totalKeyOf({
                targetKind: 1,
                target: T,
                matterCode: 2,
                category: ZERO
              }),
              0
            ]
          ])
        ]
      ])
    );
    expect(read.changes).toEqual([
      {
        height: 7,
        blockTimeMs: 1_764_000_084_000,
        rater: R,
        target: T,
        matter: 'REP',
        matterCode: 1,
        targetKind: 1,
        category: CAT,
        categoryId: CAT,
        stateKey: '0x',
        value: 5,
        writer: tx('RATING_SET'),
        byImport: false
      },
      {
        height: 7,
        blockTimeMs: 1_764_000_084_000,
        rater: R,
        target: T,
        matter: 'CIC',
        matterCode: 2,
        targetKind: 1,
        category: ZERO,
        categoryId: null,
        stateKey: '0x',
        value: 0,
        writer: null,
        byImport: true
      },
      // Its key can be read, not its value: the ledger marks it stale.
      {
        height: 7,
        blockTimeMs: 1_764_000_084_000,
        rater: R,
        target: T,
        matter: 'REP',
        matterCode: 1,
        targetKind: 1,
        category: CAT,
        categoryId: CAT,
        stateKey: '0x04',
        value: null,
        writer: null,
        byImport: null
      }
    ]);
  });

  it('keys the ledger by the record key and the totals by the target', () => {
    const it1 = {
      rater: R,
      matterCode: 1,
      targetKind: 1,
      target: T,
      category: CAT
    };
    expect(ledgerKeyOf(it1)).not.toBe(ledgerKeyOf({ ...it1, rater: T }));
    expect(totalKeyOf(it1)).toBe(totalKeyOf({ ...it1, rater: T } as never));
    expect(totalKeyOf(it1)).not.toBe(totalKeyOf({ ...it1, matterCode: 2 }));
  });

  it("finds a change's total in a target's totals by matter and category", () => {
    const totals = [
      {
        matter: 'REP',
        category: { id: null, name: null },
        total: '7',
        raters: 1
      },
      {
        matter: 'nic',
        category: { id: null, name: null },
        total: '3',
        raters: 1
      },
      {
        matter: 'REP',
        category: { id: CAT, name: 'Kind' },
        total: '-4',
        raters: 2
      },
      {
        matter: 'REP',
        category: { id: '0x' + 'dd'.repeat(32), name: 'Big' },
        total: '1' + '0'.repeat(20),
        raters: 2
      }
    ] as unknown as ChainRatingTotal[];
    expect(totalIn(totals, { matter: 'CIC', category: ZERO })).toBe(3);
    expect(totalIn(totals, { matter: 'REP', category: CAT })).toBe(-4);
    // None listed: no rater left.
    expect(
      totalIn(totals, { matter: 'REP', category: '0x' + 'ee'.repeat(32) })
    ).toBe(0);
    // Too big to hold exactly: not taken.
    expect(
      totalIn(totals, { matter: 'REP', category: '0x' + 'dd'.repeat(32) })
    ).toBeNull();
  });

  it('reads a listed rating as a ledger row', () => {
    const listed = (it: Partial<ChainRating>): ChainRating => ({
      rater: R,
      target: T,
      matter: 'rep',
      category: { id: CAT, name: 'Kind' },
      value: '-7',
      updatedHeight: 40,
      viaGrant: null,
      ...it
    });
    expect(ledgerRowOfRating(listed({}), 99)).toEqual({
      rater: R,
      matterCode: 1,
      targetKind: 1,
      target: T,
      category: CAT,
      value: -7,
      height: 40,
      stale: false
    });
    // NIC's category is the zero id, whatever the list gives.
    expect(
      ledgerRowOfRating(
        listed({ matter: 'nic', category: { id: null as never, name: null } }),
        99
      )
    ).toMatchObject({ matterCode: 2, category: ZERO });
    // A value it can't hold exactly: stale, at the height it was listed at.
    expect(
      ledgerRowOfRating(
        listed({ value: '9'.repeat(20), updatedHeight: 'x' as never }),
        99
      )
    ).toMatchObject({ value: 0, height: 99, stale: true });
    expect(ledgerRowOfRating(listed({ rater: 'x' }), 99)).toBeNull();
    expect(
      ledgerRowOfRating(listed({ category: { id: ZERO, name: null } }), 99)
    ).toBeNull();
  });

  it("names a category's state key", () => {
    expect(categoryKey(CAT)).toBe(`0x0705${'cc'.repeat(32)}`);
  });
});
