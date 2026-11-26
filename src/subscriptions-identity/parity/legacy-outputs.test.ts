import { MEMES_CONTRACT, NULL_ADDRESS } from '@/constants';
import { LegacySubscriptionsApi } from './legacy-api';
import {
  collectLegacyOutputs,
  toAirdropTransfers,
  toCsvRows
} from './legacy-outputs';
import { A1, BUILD_AT, BUILD_DATE, CARD, K1, K3 } from './parity.fixture';
import { PublicApiClient } from './public-api-client';

const page = (data: unknown[]) => ({
  count: data.length,
  page: 1,
  next: null,
  data
});

describe('legacy outputs', () => {
  it('reads list rows for the card only', () => {
    const text =
      'date,contract,token_id,count,profile,airdrop_address,consolidation_key,balance,subscribed_at\n' +
      `2026-11-25,c,${CARD},2,-,${A1.toUpperCase().replace('0X', '0x')},${K1},0.5,t\n` +
      `2026-11-25,c,499,1,-,null,${K3},1,t\n`;
    expect(toCsvRows(text, CARD)).toEqual([
      { key: K1, count: 2, airdropAddress: A1, balance: 0.5, subscribedAt: 't' }
    ]);
  });

  it('keeps only airdrop mints', () => {
    const base = {
      transaction: '0x01',
      block: 1,
      transaction_date: null,
      from_address: NULL_ADDRESS,
      to_address: A1,
      contract: MEMES_CONTRACT,
      token_id: CARD,
      token_count: 1,
      value: 0
    };
    expect(
      toAirdropTransfers([
        base,
        { ...base, value: 0.06529 },
        { ...base, from_address: K1 },
        { ...base, token_count: 0 }
      ])
    ).toEqual([
      {
        transaction: '0x01',
        block: 1,
        transactionDate: null,
        to: A1,
        contract: MEMES_CONTRACT,
        tokenId: CARD,
        tokenCount: 1
      }
    ]);
  });

  it('collects the published list, build lines, rows, phases and redemptions', async () => {
    const routes: Record<string, unknown> = {
      '/subscriptions/uploads': page([
        {
          contract: MEMES_CONTRACT,
          token_id: CARD,
          date: BUILD_DATE,
          upload_url: 'https://files.example/list'
        }
      ]),
      'https://files.example/list':
        'date,contract,token_id,count,profile,airdrop_address,consolidation_key,balance,subscribed_at\n' +
        `${BUILD_DATE},c,${CARD},2,-,${A1},${K1},0.5,t\n`,
      [`/subscriptions/consolidation/logs/${K1}`]: page([
        {
          id: 9,
          created_at: '2026-11-25T00:01:05.000Z',
          consolidation_key: K1,
          log: `Added to Final Subscription for Meme #${CARD} on ${BUILD_DATE}`,
          additional_info: `Airdrop Address: ${A1} - Subscription Count: x2 - Balance: 0.5 ETH`
        }
      ]),
      [`/subscriptions/consolidation/logs/${K3}`]: page([
        {
          id: 8,
          created_at: '2026-11-25T00:01:05.000Z',
          consolidation_key: K3,
          log: `No Balance for Meme #${CARD} on ${BUILD_DATE}`,
          additional_info: null
        }
      ]),
      [`/subscriptions/consolidation/final/${K1}/${MEMES_CONTRACT}/${CARD}`]: {
        consolidation_key: K1,
        contract: MEMES_CONTRACT,
        token_id: CARD,
        subscribed_count: 2,
        airdrop_address: A1,
        balance: 0.5,
        subscribed_at: 't',
        phase: 'Phase 0',
        phase_subscriptions: 1,
        phase_position: 1,
        redeemed_count: 0
      },
      [`/subscriptions/consolidation/top-up/${K1}`]: page([]),
      [`/subscriptions/consolidation/redeemed/${K1}`]: page([]),
      [`/subscriptions/final/${MEMES_CONTRACT}/${CARD}/phases/Phase%200`]: [
        { wallet: A1, amount: 2 }
      ],
      '/distributions': page([]),
      '/transactions': page([]),
      [`/subscriptions/memes/${CARD}/count`]: {
        contract: MEMES_CONTRACT,
        token_id: CARD,
        count: 2
      }
    };
    let now = 0;
    const requested: string[] = [];
    const api = new LegacySubscriptionsApi(
      new PublicApiClient({
        baseUrl: 'https://api.example/api',
        fileHosts: ['files.example'],
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        httpGet: async ({ url }) => {
          requested.push(url);
          const path = url.startsWith('https://api.example/api')
            ? url.replace('https://api.example/api', '')
            : url;
          const hit = Object.keys(routes).find(
            (p) => path === p || path.startsWith(`${p}?`)
          );
          if (hit === undefined) {
            return { status: 404, body: '' };
          }
          const value = routes[hit];
          return {
            status: 200,
            body: typeof value === 'string' ? value : JSON.stringify(value)
          };
        }
      })
    );
    const outputs = await collectLegacyOutputs(api, {
      tokenId: CARD,
      buildDate: BUILD_DATE,
      keys: [K3],
      logsSinceMs: 0,
      buildAtMs: BUILD_AT,
      now: () => 1
    });
    expect(outputs.csv?.rows).toHaveLength(1);
    expect(outputs.buildDecisions).toEqual({
      [K1]: {
        kind: 'ADDED',
        date: BUILD_DATE,
        airdropAddress: A1,
        count: 2,
        balance: 0.5
      },
      [K3]: { kind: 'NO_BALANCE', date: BUILD_DATE }
    });
    expect(Object.keys(outputs.finalRows)).toEqual([K1]);
    expect(outputs.phaseLists).toEqual({
      'Phase 0': [{ wallet: A1, amount: 2 }]
    });
    expect(outputs.cardCount).toBe(2);
    expect(requested.some((u) => u.includes(`/final/${K3}/`))).toBe(false);
    expect(requested.every((u) => u.startsWith('https://'))).toBe(true);
  });
});
