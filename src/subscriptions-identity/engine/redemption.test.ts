import {
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  RESEARCH_6529_ADDRESS
} from '@/constants';
import { PhasedFinalRow } from './phase-split';
import { AirdropTransfer, matchRedemptions } from './redemption';

const K1 = '0x0000000000000000000000000000000000000001';
const K2 = '0x0000000000000000000000000000000000000002';
const A1 = '0x00000000000000000000000000000000000000a1';
const OTHER_CONTRACT = '0x00000000000000000000000000000000000000c1';

function finalRow(
  key: string,
  count: number,
  phase: string | null,
  position: number
): PhasedFinalRow {
  return {
    key,
    contract: MEMES_CONTRACT,
    tokenId: 500,
    subscribedCount: count,
    airdropAddress: A1,
    balance: 1,
    subscribedAt: '2026-10-01T00:00:00.000Z',
    phase,
    phaseSubscriptions: 1,
    phasePosition: position,
    redeemedCount: 0
  };
}

function transfer(
  overrides: Partial<AirdropTransfer> = {}
): AirdropTransfer {
  return {
    transaction: '0x' + '1'.repeat(64),
    block: 100,
    transactionDate: '2026-11-25T15:00:00.000Z',
    to: A1,
    contract: MEMES_CONTRACT,
    tokenId: 500,
    tokenCount: 1,
    ...overrides
  };
}

const noDistribution = () => 0;

describe('matchRedemptions', () => {
  it('charges the mint price per token and records one entry per transaction', () => {
    const result = matchRedemptions({
      transfers: [transfer({ tokenCount: 2 })],
      afterBlock: 0,
      finalRows: [finalRow(K1, 3, 'Phase 0', 1)],
      balances: new Map([[K1, 0.5]]),
      distributionAirdropCount: noDistribution
    });
    expect(result.redeemed).toHaveLength(1);
    expect(result.redeemed[0].count).toBe(2);
    expect(result.redeemed[0].value).toBe(MEMES_MINT_PRICE + MEMES_MINT_PRICE);
    expect(result.redeemed[0].balanceAfter).toBe(0.36942);
    expect(result.finalRows[0].redeemedCount).toBe(2);
  });

  it('fills rows in phase order (no phase first) then position', () => {
    const result = matchRedemptions({
      transfers: [transfer({ tokenCount: 2 })],
      afterBlock: 0,
      finalRows: [
        finalRow(K1, 1, 'Phase 1', 1),
        finalRow(K2, 1, 'Phase 0', 2)
      ],
      balances: new Map([
        [K1, 1],
        [K2, 1]
      ]),
      distributionAirdropCount: noDistribution
    });
    expect(result.redeemed.map((r) => r.key)).toEqual([K2, K1]);
  });

  it('reports a token beyond the subscribed count', () => {
    const result = matchRedemptions({
      transfers: [transfer({ tokenCount: 3 })],
      afterBlock: 0,
      finalRows: [finalRow(K1, 2, null, -1)],
      balances: new Map([[K1, 1]]),
      distributionAirdropCount: noDistribution
    });
    expect(result.redeemed[0].count).toBe(2);
    expect(result.notices).toEqual([
      { kind: 'NO_SUBSCRIPTION', airdropAddress: A1, transaction: transfer().transaction }
    ]);
  });

  it('goes negative and reports when the balance is short or missing', () => {
    const short = matchRedemptions({
      transfers: [transfer()],
      afterBlock: 0,
      finalRows: [finalRow(K1, 1, null, -1)],
      balances: new Map([[K1, 0.01]]),
      distributionAirdropCount: noDistribution
    });
    expect(short.notices[0].kind).toBe('INSUFFICIENT_BALANCE');
    expect(short.balances.get(K1)).toBe(-0.05529);
    const missing = matchRedemptions({
      transfers: [transfer()],
      afterBlock: 0,
      finalRows: [finalRow(K1, 1, null, -1)],
      balances: new Map(),
      distributionAirdropCount: noDistribution
    });
    expect(missing.notices[0].kind).toBe('NO_BALANCE');
    expect(missing.balances.get(K1)).toBe(-MEMES_MINT_PRICE);
  });

  it('skips other contracts, research and distribution airdrops', () => {
    const result = matchRedemptions({
      transfers: [
        transfer({ contract: OTHER_CONTRACT, transaction: '0x01' }),
        transfer({ to: RESEARCH_6529_ADDRESS, transaction: '0x02' }),
        transfer({ transaction: '0x03', block: 101 })
      ],
      afterBlock: 0,
      finalRows: [finalRow(K1, 1, null, -1)],
      balances: new Map([[K1, 1]]),
      distributionAirdropCount: (wallet) => (wallet === A1 ? 1 : 0)
    });
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'NOT_MEMES',
      'RESEARCH',
      'DISTRIBUTION_AIRDROP'
    ]);
    expect(result.redeemed).toEqual([]);
  });

  it('keeps the legacy DECIMAL string concatenation for repeat airdrops', () => {
    const params = {
      transfers: [
        transfer({ transaction: '0x0a', block: 100, tokenCount: 2 }),
        transfer({ transaction: '0x0b', block: 101, tokenCount: 1 })
      ],
      afterBlock: 100,
      finalRows: [finalRow(K1, 1, null, -1)],
      balances: new Map([[K1, 1]]),
      distributionAirdropCount: () => 3
    };
    const legacy = matchRedemptions(params);
    expect(legacy.skipped).toEqual([]);
    expect(legacy.redeemed).toHaveLength(1);
    const fixed = matchRedemptions({ ...params, legacyDecimalConcat: false });
    expect(fixed.skipped.map((s) => s.reason)).toEqual(['DISTRIBUTION_AIRDROP']);
  });

  it('only processes transfers above the cursor', () => {
    const result = matchRedemptions({
      transfers: [transfer({ block: 50 })],
      afterBlock: 50,
      finalRows: [finalRow(K1, 1, null, -1)],
      balances: new Map([[K1, 1]]),
      distributionAirdropCount: noDistribution
    });
    expect(result.redeemed).toEqual([]);
  });
});
