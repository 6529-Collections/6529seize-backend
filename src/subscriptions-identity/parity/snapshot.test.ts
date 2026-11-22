import { MEMES_CONTRACT } from '@/constants';
import { LegacySubscriptionsApi } from './legacy-api';
import {
  BUILD_AT,
  CARD,
  CUTOFF,
  K1,
  K2,
  K4,
  paritySnapshot
} from './parity.fixture';
import { PublicApiClient } from './public-api-client';
import { candidateKeys, collectSnapshot, toBuildInputs } from './snapshot';

function fakeApi(routes: Record<string, unknown>): LegacySubscriptionsApi {
  let now = 0;
  return new LegacySubscriptionsApi(
    new PublicApiClient({
      baseUrl: 'https://api.example/api',
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      httpGet: async (url) => {
        const path = url.replace('https://api.example/api', '');
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
}

describe('toBuildInputs', () => {
  it('turns the fixture snapshot into the engine inputs', () => {
    const { inputs, notes } = toBuildInputs(paritySnapshot(), {
      buildAtMs: BUILD_AT
    });
    const byKey = new Map(inputs.map((i) => [i.key, i]));
    expect(byKey.get(K1)).toEqual({
      key: K1,
      balance: 0.5,
      mode: null,
      card: {
        subscribed: true,
        subscribedCount: 2,
        automaticSubscription: false,
        updatedAtMs: Date.parse('2026-11-21T10:00:00.000Z')
      },
      eligibility: 3
    });
    expect(byKey.get(K2)?.card?.automaticSubscription).toBe(true);
    expect(byKey.get(K4)?.card).toBeNull();
    expect(notes.get(K4)).toEqual([]);
  });

  it('rolls a key forward with log lines read after the snapshot', () => {
    const snapshot = paritySnapshot();
    const later = new Map([
      [
        K1,
        [
          {
            id: 5000,
            createdAtMs: CUTOFF - 60_000,
            log: `Unsubscribed from Meme #${CARD}`,
            additionalInfo: null
          },
          {
            id: 5001,
            createdAtMs: CUTOFF - 30_000,
            log: 'Subscription Mode set to Automatic',
            additionalInfo: null
          },
          {
            id: 5002,
            createdAtMs: CUTOFF + 30_000,
            log: `Subscribed for Meme #${CARD}`,
            additionalInfo: null
          }
        ]
      ]
    ]);
    const { inputs, notes } = toBuildInputs(snapshot, {
      buildAtMs: BUILD_AT,
      laterLogs: later
    });
    const k1 = inputs.find((i) => i.key === K1)!;
    expect(k1.card?.subscribed).toBe(false);
    expect(k1.mode).toEqual({
      automatic: true,
      subscribeAllEditions: false,
      updatedAtMs: CUTOFF - 30_000
    });
    expect(notes.get(K1)).toEqual(['LATER_LOGS_APPLIED', 'ROW_FLAG_AMBIGUOUS']);
  });

  it('reads the card row from logs when the status route gave nothing', () => {
    const snapshot = paritySnapshot();
    const { inputs, notes } = toBuildInputs(
      {
        ...snapshot,
        subscribers: snapshot.subscribers.map((s) => ({ ...s, upcoming: null }))
      },
      { buildAtMs: BUILD_AT }
    );
    expect(inputs.find((i) => i.key === K1)?.card).toEqual({
      subscribed: true,
      subscribedCount: 2,
      automaticSubscription: false,
      updatedAtMs: Date.parse('2026-11-21T10:00:00.000Z')
    });
    expect(inputs.find((i) => i.key === K2)?.card?.subscribedCount).toBe(1);
    expect(inputs.find((i) => i.key === K4)?.card).toBeNull();
    expect(notes.get(K1)).toEqual(['CARD_FROM_LOGS']);
  });

  it('rolls back mode lines written after the build for a late read', () => {
    const snapshot = paritySnapshot();
    const late = {
      ...snapshot,
      subscribers: snapshot.subscribers.map((s) =>
        s.key === K1 && s.details
          ? {
              ...s,
              collectedAtMs: BUILD_AT + 3_600_000,
              details: {
                ...s.details,
                automatic: true,
                last_update: BUILD_AT + 600_000
              },
              logs: [
                {
                  id: 9000,
                  createdAtMs: BUILD_AT + 600_000,
                  log: 'Subscription Mode set to Automatic',
                  additionalInfo: null
                },
                ...s.logs
              ]
            }
          : s
      )
    };
    const { inputs, notes } = toBuildInputs(late, { buildAtMs: BUILD_AT });
    expect(inputs.find((i) => i.key === K1)?.mode).toEqual({
      automatic: false,
      subscribeAllEditions: false,
      updatedAtMs: null
    });
    expect(notes.get(K1)).toContain('MODE_ROLLED_BACK');
  });

  it('uses the legacy build balance when pinned', () => {
    const { inputs } = toBuildInputs(paritySnapshot(), {
      buildAtMs: BUILD_AT,
      pinnedBalances: new Map<string, number | null>([
        [K1, 0.7],
        [K2, null]
      ])
    });
    expect(inputs.find((i) => i.key === K1)?.balance).toBe(0.7);
    expect(inputs.find((i) => i.key === K2)?.balance).toBeNull();
  });
});

describe('collectors', () => {
  it('lists candidate keys from recent published lists', async () => {
    const api = fakeApi({
      '/subscriptions/uploads': {
        count: 2,
        page: 1,
        next: null,
        data: [
          {
            contract: MEMES_CONTRACT,
            token_id: 499,
            date: '2026-11-23',
            upload_url: 'https://files.example/499'
          },
          {
            contract: MEMES_CONTRACT,
            token_id: 498,
            date: '2026-11-21',
            upload_url: 'https://files.example/498'
          }
        ]
      }
    });
    const files: Record<string, string> = {
      'https://files.example/499': `consolidation_key,token_id\n${K2.toUpperCase().replace('0X', '0x')},499\n`,
      'https://files.example/498': `consolidation_key,token_id\n${K1},498\n`
    };
    jest.spyOn(api, 'fileText').mockImplementation(async (url) => files[url]);
    expect(
      await candidateKeys(api, { recentLists: 1, extraKeys: [` ${K4} `] })
    ).toEqual([K2, K4]);
    expect(await candidateKeys(api, { recentLists: 2 })).toEqual([K1, K2]);
  });

  it('reads one key through the public routes', async () => {
    const api = fakeApi({
      [`/subscriptions/consolidation/details/${K1}`]: {
        consolidation_key: K1,
        last_update: 0,
        balance: 0.5,
        automatic: false,
        subscribe_all_editions: false,
        subscription_eligibility_count: 3
      },
      [`/subscriptions/consolidation/upcoming-memes/${CARD}/${K1}`]: {
        subscribed: true,
        eligibility: 3,
        count: 2,
        source: 'manual'
      },
      [`/subscriptions/consolidation/${K1}/airdrop-address`]: {
        tdh_wallet: { address: K1, ens: '' },
        airdrop_address: {
          address: K1.toUpperCase().replace('0X', '0x'),
          ens: ''
        }
      },
      [`/subscriptions/consolidation/logs/${K1}`]: {
        count: 1,
        page: 1,
        next: null,
        data: [
          {
            id: 7,
            created_at: '2026-11-21T10:00:00.000Z',
            consolidation_key: K1,
            log: `Subscribed for Meme #${CARD}`,
            additional_info: null
          }
        ]
      }
    });
    let t = 1000;
    const snapshot = await collectSnapshot(api, {
      tokenId: CARD,
      cutoffMs: CUTOFF,
      keys: [K1],
      logsSinceMs: 0,
      now: () => t++
    });
    expect(snapshot.subscribers[0]).toEqual({
      key: K1,
      collectedAtMs: 1001,
      details: expect.objectContaining({ balance: 0.5 }),
      upcoming: {
        subscribed: true,
        eligibility: 3,
        count: 2,
        source: 'manual'
      },
      airdrop: { airdropAddress: K1, tdhWallet: K1 },
      logs: [
        {
          id: 7,
          createdAtMs: Date.parse('2026-11-21T10:00:00.000Z'),
          log: `Subscribed for Meme #${CARD}`,
          additionalInfo: null
        }
      ]
    });
  });
});
