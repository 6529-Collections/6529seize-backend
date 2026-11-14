import { NULL_ADDRESS } from '@/constants';
import type { ChainTransfer } from './chain-transfers';
import { compareOwnerBalances, expectedBalances } from './owner-balance-check';
import type { LedgerRow } from './state-audit.manifest';

const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const ZERO = NULL_ADDRESS.toLowerCase();
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return {
    transaction: `0x${'1'.repeat(64)}`,
    block: 50,
    from_address: ZERO,
    to_address: A,
    contract: CONTRACT,
    token_id: '1',
    token_count: 5,
    ...overrides
  };
}

function transfer(overrides: Partial<ChainTransfer>): ChainTransfer {
  return {
    transaction: `0x${'2'.repeat(64)}`,
    block: 100,
    block_hash: `0x${'b'.repeat(64)}`,
    transaction_index: 0,
    from_address: A,
    to_address: B,
    contract: CONTRACT,
    token_id: '1',
    amount: BigInt(2),
    log_indexes: [0],
    ...overrides
  };
}

describe('expectedBalances', () => {
  it('replays outside-window history plus in-window chain edges with owners rules', () => {
    const balances = expectedBalances({
      wallets: [A, B],
      history: [
        row({ block: 50 }),
        // In-window stored row is ignored in favour of the chain edge.
        row({ block: 100, from_address: A, to_address: B, token_count: 99 }),
        // Beyond the owners block reference: not yet published.
        row({ block: 500, from_address: A, to_address: B, token_count: 1 })
      ],
      chain: [transfer({})],
      fromBlock: 100,
      toBlock: 120,
      blockReference: 300
    });
    expect(Array.from(balances.entries())).toEqual([
      [`${A}:1`, 3],
      [`${B}:1`, 2]
    ]);
  });

  it('never debits the zero address', () => {
    const balances = expectedBalances({
      wallets: [ZERO, A],
      history: [row({})],
      chain: [],
      fromBlock: 100,
      toBlock: 120,
      blockReference: 300
    });
    expect(balances.get(`${ZERO}:1`)).toBeUndefined();
    expect(balances.get(`${A}:1`)).toBe(5);
  });
});

describe('compareOwnerBalances', () => {
  it('reports stale, missing and leftover owner rows', () => {
    const expected = new Map<string, number>([
      [`${A}:1`, 3],
      [`${B}:1`, 2],
      [`${B}:2`, 0]
    ]);
    const stored = [
      {
        wallet: A,
        contract: CONTRACT,
        token_id: '1',
        balance: 5,
        block_reference: 300
      },
      {
        wallet: B,
        contract: CONTRACT,
        token_id: '2',
        balance: 1,
        block_reference: 300
      }
    ];
    expect(compareOwnerBalances(CONTRACT, expected, stored)).toEqual([
      {
        type: 'owner_balance_mismatch',
        wallet: A,
        token_id: '1',
        stored_row: stored[0],
        expected_row: {
          wallet: A,
          contract: CONTRACT,
          token_id: '1',
          balance: 3
        }
      },
      {
        type: 'owner_balance_mismatch',
        wallet: B,
        token_id: '1',
        stored_row: null,
        expected_row: {
          wallet: B,
          contract: CONTRACT,
          token_id: '1',
          balance: 2
        }
      },
      {
        type: 'owner_balance_mismatch',
        wallet: B,
        token_id: '2',
        stored_row: stored[1],
        expected_row: {
          wallet: B,
          contract: CONTRACT,
          token_id: '2',
          balance: 0
        }
      }
    ]);
  });

  it('is empty when balances agree and non-positive expectations have no rows', () => {
    const expected = new Map<string, number>([
      [`${A}:1`, 3],
      [`${B}:1`, -1]
    ]);
    expect(
      compareOwnerBalances(CONTRACT, expected, [
        {
          wallet: A,
          contract: CONTRACT,
          token_id: '1',
          balance: 3,
          block_reference: 1
        }
      ])
    ).toEqual([]);
  });
});
