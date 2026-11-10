import * as fc from 'fast-check';
import type { ChainTransfer } from './chain-transfers';
import { diffLedger } from './state-audit.diff';
import type { LedgerRow } from './state-audit.manifest';

const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';
const C = '0x4444444444444444444444444444444444444444';
const TX1 = `0x${'1'.repeat(64)}`;
const TX2 = `0x${'2'.repeat(64)}`;

function transfer(
  overrides: Partial<ChainTransfer> & { amount?: bigint }
): ChainTransfer {
  return {
    transaction: TX1,
    block: 100,
    block_hash: `0x${'b'.repeat(64)}`,
    transaction_index: 0,
    from_address: A,
    to_address: B,
    contract: CONTRACT,
    token_id: '1',
    amount: BigInt(1),
    log_indexes: [0],
    ...overrides
  };
}

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return {
    transaction: TX1,
    block: 100,
    from_address: A,
    to_address: B,
    contract: CONTRACT,
    token_id: '1',
    token_count: 1,
    ...overrides
  };
}

describe('diffLedger', () => {
  it('is clean when every chain edge has a matching stored row', () => {
    const result = diffLedger([transfer({})], [row({})]);
    expect(result.discrepancies).toEqual([]);
    expect(result.affected_wallets).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('reports a wholly absent transaction with all expected rows', () => {
    const result = diffLedger(
      [transfer({}), transfer({ token_id: '2', amount: BigInt(3) })],
      []
    );
    expect(result.discrepancies).toHaveLength(1);
    const [found] = result.discrepancies;
    expect(found.type).toBe('missing_transaction');
    if (found.type === 'missing_transaction') {
      expect(
        found.expected_rows.map((r) => [r.token_id, r.token_count])
      ).toEqual([
        ['1', 1],
        ['2', 3]
      ]);
    }
    expect(result.affected_wallets).toEqual([A, B]);
  });

  it('reports a missing edge when the transaction is partially stored', () => {
    const result = diffLedger(
      [transfer({}), transfer({ to_address: C, token_id: '2' })],
      [row({})]
    );
    expect(result.discrepancies.map((d) => d.type)).toEqual(['missing_edge']);
    expect(result.affected_wallets).toEqual([A, C]);
  });

  it('reports a token_count mismatch with before and expected rows', () => {
    const result = diffLedger(
      [transfer({ amount: BigInt(4) })],
      [row({ token_count: 1 })]
    );
    expect(result.discrepancies).toEqual([
      {
        type: 'token_count_mismatch',
        transaction: TX1,
        stored_row: row({ token_count: 1 }),
        expected_row: expect.objectContaining({ token_count: 4, token_id: '1' })
      }
    ]);
  });

  it('pairs a lone stored row with the lone chain edge sharing its endpoints as a token_id mismatch', () => {
    const result = diffLedger(
      [transfer({ token_id: '7' })],
      [row({ token_id: '8' })]
    );
    expect(result.discrepancies.map((d) => d.type)).toEqual([
      'token_id_mismatch'
    ]);
  });

  it('does not guess a token_id pairing when the endpoints are ambiguous', () => {
    const result = diffLedger(
      [transfer({ token_id: '7' }), transfer({ token_id: '9' })],
      [row({ token_id: '8' })]
    );
    expect(
      result.discrepancies.map((d) => d.type).sort((a, b) => a.localeCompare(b))
    ).toEqual(['missing_edge', 'missing_edge', 'unexpected_row']);
  });

  it('reports stored rows for transactions the chain does not have', () => {
    const result = diffLedger(
      [transfer({})],
      [row({}), row({ transaction: TX2 })]
    );
    expect(result.discrepancies).toEqual([
      {
        type: 'unexpected_row',
        transaction: TX2,
        detail: 'no_chain_transaction',
        stored_row: row({ transaction: TX2 }),
        expected_row: null
      }
    ]);
  });

  it('reports case-variant duplicates of one normalized edge', () => {
    const duplicate = row({ token_count: 1 });
    const result = diffLedger([transfer({})], [row({}), duplicate]);
    expect(result.discrepancies.map((d) => d.type)).toEqual(['unexpected_row']);
    expect(result.discrepancies[0]).toMatchObject({
      detail: 'duplicate_normalized_key'
    });
  });

  it('flags amounts above the ledger integer range as a problem', () => {
    const result = diffLedger(
      [transfer({ amount: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) })],
      []
    );
    expect(result.problems.map((p) => p.code)).toEqual(['amount_overflow']);
  });

  it('is clean for any ledger derived from the chain, and finds every corrupted row (fast-check)', () => {
    const transferArb = fc.record({
      transaction: fc.constantFrom(TX1, TX2),
      from: fc.constantFrom(A, B, C),
      to: fc.constantFrom(A, B, C),
      tokenId: fc.integer({ min: 1, max: 3 }),
      amount: fc.integer({ min: 1, max: 9 })
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(transferArb, {
          maxLength: 10,
          selector: (t) => `${t.transaction}:${t.from}:${t.to}:${t.tokenId}`
        }),
        fc.nat(),
        (edges, corruptIndex) => {
          const chain = edges.map((edge, index) =>
            transfer({
              transaction: edge.transaction,
              transaction_index: edge.transaction === TX1 ? 0 : 1,
              from_address: edge.from,
              to_address: edge.to,
              token_id: String(edge.tokenId),
              amount: BigInt(edge.amount),
              log_indexes: [index]
            })
          );
          const ledger = chain.map((t) =>
            row({
              transaction: t.transaction,
              from_address: t.from_address,
              to_address: t.to_address,
              token_id: t.token_id,
              token_count: Number(t.amount)
            })
          );
          expect(diffLedger(chain, ledger).discrepancies).toEqual([]);
          if (!ledger.length) return;
          const victim = corruptIndex % ledger.length;
          ledger[victim] = {
            ...ledger[victim],
            token_count: ledger[victim].token_count + 1
          };
          const corrupted = diffLedger(chain, ledger).discrepancies;
          expect(corrupted).toHaveLength(1);
          expect(corrupted[0].type).toBe('token_count_mismatch');
        }
      )
    );
  });
});
