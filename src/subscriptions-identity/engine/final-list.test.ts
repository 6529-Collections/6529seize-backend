import fc from 'fast-check';
import { MEMES_CONTRACT, MEMES_MINT_PRICE } from '@/constants';
import {
  buildFinalList,
  compareFinalListRows,
  SubscriberBuildInput
} from './final-list';

const W1 = '0x0000000000000000000000000000000000000001';
const W2 = '0x0000000000000000000000000000000000000002';
const W3 = '0x0000000000000000000000000000000000000003';
const W9 = '0x0000000000000000000000000000000000000009';
const BUILD_AT = Date.parse('2026-11-25T00:01:00.000Z');
const T1 = Date.parse('2026-10-01T10:00:00.000Z');
const T2 = Date.parse('2026-10-02T10:00:00.000Z');

function subscriber(
  overrides: Partial<SubscriberBuildInput> & { key: string }
): SubscriberBuildInput {
  return {
    balance: 1,
    mode: null,
    card: null,
    eligibility: 1,
    ...overrides
  };
}

function build(subscribers: SubscriberBuildInput[]) {
  return buildFinalList({
    contract: MEMES_CONTRACT,
    tokenId: 500,
    buildAtMs: BUILD_AT,
    subscribers,
    resolveAirdrop: (key) => ({
      airdropAddress: key === W1 ? W9 : key.split('-')[0],
      tdhWallet: key.split('-')[0]
    })
  });
}

describe('buildFinalList', () => {
  it('adds a manual subscriber with its card row count and time', () => {
    const result = build([
      subscriber({
        key: W1,
        card: {
          subscribed: true,
          subscribedCount: 2,
          automaticSubscription: false,
          updatedAtMs: T1
        },
        eligibility: 3
      })
    ]);
    expect(result.rows).toEqual([
      {
        key: W1,
        contract: MEMES_CONTRACT,
        tokenId: 500,
        subscribedCount: 2,
        airdropAddress: W9,
        balance: 1,
        subscribedAt: new Date(T1).toISOString()
      }
    ]);
  });

  it('populates automatic subscribers and orders them by mode time', () => {
    const result = build([
      subscriber({
        key: W2,
        mode: { automatic: true, subscribeAllEditions: true, updatedAtMs: T1 },
        eligibility: 4
      })
    ]);
    expect(result.autoPopulated).toEqual([{ key: W2, subscribedCount: 4 }]);
    expect(result.rows[0].subscribedCount).toBe(4);
    expect(result.rows[0].subscribedAt).toBe(new Date(T1).toISOString());
  });

  it('does not populate over an existing unsubscribed row', () => {
    const result = build([
      subscriber({
        key: W2,
        mode: { automatic: true, subscribeAllEditions: false, updatedAtMs: T1 },
        card: {
          subscribed: false,
          subscribedCount: 1,
          automaticSubscription: false,
          updatedAtMs: T2
        }
      })
    ]);
    expect(result.rows).toEqual([]);
    expect(result.autoPopulated).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it('caps by balance with the legacy double floor', () => {
    const balance = Math.round(27 * MEMES_MINT_PRICE * 100000) / 100000;
    const result = build([
      subscriber({
        key: W1,
        balance,
        eligibility: 30,
        card: {
          subscribed: true,
          subscribedCount: 27,
          automaticSubscription: false,
          updatedAtMs: T1
        }
      })
    ]);
    expect(result.rows[0].subscribedCount).toBe(26);
  });

  it('records short and missing balances and pushes automatic ones back', () => {
    const result = build([
      subscriber({
        key: W1,
        balance: 0.05,
        mode: { automatic: true, subscribeAllEditions: false, updatedAtMs: T1 }
      }),
      subscriber({
        key: W2,
        balance: null,
        card: {
          subscribed: true,
          subscribedCount: 1,
          automaticSubscription: false,
          updatedAtMs: T1
        }
      })
    ]);
    expect(result.rows).toEqual([]);
    expect(result.decisions).toEqual([
      { kind: 'INSUFFICIENT_BALANCE', key: W1, balance: 0.05 },
      { kind: 'NO_BALANCE', key: W2 }
    ]);
    expect(result.queuePushedKeys).toEqual([W1]);
  });

  it('uses current eligibility only for untouched automatic all-editions rows', () => {
    const card = {
      subscribed: true,
      subscribedCount: 1,
      automaticSubscription: true,
      updatedAtMs: T1
    };
    const mode = {
      automatic: true,
      subscribeAllEditions: true,
      updatedAtMs: T1
    };
    const auto = build([subscriber({ key: W1, card, mode, eligibility: 3 })]);
    const manual = build([
      subscriber({
        key: W1,
        card: { ...card, automaticSubscription: false },
        mode,
        eligibility: 3
      })
    ]);
    expect(auto.rows[0].subscribedCount).toBe(3);
    expect(manual.rows[0].subscribedCount).toBe(1);
  });

  it('leaves out a row whose count is not positive', () => {
    const result = build([
      subscriber({
        key: W3,
        card: {
          subscribed: true,
          subscribedCount: 0,
          automaticSubscription: false,
          updatedAtMs: T1
        }
      })
    ]);
    expect(result.rows).toEqual([]);
    expect(result.decisions[0].kind).toBe('NO_COUNT');
  });

  it('orders by subscribed_at, then balance descending', () => {
    const card = (updatedAtMs: number) => ({
      subscribed: true,
      subscribedCount: 1,
      automaticSubscription: false,
      updatedAtMs
    });
    const result = build([
      subscriber({ key: W3, card: card(T2), balance: 5 }),
      subscriber({ key: W1, card: card(T1), balance: 1 }),
      subscriber({ key: W2, card: card(T1), balance: 2 })
    ]);
    expect(result.rows.map((r) => r.key)).toEqual([W2, W1, W3]);
  });

  it('never adds a row the balance cannot pay for, and never exceeds eligibility', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500000 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (units, eligibility, requested) => {
          const balance = units / 100000;
          const result = build([
            subscriber({
              key: W1,
              balance,
              eligibility,
              card: {
                subscribed: true,
                subscribedCount: requested,
                automaticSubscription: false,
                updatedAtMs: T1
              }
            })
          ]);
          for (const row of result.rows) {
            expect(row.subscribedCount).toBeGreaterThanOrEqual(1);
            expect(row.subscribedCount).toBeLessThanOrEqual(eligibility);
            expect(row.subscribedCount).toBeLessThanOrEqual(requested);
            expect(row.subscribedCount * MEMES_MINT_PRICE).toBeLessThanOrEqual(
              balance + 1e-9
            );
          }
        }
      )
    );
  });

  it('compares rows as the legacy sort does', () => {
    const a = { subscribedAt: '2026-10-01T00:00:00.000Z', balance: 1 };
    const b = { subscribedAt: '2026-10-01T00:00:00.000Z', balance: 2 };
    expect(compareFinalListRows(a, b)).toBeGreaterThan(0);
    expect(
      compareFinalListRows(a, {
        ...b,
        subscribedAt: '2026-10-02T00:00:00.000Z'
      })
    ).toBe(-1);
  });
});
