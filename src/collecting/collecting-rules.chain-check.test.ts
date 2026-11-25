import { id as eventTopic, zeroPadValue } from 'ethers';
import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { MARKET_SEAPORT } from '@/marketplace/seaport.registry';
import {
  SentEvidence,
  SentTransaction,
  sentTransactionProblem,
  settlementFromReceipt,
  settlementProblem,
  SettlementReceipt,
  unminedProblem,
  usedNonceOutcome
} from './collecting-rules.chain-check';
import type {
  CollectingRuleReview,
  CollectingRuleSettlement
} from './collecting-rules.types';

const RECIPIENT = '0x00000000000000000000000000000000000000b1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const SELLER = '0x00000000000000000000000000000000000000b3';
const FUNDING = '0x00000000000000000000000000000000000000b4';
const MEMES = MEMES_CONTRACT.toLowerCase();
const GRADIENT = GRADIENT_CONTRACT.toLowerCase();
const HASH = `0x${'ab'.repeat(32)}`;

const word = (value: bigint | number) =>
  BigInt(value).toString(16).padStart(64, '0');
const topic = (address: string) => zeroPadValue(address, 32);

const transferSingle = (to: string, token: number, value: number) => ({
  address: MEMES,
  topics: [
    eventTopic('TransferSingle(address,address,address,uint256,uint256)'),
    topic(SELLER),
    topic(SELLER),
    topic(to)
  ],
  data: `0x${word(token)}${word(value)}`
});

const transfer721 = (to: string, token: number) => ({
  address: GRADIENT,
  topics: [
    eventTopic('Transfer(address,address,uint256)'),
    topic(SELLER),
    topic(to),
    `0x${word(token)}`
  ],
  data: '0x'
});

const receipt = (
  logs: SettlementReceipt['logs'],
  status = 1
): SettlementReceipt => ({
  status,
  gasUsed: BigInt(21_000),
  gasPrice: BigInt(3),
  logs
});

const review = (
  assetKey = `1:${MEMES}:7`,
  quantity = '2'
): CollectingRuleReview => ({
  operation_id: 'op-1',
  quote_id: 'quote-1',
  profile_id: 'profile-1',
  funding_wallet: FUNDING,
  recipient: RECIPIENT,
  valid_until: 1_000,
  assets: [{ asset_key: assetKey, quantity, unit_price_wei: '500' }],
  item_cost_wei: (BigInt(500) * BigInt(quantity)).toString(),
  gas_reserve_wei: '70000'
});

const paid = (changes: Partial<SentTransaction> = {}): SentTransaction => ({
  from: FUNDING,
  to: MARKET_SEAPORT,
  value: BigInt(1000),
  nonce: 7,
  ...changes
});

const evidence = (
  onChain: SettlementReceipt | null,
  transaction: SentTransaction | null = paid()
): SentEvidence => ({ transaction, receipt: onChain });

const settlement = (
  changes: Partial<CollectingRuleSettlement> = {}
): CollectingRuleSettlement => ({
  operation_id: 'op-1',
  status: 'confirmed',
  transaction_hash: HASH,
  recipient: RECIPIENT,
  assets: [{ asset_key: `1:${MEMES}:7`, quantity: '2' }],
  item_cost_wei: '1000',
  gas_cost_wei: '63000',
  ...changes
});

describe('settlementProblem', () => {
  it('accepts the reviewed purchase, its assets at the recipient and the gas paid', () => {
    expect(
      settlementProblem(
        settlement(),
        review(),
        evidence(receipt([transferSingle(RECIPIENT, 7, 2)]))
      )
    ).toBeNull();
    expect(
      settlementProblem(
        settlement({
          assets: [{ asset_key: `1:${GRADIENT}:9`, quantity: '1' }],
          item_cost_wei: '500'
        }),
        review(`1:${GRADIENT}:9`, '1'),
        evidence(
          receipt([transfer721(RECIPIENT, 9)]),
          paid({ value: BigInt(500) })
        )
      )
    ).toBeNull();
  });

  it('accepts a partial fill at the reviewed unit price', () => {
    expect(
      settlementProblem(
        settlement({
          assets: [{ asset_key: `1:${MEMES}:7`, quantity: '1' }],
          item_cost_wei: '500'
        }),
        review(),
        evidence(receipt([transferSingle(RECIPIENT, 7, 1)]))
      )
    ).toBeNull();
  });

  it('accepts a reverted transaction that moved nothing', () => {
    expect(
      settlementProblem(
        settlement({ status: 'reverted', assets: [], item_cost_wei: '0' }),
        review(),
        evidence(receipt([], 0))
      )
    ).toBeNull();
  });

  it('refuses what Ethereum does not show', () => {
    const delivered = receipt([transferSingle(RECIPIENT, 7, 2)]);
    const cases: [CollectingRuleSettlement, SentEvidence, string][] = [
      [settlement(), evidence(null), 'no receipt'],
      [settlement(), evidence(delivered, null), 'not visible'],
      [
        settlement(),
        evidence(delivered, paid({ from: OTHER })),
        'not from the rule'
      ],
      [
        settlement(),
        evidence(delivered, paid({ to: OTHER })),
        'does not call the market'
      ],
      [settlement(), evidence(delivered, paid({ to: null })), 'market'],
      [
        settlement(),
        evidence(delivered, paid({ value: BigInt(999) })),
        'does not pay the reviewed cost'
      ],
      [
        settlement(),
        evidence(receipt([transferSingle(RECIPIENT, 7, 2)], 0)),
        'status'
      ],
      [settlement({ gas_cost_wei: '1' }), evidence(delivered), 'gas cost'],
      [
        settlement(),
        evidence(receipt([transferSingle(OTHER, 7, 2)])),
        'did not reach'
      ],
      [
        settlement(),
        evidence(receipt([transferSingle(RECIPIENT, 8, 2)])),
        'did not reach'
      ],
      [
        settlement(),
        evidence(receipt([transferSingle(RECIPIENT, 7, 1)])),
        'did not reach'
      ],
      [settlement({ item_cost_wei: '1001' }), evidence(delivered), 'item cost'],
      [
        settlement({ assets: [], item_cost_wei: '0' }),
        evidence(delivered),
        'bought nothing'
      ],
      [
        settlement({ status: 'cancelled', transaction_hash: null }),
        evidence(receipt([])),
        'not from a mined transaction'
      ]
    ];
    for (const [logged, onChain, problem] of cases) {
      expect(settlementProblem(logged, review(), onChain)).toContain(problem);
    }
  });
});

describe('sentTransactionProblem', () => {
  it('takes the reviewed purchase only', () => {
    expect(sentTransactionProblem(review(), paid())).toBeNull();
    expect(
      sentTransactionProblem(review(), paid({ from: FUNDING.toUpperCase() }))
    ).toBeNull();
    expect(sentTransactionProblem(review(), null)).toContain('not visible');
    expect(
      sentTransactionProblem(review(), paid({ value: BigInt(0) }))
    ).toContain('reviewed cost');
  });
});

describe('unminedProblem', () => {
  it('releases only what can never be mined', () => {
    // The wallet mined past nonce 7, and the hash has no receipt.
    expect(unminedProblem(null, 7, 8)).toBeNull();
    expect(unminedProblem(null, 7, 7)).toContain('nonce 7 is not used yet');
    expect(unminedProblem(receipt([]), 7, 9)).toContain('was mined');
    // A hash kept before nonces were: never released this way.
    expect(unminedProblem(null, null, 100)).toContain('nonce is not known');
  });
});

describe('usedNonceOutcome', () => {
  const REPLACED = `0x${'cd'.repeat(32)}`;
  const used = (transaction: SentTransaction, onChain: SettlementReceipt) => ({
    hash: REPLACED,
    transaction,
    receipt: onChain
  });

  it('settles the purchase sped up under another hash', () => {
    expect(
      usedNonceOutcome(
        review(),
        used(paid(), receipt([transferSingle(RECIPIENT, 7, 2)]))
      )
    ).toEqual({
      kind: 'settle',
      settlement: settlement({ transaction_hash: REPLACED })
    });
    // Reverted at the market contract: settled as reverted, its gas counted.
    expect(
      usedNonceOutcome(review(), used(paid(), receipt([], 0)))
    ).toMatchObject({ kind: 'settle', settlement: { status: 'reverted' } });
  });

  it('releases on a cancel or another trade', () => {
    expect(
      usedNonceOutcome(
        review(),
        used(paid({ to: FUNDING, value: BigInt(0) }), receipt([]))
      )
    ).toEqual({ kind: 'release' });
    expect(
      usedNonceOutcome(
        review(),
        used(
          paid({ value: BigInt(5) }),
          receipt([transferSingle(RECIPIENT, 9, 1)])
        )
      )
    ).toEqual({ kind: 'release' });
  });

  it('calls a delivery of the reviewed artwork that fails the checks a problem', () => {
    expect(
      usedNonceOutcome(
        review(),
        used(
          paid({ value: BigInt(999) }),
          receipt([transferSingle(RECIPIENT, 7, 2)])
        )
      )
    ).toMatchObject({
      kind: 'problem',
      problem: expect.stringContaining('cost')
    });
  });
});

describe('settlementFromReceipt', () => {
  it('settles what reached the recipient, at the reviewed unit price', () => {
    expect(
      settlementFromReceipt(
        review(),
        HASH,
        receipt([transferSingle(RECIPIENT, 7, 2)])
      )
    ).toEqual(settlement());
    // A partial fill: one of the two.
    expect(
      settlementFromReceipt(
        review(),
        HASH,
        receipt([transferSingle(RECIPIENT, 7, 1)])
      )
    ).toEqual(
      settlement({
        assets: [{ asset_key: `1:${MEMES}:7`, quantity: '1' }],
        item_cost_wei: '500'
      })
    );
    // Never more than reviewed, and nothing when it reverted.
    expect(
      settlementFromReceipt(
        review(),
        HASH,
        receipt([transferSingle(RECIPIENT, 7, 3)])
      ).assets
    ).toEqual([{ asset_key: `1:${MEMES}:7`, quantity: '2' }]);
    expect(settlementFromReceipt(review(), HASH, receipt([], 0))).toEqual(
      settlement({ status: 'reverted', assets: [], item_cost_wei: '0' })
    );
  });
});
