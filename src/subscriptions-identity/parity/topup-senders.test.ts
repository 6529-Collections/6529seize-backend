import { LegacySubscriptionsApi } from './legacy-api';
import { PublicApiClient } from './public-api-client';
import { collectTopUpSenderKeys, parseTopUpSender } from './topup-senders';

const W1 = '0x00000000000000000000000000000000000000a1';
const W2 = '0x00000000000000000000000000000000000000a2';
const W3 = '0x00000000000000000000000000000000000000a3';
const GROUP = `${W1}-0x00000000000000000000000000000000000000b1`;

const topUp = (wallet: string) =>
  `Subscription Top Up of 0.2 ETH from ${wallet}.\n\nView on 6529`;

describe('top-up senders', () => {
  it('reads the sender of a top-up drop only', () => {
    expect(parseTopUpSender(topUp(W1.toUpperCase().replace('0X', '0x')))).toBe(
      W1
    );
    expect(parseTopUpSender('Published provisional list')).toBeNull();
    expect(parseTopUpSender(null)).toBeNull();
  });

  it('pages back to the start time and resolves senders to their keys', async () => {
    const pages: Record<string, unknown> = {
      first: {
        drops: [
          { serial_no: 30, created_at: 3000, parts: [{ content: topUp(W1) }] },
          { serial_no: 29, created_at: 2900, parts: [{ content: 'other' }] }
        ]
      },
      '29': {
        drops: [
          { serial_no: 28, created_at: 2800, parts: [{ content: topUp(W2) }] },
          { serial_no: 27, created_at: 1000, parts: [{ content: topUp(W3) }] }
        ]
      }
    };
    const requested: string[] = [];
    let now = 0;
    const api = new LegacySubscriptionsApi(
      new PublicApiClient({
        baseUrl: 'https://api.example/api',
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        httpGet: async ({ url }) => {
          requested.push(url);
          if (url.includes('/waves/w/drops')) {
            const before = /serial_no_less_than=(\d+)/.exec(url)?.[1];
            return {
              status: 200,
              body: JSON.stringify(pages[before ?? 'first'])
            };
          }
          if (url.endsWith(`/identities/by-wallet/${W1}`)) {
            return {
              status: 200,
              body: JSON.stringify({ consolidation_key: GROUP })
            };
          }
          return { status: 404, body: '' };
        }
      })
    );
    expect(
      await collectTopUpSenderKeys(api, { waveId: 'w', sinceMs: 2000 })
    ).toEqual([GROUP, W2]);
    expect(requested.some((u) => u.includes(W3))).toBe(false);
  });
});
