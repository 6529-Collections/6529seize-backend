import { MEMES_CONTRACT, GRADIENT_CONTRACT } from '@/constants';
import { Transaction } from '@/entities/ITransaction';
import {
  CollectingProjectionToken,
  CollectingTdhProjectionInput,
  projectCollectingTdh,
  toTdhReplayTransaction,
  assertCollectingTdhParity
} from '@/collecting/collecting-tdh-projection';
import { getTokenTdh } from '@/tdhLoop/tdh';

jest.mock('@/db', () => ({}));
jest.mock('@/nextgen/nextgen.db', () => ({}));

const walletA = '0x0000000000000000000000000000000000000011';
const walletB = '0x0000000000000000000000000000000000000022';
const seller = '0x0000000000000000000000000000000000000033';
const thirdParty = '0x0000000000000000000000000000000000000044';

function token(
  id: number,
  extra: Partial<CollectingProjectionToken> = {}
): CollectingProjectionToken {
  return {
    contract: MEMES_CONTRACT,
    token_id: id,
    family: 'memes',
    minted_at: '2025-01-01T00:00:00Z',
    hodl_rate: 1,
    calculation_edition_size: 100,
    ...extra
  };
}

function transaction(
  id: number,
  to: string,
  date: string,
  quantity = 1,
  contract = MEMES_CONTRACT
): Transaction {
  return {
    transaction: `tx-${id}-${to}-${date}`,
    block: 1,
    created_at: new Date(date),
    transaction_date: new Date(date),
    from_address: seller,
    to_address: to,
    contract,
    token_id: id,
    token_count: quantity,
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0,
    eth_price_usd: 0,
    value_usd: 0,
    gas_usd: 0
  };
}

function input(
  extra: Partial<CollectingTdhProjectionInput> = {}
): CollectingTdhProjectionInput {
  return {
    snapshot_block: 100,
    snapshot_timestamp: '2026-01-31T00:00:00Z',
    rules_version: 'fixture-v1',
    wallets: [walletA, walletB],
    tokens: [token(1)],
    seasons: [],
    transactions: [transaction(1, walletA, '2026-01-01T00:00:00Z')],
    evaluated_at: '2026-01-31T00:00:00Z',
    transfers: [],
    ...extra
  };
}

describe('canonical TDH projection', () => {
  it('fails closed when replay cannot reproduce the published baseline', () => {
    const scenario = input();
    const baseline = projectCollectingTdh(scenario).baseline;
    expect(() => assertCollectingTdhParity(scenario, baseline)).not.toThrow();
    expect(() =>
      assertCollectingTdhParity(scenario, {
        ...baseline,
        boosted_tdh: baseline.boosted_tdh + 1
      })
    ).toThrow('official snapshot');
  });

  it('rejects edits before the official snapshot and hypothetical transfers beyond custody', () => {
    const transfer = {
      contract: MEMES_CONTRACT,
      token_id: 1,
      from_address: walletA,
      to_address: walletB,
      quantity: 2,
      timestamp: '2026-01-31T00:00:00Z'
    };
    expect(() =>
      projectCollectingTdh(input({ transfers: [transfer] }))
    ).toThrow('custody');
    expect(() =>
      projectCollectingTdh(
        input({
          transfers: [
            { ...transfer, quantity: 1, timestamp: '2026-01-30T00:00:00Z' }
          ]
        })
      )
    ).toThrow('hypothetical transfer');
  });
  it('preserves production per-wallet rounding before consolidation', () => {
    const transfers = [
      transaction(1, walletA, '2026-01-01T00:00:00Z'),
      transaction(1, walletB, '2026-01-21T00:00:00Z')
    ];
    const result = projectCollectingTdh(
      input({
        tokens: [
          token(1, { calculation_edition_size: 1000 }),
          token(2, { calculation_edition_size: 1235 })
        ],
        transactions: transfers
      })
    );
    const expected = [walletA, walletB].reduce(
      (sum, wallet) =>
        sum +
        (getTokenTdh(
          new Date('2026-01-31T00:00:00Z'),
          1,
          1.235,
          wallet,
          [walletA, walletB],
          transfers.map(toTdhReplayTransaction)
        )?.tdh ?? 0),
      0
    );
    expect(expected).toBe(49);
    expect(result.baseline.base_tdh).toBe(expected);
    expect(result.additional_tdh).toBe(0);
  });

  it('lets a zero-day Gradient change the multiplier on existing accumulated TDH', () => {
    const result = projectCollectingTdh(
      input({
        tokens: [
          token(1),
          token(9, {
            family: 'gradients',
            contract: GRADIENT_CONTRACT,
            hodl_rate: 10
          })
        ],
        transfers: [
          {
            contract: GRADIENT_CONTRACT,
            token_id: 9,
            from_address: seller,
            to_address: walletB,
            quantity: 1,
            timestamp: '2026-01-31T00:00:00Z'
          }
        ]
      })
    );
    expect(result.baseline.boosted_tdh).toBe(30);
    expect(result.proposed.boost).toBe(1.02);
    expect(result.additional_base_tdh).toBe(0);
    expect(result.additional_tdh).toBe(1);
    expect(result.changed_boost_on_existing_holdings).toBe(1);
  });

  it('preserves lot age during internal transfers and removes newest lots on external sales', () => {
    const history = [
      transaction(1, walletA, '2026-01-01T00:00:00Z'),
      transaction(1, walletA, '2026-01-21T00:00:00Z')
    ];
    const base = input({
      transactions: history,
      evaluated_at: '2026-02-10T00:00:00Z'
    });
    const internal = projectCollectingTdh({
      ...base,
      transfers: [
        {
          contract: MEMES_CONTRACT,
          token_id: 1,
          from_address: walletA,
          to_address: walletB,
          quantity: 1,
          timestamp: '2026-01-31T00:00:00Z'
        }
      ]
    });
    expect(internal.additional_tdh).toBe(0);
    const sale = projectCollectingTdh({
      ...base,
      transfers: [
        {
          contract: MEMES_CONTRACT,
          token_id: 1,
          from_address: walletA,
          to_address: thirdParty,
          quantity: 1,
          timestamp: '2026-01-31T00:00:00Z'
        }
      ]
    });
    expect(sale.proposed.base_tdh).toBe(40);
  });

  it('does not transfer a seller history or count a purchase sent to a third party', () => {
    const result = projectCollectingTdh(
      input({
        transfers: [
          {
            contract: MEMES_CONTRACT,
            token_id: 1,
            from_address: seller,
            to_address: thirdParty,
            quantity: 2,
            timestamp: '2026-01-31T00:00:00Z'
          }
        ]
      })
    );
    expect(result.additional_tdh).toBe(0);
    expect(result.proposed.tokens[0].balance).toBe(1);
  });

  it.each([
    [1, 1.05],
    [2, 1.1],
    [3, 1.13]
  ])('matches additional-set indexing for %i complete sets', (sets, boost) => {
    const result = projectCollectingTdh(
      input({
        tokens: [token(1), token(2), token(3)],
        seasons: [
          {
            id: 1,
            start_index: 1,
            end_index: 2,
            count: 2,
            name: 'Season 1',
            display: 'SZN1',
            boost: 0.05
          },
          {
            id: 2,
            start_index: 3,
            end_index: 3,
            count: 1,
            name: 'Season 2',
            display: 'SZN2',
            boost: 0.05
          }
        ],
        transactions: [1, 2, 3].map((id) =>
          transaction(id, walletA, '2026-01-01T00:00:00Z', sets)
        )
      })
    );
    expect(result.baseline.full_memes_sets).toBe(sets);
    expect(result.baseline.boost).toBe(boost);
  });

  it('applies the full-day new-release eligibility cutoff', () => {
    const result = projectCollectingTdh(
      input({
        tokens: [token(1, { minted_at: '2026-01-30T12:00:00Z' })],
        transactions: [transaction(1, walletA, '2026-01-30T12:00:00Z')]
      })
    );
    expect(result.baseline.tokens).toEqual([]);
  });
});
