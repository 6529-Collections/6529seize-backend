import { LegacySubscriptionsApi } from './legacy-api';
import { readMirrorKeyMap } from './mirror-key-map';
import { K1, K2, K3, paritySnapshot } from './parity.fixture';
import { PublicApiClient } from './public-api-client';

const MOVED = `${K1}-0x00000000000000000000000000000000000000c1`;

describe('readMirrorKeyMap', () => {
  it('maps moved keys and lists keys whose wallets split', async () => {
    const [w2, w3] = K2.split('-');
    const now: Record<string, string> = {
      [K1]: MOVED,
      [w2]: w2,
      [w3]: w3,
      [K3]: K3
    };
    let clock = 0;
    const api = new LegacySubscriptionsApi(
      new PublicApiClient({
        baseUrl: 'https://api.example/api',
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        httpGet: async ({ url }) => {
          const wallet = url.split('/').pop() ?? '';
          const key = now[wallet];
          return key
            ? { status: 200, body: JSON.stringify({ consolidation_key: key }) }
            : { status: 404, body: '' };
        }
      })
    );
    expect(await readMirrorKeyMap(api, paritySnapshot())).toEqual({
      keyMap: { [K1]: MOVED },
      splits: { [K2]: [w2, w3] }
    });
  });
});
