import { ChainFeedRecord } from '@/chain-gateway/chain-gateway.types';
import {
  categoryKey,
  ratingChangesOf,
  ratingEventOrigin,
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

  it('reads REP and NIC ratings of identities, removals as 0, and category names', () => {
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
            {
              rater: R,
              matter: 2,
              targetKind: 1,
              target: T,
              category: '0x' + '00'.repeat(32)
            },
            null,
            { byImport: true }
          ),
          // Not an identity's, or not readable: left out.
          rating(
            { rater: R, matter: 1, targetKind: 2, target: T, category: CAT },
            1
          ),
          rating(
            { rater: 'x', matter: 1, targetKind: 1, target: T, category: CAT },
            1
          ),
          rating(
            { rater: R, matter: 9, targetKind: 1, target: T, category: CAT },
            1
          )
        ]
      }
    ]);
    expect(read.categoryNames).toEqual(new Map([[CAT, 'Kind']]));
    expect(read.unreadable).toBe(3);
    expect(read.changes).toEqual([
      {
        height: 7,
        blockTimeMs: 1_764_000_084_000,
        rater: R,
        target: T,
        matter: 'REP',
        categoryId: CAT,
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
        categoryId: null,
        value: 0,
        writer: null,
        byImport: true
      }
    ]);
  });

  it("names a category's state key", () => {
    expect(categoryKey(CAT)).toBe(`0x0705${'cc'.repeat(32)}`);
  });
});
