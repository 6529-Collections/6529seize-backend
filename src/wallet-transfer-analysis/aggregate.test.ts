import * as fc from 'fast-check';
import {
  MANIFOLD,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  NULL_ADDRESS_DEAD
} from '@/constants';
import { aggregateTransferBucket } from '@/wallet-transfer-analysis/aggregate';
import { DAY_MS, SourceTransfer } from '@/wallet-transfer-analysis/types';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;
const CONTRACT = MEMES_CONTRACT.toLowerCase();
const day = Date.UTC(2026, 8, 1);

function row(overrides: Partial<SourceTransfer> = {}): SourceTransfer {
  return {
    transaction: `0x${'1'.repeat(64)}`,
    block: 1010,
    transaction_date: new Date(day + 1_000),
    from_address: A,
    to_address: B,
    contract: CONTRACT,
    token_id: 1,
    token_count: 1,
    value: 0,
    ...overrides
  };
}

const aggregate = (rows: SourceTransfer[]) =>
  aggregateTransferBucket(rows, CONTRACT, 1_000);

describe('transfer bucket aggregation', () => {
  it('counts a multi-card ERC1155 batch once and retains all quantities', () => {
    const result = aggregate([
      row({ token_id: 1, token_count: 2 }),
      row({ token_id: 2, token_count: 3 }),
      row({ token_id: 3, token_count: 4 })
    ]);
    expect(result.pairs).toEqual([
      expect.objectContaining({
        transfer_count: 1,
        token_count: 9,
        day_start: day
      })
    ]);
    expect(result.wallets).toEqual([
      expect.objectContaining({
        wallet: A,
        outbound_count: 1,
        outbound_token_count: 9
      }),
      expect.objectContaining({
        wallet: B,
        inbound_count: 1,
        inbound_token_count: 9
      })
    ]);
  });

  it('uses recipient-specific occasions for multi-recipient denominators', () => {
    const result = aggregate([row(), row({ to_address: C })]);
    expect(result.pairs).toHaveLength(2);
    expect(result.wallets.find((it) => it.wallet === A)?.outbound_count).toBe(
      2
    );
  });

  it('keeps separate transactions on the same day in one daily pair summary', () => {
    const result = aggregate([
      row(),
      row({
        transaction: `0x${'2'.repeat(64)}`,
        transaction_date: new Date(day + 60_000)
      })
    ]);
    expect(result.pairs).toEqual([
      expect.objectContaining({
        transfer_count: 2,
        first_transfer_at: day + 1_000,
        last_transfer_at: day + 60_000
      })
    ]);
  });

  it('excludes zero-valued companion rows of a paid multi-card episode', () => {
    const result = aggregate([
      row({ token_id: 1, value: 1 }),
      row({ token_id: 2, value: 0 }),
      row({ transaction: `0x${'2'.repeat(64)}`, token_id: 3 })
    ]);
    expect(result.pairs[0].transfer_count).toBe(1);
    expect(result.pairs[0].token_count).toBe(1);
    expect(result.pairs[0].sample_transaction).toBe(`0x${'2'.repeat(64)}`);
  });

  it('excludes mint, burn, Manifold, self, sale, and zero-quantity activity', () => {
    const ignored = [
      row({ from_address: NULL_ADDRESS }),
      row({ to_address: NULL_ADDRESS }),
      row({ to_address: NULL_ADDRESS_DEAD }),
      row({ from_address: MANIFOLD }),
      row({ to_address: MANIFOLD }),
      row({ to_address: A }),
      row({ value: 0.5 }),
      row({ token_count: 0 })
    ];
    expect(aggregate(ignored)).toEqual({ pairs: [], wallets: [] });
  });

  it('normalizes address case and interprets MySQL DATETIME as UTC', () => {
    const result = aggregate([
      row({
        from_address: `0x${'A'.repeat(40)}`,
        transaction_date: '2026-09-01 23:59:59'
      }),
      row({
        transaction: `0x${'2'.repeat(64)}`,
        transaction_date: '2026-09-02 00:00:00'
      })
    ]);
    expect(result.pairs.map((it) => it.day_start)).toEqual([day, day + DAY_MS]);
    expect(result.pairs.every((it) => it.from_address === A)).toBe(true);
  });

  it.each<[string, number]>([
    ['2026-09-01T23:30:00-02:00', day + DAY_MS + 90 * 60_000],
    ['2026-09-02T01:30:00+02:00', day + DAY_MS - 30 * 60_000],
    ['2026-09-01T23:59:59.123456Z', day + DAY_MS - 877],
    ['2026-09-01 23:59:59.123456', day + DAY_MS - 877]
  ])('uses a deterministic UTC instant for %s', (value, expectedTimestamp) => {
    const result = aggregate([row({ transaction_date: value })]);

    expect(result.pairs[0].first_transfer_at).toBe(expectedTimestamp);
    expect(result.pairs[0].day_start).toBe(
      Math.floor(expectedTimestamp / DAY_MS) * DAY_MS
    );
  });

  it.each([
    '2026-09-01',
    '2026-09-01T12:30',
    '09/01/2026 12:30:00',
    'September 1, 2026 12:30:00',
    '2026-09-01T12:30:00+02'
  ])('rejects unsupported timestamp format %s', (value) => {
    expect(() => aggregate([row({ transaction_date: value })])).toThrow(
      'Transfer timestamp format is invalid'
    );
  });

  it('does not alter denominators based on ownership declarations', () => {
    // Aggregation deliberately receives no consolidation/profile data.
    const result = aggregate([row(), row({ to_address: C })]);
    expect(result.wallets.find((it) => it.wallet === A)?.outbound_count).toBe(
      2
    );
    expect(result.pairs.map((it) => it.to_address)).toEqual([B, C]);
  });

  it.each([
    { token_count: -1 },
    { token_count: '1.5' },
    { token_count: '9007199254740993' },
    { transaction_date: 'invalid' },
    { from_address: 'invalid' },
    { value: 'invalid' },
    { contract: A }
  ])(
    'rejects invalid evidence instead of advancing on partial data: %p',
    (invalid) => {
      expect(() => aggregate([row(invalid)])).toThrow();
    }
  );

  it('detects quantity overflow when individually valid rows are summed', () => {
    expect(() =>
      aggregate([
        row({ token_id: 1, token_count: Number.MAX_SAFE_INTEGER }),
        row({ token_id: 2, token_count: 1 })
      ])
    ).toThrow();
  });

  it('conserves sender and receiver counts and quantities across batches', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 50 }),
        (quantities) => {
          const result = aggregate(
            quantities.map((quantity, index) =>
              row({
                transaction: `0x${index.toString(16).padStart(64, '0')}`,
                to_address: index % 2 === 0 ? B : C,
                token_count: quantity
              })
            )
          );
          const totalQuantity = quantities.reduce((sum, it) => sum + it, 0);
          expect(
            result.wallets.reduce((sum, it) => sum + it.outbound_count, 0)
          ).toBe(quantities.length);
          expect(
            result.wallets.reduce((sum, it) => sum + it.inbound_count, 0)
          ).toBe(quantities.length);
          expect(
            result.wallets.reduce((sum, it) => sum + it.outbound_token_count, 0)
          ).toBe(totalQuantity);
          expect(
            result.wallets.reduce((sum, it) => sum + it.inbound_token_count, 0)
          ).toBe(totalQuantity);
        }
      )
    );
  });
});
