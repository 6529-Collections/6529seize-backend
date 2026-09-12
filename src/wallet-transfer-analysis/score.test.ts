import {
  rankTransferPairs,
  scoreTransferPair
} from '@/wallet-transfer-analysis/score';
import { DAY_MS, PairMetrics } from '@/wallet-transfer-analysis/types';

function metrics(overrides: Partial<PairMetrics> = {}): PairMetrics {
  return {
    wallet_a: 'a',
    wallet_b: 'b',
    a_to_b_count: 4,
    b_to_a_count: 0,
    a_to_b_token_count: 4,
    b_to_a_token_count: 0,
    a_to_b_days: 4,
    b_to_a_days: 0,
    active_days: 4,
    first_transfer_at: DAY_MS,
    last_transfer_at: 31 * DAY_MS,
    sample_transaction_a_to_b: 'tx',
    sample_transaction_b_to_a: null,
    a_outbound_count: 5,
    a_inbound_count: 0,
    b_outbound_count: 0,
    b_inbound_count: 10,
    ...overrides
  };
}

describe('transfer review priority', () => {
  it('requires recurrence across days and time, not a large batch', () => {
    const singleDay = metrics({
      a_to_b_count: 100,
      active_days: 1,
      a_to_b_days: 1
    });
    expect(scoreTransferPair(singleDay).priority_score).toBe(0);
    expect(
      scoreTransferPair(metrics({ last_transfer_at: 2 * DAY_MS }))
        .priority_score
    ).toBe(0);
  });

  it('reports actual asymmetric concentrations with all wallet activity retained', () => {
    const result = scoreTransferPair(metrics());
    expect(result.a_to_b_outbound_share).toBe(0.8);
    expect(result.a_to_b_inbound_share).toBe(0.4);
    expect(result.rules).toContain('concentrated_outgoing_transfers');
    expect(result.explanation).toContain("80% of A's");
  });

  it('recognizes sustained reciprocity and ranks it above an equivalent one-way relation', () => {
    const reciprocal = metrics({
      b_to_a_count: 4,
      b_to_a_days: 3,
      b_outbound_count: 5,
      a_inbound_count: 5
    });
    const result = scoreTransferPair(reciprocal);
    expect(result.rules).toContain('repeated_reciprocal_transfers');
    expect(result.priority_score).toBeGreaterThan(
      scoreTransferPair(metrics()).priority_score
    );
  });

  it('does not call a single return occasion repeated reciprocity', () => {
    expect(
      scoreTransferPair(metrics({ b_to_a_count: 1, b_to_a_days: 1 })).rules
    ).not.toContain('repeated_reciprocal_transfers');
  });

  it('uses deterministic ties, caps results, and excludes insufficient repetition', () => {
    const result = rankTransferPairs(
      [
        metrics({ wallet_b: 'z' }),
        metrics({ wallet_b: 'c', active_days: 1 }),
        metrics({ wallet_b: 'b' })
      ],
      1
    );
    expect(result).toHaveLength(1);
    expect(result[0].wallet_b).toBe('b');
  });
});
