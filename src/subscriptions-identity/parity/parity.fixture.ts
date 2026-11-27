import { MEMES_CONTRACT } from '@/constants';
import { LegacyOutputs } from './legacy-outputs';
import { ParitySnapshot, SubscriberSnapshot } from './snapshot';

/**
 * One small card's worth of public data, consistent with the legacy rules:
 * four keys, three on the list, three phases and four airdrop mints. Shared
 * by the parity tests. Addresses are placeholders.
 */
export const CARD = 500;
export const CUTOFF = Date.parse('2026-11-25T00:00:00.000Z');
export const BUILD_AT = Date.parse('2026-11-25T00:01:00.000Z');
export const BUILD_DATE = '2026-11-25';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
export const K1 = addr(1);
export const K2 = `${addr(2)}-${addr(3)}`;
export const K3 = addr(4);
export const K4 = addr(5);
export const A1 = addr(0xa1);
export const A2 = addr(0xa2);
export const A4 = addr(0xa4);
export const ARTIST = addr(0xee);

const SEP_1 = Date.parse('2026-09-01T12:00:00.000Z');
const NOV_20 = Date.parse('2026-11-20T10:00:00.000Z');
const NOV_21 = Date.parse('2026-11-21T10:00:00.000Z');
const OCT_5 = Date.parse('2026-10-05T08:00:00.000Z');
const TUE_BUILD = Date.parse('2026-11-24T00:01:05.000Z');
const COLLECTED = Date.parse('2026-11-24T22:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let logId = 1000;
const log = (
  createdAtMs: number,
  text: string,
  info: string | null = null
) => ({
  id: logId++,
  createdAtMs,
  log: text,
  additionalInfo: info
});

function subscriber(
  key: string,
  details: SubscriberSnapshot['details'],
  upcoming: SubscriberSnapshot['upcoming'],
  airdropAddress: string,
  logs: SubscriberSnapshot['logs']
): SubscriberSnapshot {
  return {
    key,
    collectedAtMs: COLLECTED,
    details,
    upcoming,
    airdrop: { airdropAddress, tdhWallet: key.split('-')[0] },
    logs: logs.slice().sort((a, b) => b.id - a.id)
  };
}

export function paritySnapshot(): ParitySnapshot {
  return {
    version: 1,
    contract: MEMES_CONTRACT,
    tokenId: CARD,
    cutoffMs: CUTOFF,
    collectedFromMs: COLLECTED,
    collectedToMs: COLLECTED + 60_000,
    subscribers: [
      subscriber(
        K1,
        {
          consolidation_key: K1,
          last_update: 0,
          balance: 0.5,
          automatic: false,
          subscribe_all_editions: false,
          subscription_eligibility_count: 3
        },
        { subscribed: true, eligibility: 3, count: 2, source: 'manual' },
        A1,
        [
          log(
            NOV_20,
            `Subscribed for Meme #${CARD}`,
            'Edition Preference: One edition - Eligibility: x3 - Subscription Count: x1'
          ),
          log(
            NOV_21,
            `Updated subscription count for Meme #${CARD} to x2`,
            'Eligibility: x3'
          )
        ]
      ),
      subscriber(
        K2,
        {
          consolidation_key: K2,
          last_update: SEP_1,
          balance: 1,
          automatic: true,
          subscribe_all_editions: true,
          subscription_eligibility_count: 2
        },
        { subscribed: true, eligibility: 2, count: 2, source: 'manual' },
        A2,
        [log(TUE_BUILD, `Auto-Subscribed to Meme #${CARD}`)]
      ),
      subscriber(
        K3,
        {
          consolidation_key: K3,
          last_update: OCT_5,
          balance: 0.03,
          automatic: true,
          subscribe_all_editions: false,
          subscription_eligibility_count: 1
        },
        { subscribed: true, eligibility: 1, count: 1, source: 'manual' },
        K3,
        [log(TUE_BUILD, `Auto-Subscribed to Meme #${CARD}`)]
      ),
      subscriber(
        K4,
        {
          consolidation_key: K4,
          last_update: OCT_5 + 1000,
          balance: 0.2,
          automatic: true,
          subscribe_all_editions: false,
          subscription_eligibility_count: 1
        },
        { subscribed: true, eligibility: 1, count: 1, source: 'automatic' },
        A4,
        []
      )
    ]
  };
}

const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

export function legacyOutputs(): LegacyOutputs {
  const added = (airdrop: string, count: number, balance: number) =>
    `Airdrop Address: ${airdrop} - Subscription Count: x${count} - Balance: ${balance} ETH`;
  const addedLog = `Added to Final Subscription for Meme #${CARD} on ${BUILD_DATE}`;
  const finalRow = (
    key: string,
    count: number,
    airdrop: string,
    balance: number,
    subscribedAt: number,
    phase: string,
    redeemed: number
  ) => ({
    consolidation_key: key,
    contract: MEMES_CONTRACT,
    token_id: CARD,
    subscribed_count: count,
    airdrop_address: airdrop,
    balance,
    subscribed_at: iso(subscribedAt),
    phase,
    phase_subscriptions: 1,
    phase_position: 1,
    redeemed_count: redeemed
  });
  return {
    version: 1,
    contract: MEMES_CONTRACT,
    tokenId: CARD,
    buildDate: BUILD_DATE,
    collectedFromMs: BUILD_AT + 3_600_000,
    collectedToMs: BUILD_AT + 3_700_000,
    csv: {
      uploadUrl: 'https://files.example/list',
      date: BUILD_DATE,
      rows: [
        {
          key: K2,
          count: 2,
          airdropAddress: A2,
          balance: 1,
          subscribedAt: iso(SEP_1)
        },
        {
          key: K4,
          count: 1,
          airdropAddress: A4,
          balance: 0.2,
          subscribedAt: iso(OCT_5 + 1000)
        },
        {
          key: K1,
          count: 2,
          airdropAddress: A1,
          balance: 0.5,
          subscribedAt: iso(NOV_21)
        }
      ]
    },
    buildDecisions: {
      [K1]: {
        kind: 'ADDED',
        date: BUILD_DATE,
        airdropAddress: A1,
        count: 2,
        balance: 0.5
      },
      [K2]: {
        kind: 'ADDED',
        date: BUILD_DATE,
        airdropAddress: A2,
        count: 2,
        balance: 1
      },
      [K3]: { kind: 'INSUFFICIENT_BALANCE', date: BUILD_DATE, balance: 0.03 },
      [K4]: {
        kind: 'ADDED',
        date: BUILD_DATE,
        airdropAddress: A4,
        count: 1,
        balance: 0.2
      }
    },
    logs: {
      [K1]: [log(BUILD_AT + 5000, addedLog, added(A1, 2, 0.5))],
      [K2]: [log(BUILD_AT + 5000, addedLog, added(A2, 2, 1))],
      [K4]: [
        log(BUILD_AT + 5000, addedLog, added(A4, 1, 0.2)),
        log(BUILD_AT + 4000, `Auto-Subscribed to Meme #${CARD}`)
      ]
    },
    finalRows: {
      [K1]: finalRow(K1, 2, A1, 0.5, NOV_21, 'Phase 0', 2),
      [K2]: finalRow(K2, 2, A2, 1, SEP_1, 'Phase 1', 2),
      [K4]: finalRow(K4, 1, A4, 0.2, OCT_5 + 1000, 'Public', 1)
    },
    phaseLists: {
      'Phase 0': [{ wallet: A1, amount: 2 }],
      'Phase 1': [{ wallet: A2, amount: 2 }],
      Public: [{ wallet: A4, amount: 1 }]
    },
    distributions: [
      {
        wallet: A1,
        airdrops: 0,
        allowlist: [
          { phase: 'Phase 0', spots: 2, spots_airdrop: 2, spots_allowlist: 0 }
        ]
      },
      {
        wallet: A2,
        airdrops: 0,
        allowlist: [
          { phase: 'Phase 1', spots: 2, spots_airdrop: 2, spots_allowlist: 0 }
        ]
      },
      { wallet: ARTIST, airdrops: 1, allowlist: [] }
    ],
    redeemed: [
      {
        contract: MEMES_CONTRACT,
        token_id: CARD,
        address: A1,
        transaction: TX(1),
        transaction_date: '2026-11-25T15:00:00.000Z',
        consolidation_key: K1,
        value: 0.13058,
        balance_after: 0.36942,
        count: 2
      },
      {
        contract: MEMES_CONTRACT,
        token_id: CARD,
        address: A2,
        transaction: TX(2),
        transaction_date: '2026-11-25T15:00:12.000Z',
        consolidation_key: K2,
        value: 0.13058,
        balance_after: 0.86942,
        count: 2
      },
      {
        contract: MEMES_CONTRACT,
        token_id: CARD,
        address: A4,
        transaction: TX(3),
        transaction_date: '2026-11-25T15:00:24.000Z',
        consolidation_key: K4,
        value: 0.06529,
        balance_after: 0.13471,
        count: 1
      }
    ],
    topUps: { [K1]: [], [K2]: [], [K4]: [] },
    airdropTransfers: [
      {
        transaction: TX(1),
        block: 1000,
        transactionDate: null,
        to: A1,
        contract: MEMES_CONTRACT,
        tokenId: CARD,
        tokenCount: 2
      },
      {
        transaction: TX(2),
        block: 1001,
        transactionDate: null,
        to: A2,
        contract: MEMES_CONTRACT,
        tokenId: CARD,
        tokenCount: 2
      },
      {
        transaction: TX(3),
        block: 1002,
        transactionDate: null,
        to: A4,
        contract: MEMES_CONTRACT,
        tokenId: CARD,
        tokenCount: 1
      },
      {
        transaction: TX(4),
        block: 1003,
        transactionDate: null,
        to: ARTIST,
        contract: MEMES_CONTRACT,
        tokenId: CARD,
        tokenCount: 1
      }
    ],
    cardCount: 5
  };
}
