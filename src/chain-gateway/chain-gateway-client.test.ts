import { createHash } from 'node:crypto';
import {
  bytesMatchCid,
  ChainGatewayClient,
  ChainGatewayConfig,
  chainGatewayConfigFromEnv,
  ChainGatewayError,
  cidHex,
  cidPath,
  LruCache,
  rawCidHexOf
} from './chain-gateway.client';

const BASE = 'https://gateway.test';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

type Reply =
  | {
      status: number;
      json?: unknown;
      bytes?: Buffer;
      headers?: Record<string, string>;
    }
  | Error;

function stamp(height: number, at: 'finalized' | 'head' = 'finalized') {
  return {
    at,
    height,
    root: '0x' + '11'.repeat(32),
    slot: height + 10,
    time: 1_764_000_000_000 + height,
    finalizedHeight: height,
    headHeight: height + 3,
    network: '0x' + '22'.repeat(32)
  };
}

function status(finalized: number) {
  return {
    status: 200,
    json: {
      read: stamp(finalized, 'head'),
      data: {
        api: '1',
        node: 'rc',
        ready: true,
        head: stamp(finalized + 3, 'head'),
        finalized: stamp(finalized),
        pinnable: { from: finalized - 63, to: finalized },
        ruleVersion: 6
      },
      next: null
    }
  };
}

function setup(
  route: (call: Call) => Reply,
  config: Partial<ChainGatewayConfig> = {}
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const fetchImpl = async (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }
  ) => {
    const call = {
      method: init.method,
      url,
      headers: init.headers,
      body: init.body
    };
    calls.push(call);
    const reply = route(call);
    if (reply instanceof Error) {
      throw reply;
    }
    const text = reply.json === undefined ? '' : JSON.stringify(reply.json);
    return {
      status: reply.status,
      headers: {
        get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null
      },
      text: async () => text,
      arrayBuffer: async () => {
        const bytes = reply.bytes ?? Buffer.from(text);
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
      }
    };
  };
  const client = new ChainGatewayClient(() => ({
    baseUrl: BASE,
    serviceKey: 'service-key',
    timeoutMs: 1_000,
    retries: 2,
    headTtlMs: 2_000,
    cacheEntries: 100,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => now,
    ...config
  }));
  return {
    client,
    calls,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

const path = (call: Call) => new URL(call.url).pathname;
const OTHER_NETWORK = '0x' + '99'.repeat(32);

/** A route that answers the status at `finalized`, and `rest` otherwise. */
function withStatus(rest: (call: Call) => Reply, finalized = 1000) {
  return (call: Call): Reply =>
    path(call) === '/v1/status' ? status(finalized) : rest(call);
}

function withoutNetwork<T extends { network?: string }>(value: T): T {
  const copy = { ...value };
  delete copy.network;
  return copy;
}

const reads = (calls: Call[]) => calls.filter((c) => path(c) !== '/v1/status');

/** A feed block as the node writes it. */
function feedBlock(height: number, complete = true, recordsFrom = 0) {
  return {
    height,
    slot: 0,
    root: '0x',
    time: 1,
    complete,
    recordsFrom,
    records: []
  };
}
const param = (call: Call, name: string) =>
  new URL(call.url).searchParams.get(name);

const IDENTITY = {
  principalId: '0x' + 'ab'.repeat(32),
  handle: 'alice',
  wallets: ['0x' + '01'.repeat(20)]
};

describe('ChainGatewayClient reads', () => {
  it('pins a read to the finalized height and caches it by height', async () => {
    let finalized = 1200;
    const { client, calls, advance } = setup((call) => {
      if (path(call) === '/v1/status') return status(finalized);
      return {
        status: 200,
        json: {
          read: stamp(Number(param(call, 'height'))),
          data: IDENTITY,
          next: null
        }
      };
    });
    expect(await client.getIdentityByHandle('Alice')).toEqual(IDENTITY);
    expect(await client.getIdentityByHandle('alice')).toEqual(IDENTITY);
    const reads = calls.filter((c) => path(c) !== '/v1/status');
    expect(reads).toHaveLength(1);
    expect(path(reads[0])).toBe('/v1/identities/by-handle/alice');
    expect(param(reads[0], 'height')).toBe('1200');
    expect(reads[0].headers.authorization).toBe('Bearer service-key');
    expect(calls.filter((c) => path(c) === '/v1/status')).toHaveLength(1);

    // The head is cached for headTtlMs, then the new height reads again.
    finalized = 1201;
    advance(2_500);
    await client.getIdentityByHandle('alice');
    const later = calls.filter((c) => path(c) !== '/v1/status');
    expect(later).toHaveLength(2);
    expect(param(later[1], 'height')).toBe('1201');
  });

  it("reads the chain's network id with the head", async () => {
    const { client } = setup(() => status(1200));
    expect((await client.getHead()).network).toBe('0x' + '22'.repeat(32));
  });

  it('drops cached answers when the network changes (a relaunch)', async () => {
    let network = '0x' + '22'.repeat(32);
    let handle = 'old-chain';
    const { client, calls, advance } = setup((call) => {
      if (path(call) === '/v1/status') {
        const answer = status(1200);
        answer.json.data.finalized = { ...answer.json.data.finalized, network };
        return answer;
      }
      return {
        status: 200,
        json: {
          read: { ...stamp(1200), network },
          data: { ...IDENTITY, handle },
          next: null
        }
      };
    });
    expect((await client.getIdentityByHandle('alice'))?.handle).toBe(
      'old-chain'
    );
    network = '0x' + '33'.repeat(32);
    handle = 'new-chain';
    advance(2_500);
    expect((await client.getIdentityByHandle('alice'))?.handle).toBe(
      'new-chain'
    );
    expect(calls.filter((c) => path(c) !== '/v1/status')).toHaveLength(2);
  });

  it('reads at a given height, asking for the head once for its network', async () => {
    const { client, calls } = setup(
      withStatus(() => ({
        status: 200,
        json: { read: stamp(900), data: { level: 8 }, next: null }
      }))
    );
    await client.getLevel('0xAB', { height: 900 });
    await client.getLevel('0xab', { height: 900 });
    expect(calls.filter((c) => path(c) === '/v1/status')).toHaveLength(1);
    expect(reads(calls)).toHaveLength(1);
    expect(path(reads(calls)[0])).toBe('/v1/levels/0xab');
    expect(param(reads(calls)[0], 'height')).toBe('900');
  });

  it('reads the head unpinned and uncached', async () => {
    const { client, calls } = setup(
      withStatus(() => ({
        status: 200,
        json: {
          read: stamp(5, 'head'),
          data: { status: 'pending' },
          next: null
        }
      }))
    );
    await client.getTx('0xAA');
    await client.getTx('0xaa');
    expect(reads(calls)).toHaveLength(2);
    expect(param(reads(calls)[0], 'at')).toBe('head');
    expect(param(reads(calls)[0], 'height')).toBeNull();
  });

  it('takes a pinned answer only when read finalized at that height', async () => {
    let at: 'finalized' | 'head' = 'head';
    let height = 900;
    const { client, calls } = setup(
      withStatus(() => ({
        status: 200,
        json: { read: stamp(height, at), data: { level: 8 }, next: null }
      }))
    );
    // The node has 900 only as its head: gone for a finalized read.
    await expect(
      client.getLevel('0x01', { height: 900 })
    ).rejects.toMatchObject({ code: 'height_gone' });
    at = 'finalized';
    height = 899;
    await expect(
      client.getLevel('0x01', { height: 900 })
    ).rejects.toMatchObject({ code: 'bad_answer' });
    expect(reads(calls)).toHaveLength(2);
    height = 900;
    await client.getLevel('0x01', { height: 900 });
    await client.getLevel('0x01', { height: 900 });
    expect(reads(calls)).toHaveLength(3);
  });

  it('re-pins a read without a height that a node answers from its head', async () => {
    const { client, calls } = setup(
      withStatus((call) => {
        const height = param(call, 'height');
        return {
          status: 200,
          json: {
            read: stamp(
              height === null ? 48 : 50,
              height ? 'head' : 'finalized'
            ),
            data: IDENTITY,
            next: null
          }
        };
      }, 50)
    );
    expect(await client.getIdentityByPrincipal('0xab')).toEqual(IDENTITY);
    expect(reads(calls).map((it) => param(it, 'height'))).toEqual([
      '50',
      '50',
      null
    ]);
  });

  it('keeps an answer under the network it was read from', async () => {
    const A = stamp(1).network;
    const B = OTHER_NETWORK;
    let network = A;
    let identityReads = 0;
    const statusOf = () => {
      const answer = status(10);
      answer.json.data.finalized = { ...answer.json.data.finalized, network };
      return answer;
    };
    const respond = (reply: { status: number; json: unknown }) => {
      const text = JSON.stringify(reply.json);
      return {
        status: reply.status,
        headers: { get: () => null },
        arrayBuffer: async () => {
          const bytes = Buffer.from(text);
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer;
        }
      };
    };
    const client: ChainGatewayClient = new ChainGatewayClient(() => ({
      baseUrl: BASE,
      serviceKey: null,
      timeoutMs: 1_000,
      retries: 0,
      headTtlMs: 60_000,
      cacheEntries: 10,
      fetchImpl: async (url: string) => {
        if (new URL(url).pathname === '/v1/status') return respond(statusOf());
        identityReads++;
        if (identityReads === 1) {
          // The chain flips while the read is in flight; B answers it.
          network = B;
          await client.getHead(true);
        }
        return respond({
          status: 200,
          json: { read: { ...stamp(10), network }, data: IDENTITY, next: null }
        });
      }
    }));
    await client.getHead();
    expect(await client.getLevel('0x01', { height: 10 })).toEqual(IDENTITY);
    // Read on B, kept on B: the head names B now, so it is served.
    expect(await client.getLevel('0x01', { height: 10 })).toEqual(IDENTITY);
    expect(identityReads).toBe(1);
    // Back on A: B's answer is not A's.
    network = A;
    await client.getHead(true);
    await client.getLevel('0x01', { height: 10 });
    expect(identityReads).toBe(2);
  });

  it('reads a pinned height again after a relaunch, once the head is old', async () => {
    let network = stamp(1).network;
    const { client, calls, advance } = setup((call) => {
      if (path(call) === '/v1/status') {
        const answer = status(10);
        answer.json.data.finalized = { ...answer.json.data.finalized, network };
        return answer;
      }
      return {
        status: 200,
        json: {
          read: { ...stamp(10), network },
          data: { level: network === OTHER_NETWORK ? 2 : 1 },
          next: null
        }
      };
    });
    expect(await client.getLevel('0x01', { height: 10 })).toEqual({ level: 1 });
    network = OTHER_NETWORK;
    advance(2_500);
    expect(await client.getLevel('0x01', { height: 10 })).toEqual({ level: 2 });
    expect(reads(calls)).toHaveLength(2);
  });

  it.each([
    [
      'a wallet history',
      '/v1/membership/wallets/0x01/history',
      (n: number) => ({ wallet: '0x01', changes: [], ranges: [[1, n]] })
    ],
    [
      'a membership day',
      '/v1/membership/days/26',
      (n: number) => ({ record: { day: 26 }, saved: n })
    ],
    ['a TDH day', '/v1/tdh/days/26', (n: number) => ({ day: 26, rows: n })],
    [
      'an identity without its level',
      '/v1/identities/0xab',
      (n: number) => ({ ...IDENTITY, level: null, rep: n })
    ],
    [
      'identities without their level',
      '/v1/identities/by-wallets',
      (n: number) => ({ '0x01': { ...IDENTITY, level: null, rep: n } })
    ]
  ])(
    'reads %s again at the same height: the node may add to it',
    async (_name, route, data) => {
      let n = 1;
      const { client, calls } = setup(
        withStatus(() => ({
          status: 200,
          json: { read: stamp(10), data: data(n), next: null }
        }))
      );
      expect((await client.read(route, {}, { height: 10 }))?.data).toEqual(
        data(1)
      );
      n = 2;
      expect((await client.read(route, {}, { height: 10 }))?.data).toEqual(
        data(2)
      );
      expect(reads(calls)).toHaveLength(2);
    }
  );

  it('keeps an identity with its level, and a level read, at that height', async () => {
    const { client, calls } = setup(
      withStatus(() => ({
        status: 200,
        json: {
          read: stamp(10),
          data: { ...IDENTITY, level: { level: 1, raw: '5' } },
          next: null
        }
      }))
    );
    await client.read('/v1/identities/0xab', {}, { height: 10 });
    await client.read('/v1/identities/0xab', {}, { height: 10 });
    expect(reads(calls)).toHaveLength(1);
  });

  it('serves a cached answer as a copy the caller can change', async () => {
    const { client } = setup(
      withStatus(() => ({
        status: 200,
        json: {
          read: stamp(1000),
          data: { ...IDENTITY, wallets: ['0x02', '0x01'] },
          next: null
        }
      }))
    );
    const first = await client.getIdentityByHandle('alice');
    first!.wallets.sort();
    const second = await client.getIdentityByHandle('alice');
    second!.wallets.push('0x03');
    expect((await client.getIdentityByHandle('alice'))?.wallets).toEqual([
      '0x02',
      '0x01'
    ]);
  });

  it('answers null for 404 and caches it at that height', async () => {
    const { client, calls } = setup((call) =>
      path(call) === '/v1/status'
        ? status(10)
        : {
            status: 404,
            json: {
              read: stamp(10),
              error: { code: 'not_found', message: 'none' }
            }
          }
    );
    expect(await client.getIdentityByWallet('0x' + '02'.repeat(20))).toBeNull();
    expect(await client.getIdentityByWallet('0x' + '02'.repeat(20))).toBeNull();
    expect(calls.filter((c) => path(c) !== '/v1/status')).toHaveLength(1);
  });

  it.each([
    ['without a body', undefined],
    ['without the node envelope', { message: 'no route' }],
    ["with the node's code but no read stamp", { error: 'not_found' }],
    [
      'with another code',
      { read: stamp(10), error: { code: 'no_route', message: 'x' } }
    ]
  ])('refuses a 404 %s', async (_name, json) => {
    const { client } = setup(withStatus(() => ({ status: 404, json }), 10));
    await expect(
      client.getIdentityByWallet('0x' + '02'.repeat(20))
    ).rejects.toMatchObject({ code: 'bad_answer', status: 404 });
  });

  it('refuses an answer without data or without its read stamp', async () => {
    let json: unknown = { read: stamp(10), next: null };
    const { client } = setup(withStatus(() => ({ status: 200, json }), 10));
    await expect(client.getLevel('0x01', { height: 10 })).rejects.toMatchObject(
      { code: 'bad_answer' }
    );
    json = { data: { level: 1 }, next: null };
    await expect(client.getLevel('0x01', { height: 10 })).rejects.toMatchObject(
      { code: 'bad_answer' }
    );
    // A null level is an answer: the node lacks that day's lists.
    json = { read: stamp(10), data: null, next: null };
    expect(await client.getLevel('0x01', { height: 10 })).toBeNull();
  });

  it('refuses a list that is not one, and a wallet left out', async () => {
    let data: unknown = { items: [] };
    const { client } = setup(
      withStatus(
        () => ({ status: 200, json: { read: stamp(10), data, next: null } }),
        10
      )
    );
    await expect(client.listIdentities()).rejects.toMatchObject({
      code: 'bad_answer'
    });
    data = { record: { day: 26 } };
    await expect(client.listMembershipDayWallets(26)).rejects.toMatchObject({
      code: 'bad_answer'
    });
    const left = '0x' + '01'.repeat(20);
    const asked = '0x' + '02'.repeat(20);
    data = { [asked]: null };
    await expect(client.getIdentitiesByWallets([left])).rejects.toMatchObject({
      code: 'bad_answer'
    });
    expect(await client.getIdentitiesByWallets([asked])).toEqual({
      [asked]: null
    });
  });

  it('refuses a 404 of another chain and keeps nothing of it', async () => {
    let network = OTHER_NETWORK;
    const { client } = setup(
      withStatus(
        () => ({
          status: network === OTHER_NETWORK ? 404 : 200,
          json:
            network === OTHER_NETWORK
              ? {
                  read: { ...stamp(10), network },
                  error: { code: 'not_found', message: 'none' }
                }
              : { read: stamp(10), data: IDENTITY, next: null }
        }),
        10
      )
    );
    await expect(client.getIdentityByPrincipal('0xab')).rejects.toMatchObject({
      code: 'wrong_network',
      status: 404
    });
    network = stamp(10).network;
    expect(await client.getIdentityByPrincipal('0xab')).toEqual(IDENTITY);
  });

  it('refuses another chain on the unpinned read after height_gone, and on the feed', async () => {
    const { client } = setup(
      withStatus((call) => {
        if (path(call) === '/v1/feed') {
          return {
            status: 200,
            json: {
              read: { ...stamp(50), network: OTHER_NETWORK },
              data: { through: 49, blocks: [] },
              next: '50'
            }
          };
        }
        if (param(call, 'height') !== null) {
          return {
            status: 409,
            json: {
              read: stamp(48),
              error: { code: 'height_gone', message: 'holds 1..48' }
            }
          };
        }
        return {
          status: 200,
          json: {
            read: { ...stamp(48), network: OTHER_NETWORK },
            data: IDENTITY,
            next: null
          }
        };
      }, 50)
    );
    await expect(client.getIdentityByPrincipal('0xab')).rejects.toMatchObject({
      code: 'wrong_network'
    });
    await expect(client.getChanges(50)).rejects.toMatchObject({
      code: 'wrong_network'
    });
  });

  it('refuses a status or an answer without its network id', async () => {
    let missing: 'status' | 'answer' = 'status';
    const { client } = setup((call) => {
      if (path(call) === '/v1/status') {
        const answer = status(10);
        if (missing === 'status') {
          answer.json.data.finalized = withoutNetwork(
            answer.json.data.finalized
          );
        }
        return answer;
      }
      const read = withoutNetwork(stamp(10));
      return { status: 200, json: { read, data: { level: 1 }, next: null } };
    });
    await expect(client.getHead()).rejects.toMatchObject({
      code: 'bad_answer'
    });
    missing = 'answer';
    await expect(client.getLevel('0x01', { height: 10 })).rejects.toMatchObject(
      { code: 'bad_answer' }
    );
  });

  it('reads the head again after an answer of another chain', async () => {
    let network = stamp(1).network;
    const { client, calls } = setup((call) => {
      if (path(call) === '/v1/status') {
        const answer = status(10);
        answer.json.data.finalized = { ...answer.json.data.finalized, network };
        return answer;
      }
      return {
        status: 200,
        json: {
          read: { ...stamp(10), network: OTHER_NETWORK },
          data: { level: 1 },
          next: null
        }
      };
    });
    await client.getHead();
    network = OTHER_NETWORK;
    await expect(client.getLevel('0x01', { height: 10 })).rejects.toMatchObject(
      { code: 'wrong_network' }
    );
    // The relaunch is seen at once: the next read is of the new chain.
    expect(calls.filter((c) => path(c) === '/v1/status')).toHaveLength(2);
    expect(await client.getLevel('0x01', { height: 10 })).toEqual({ level: 1 });
  });

  it('re-pins once on height_gone, then reads unpinned', async () => {
    const { client, calls } = setup((call) => {
      if (path(call) === '/v1/status') return status(50);
      if (param(call, 'height') !== null) {
        return {
          status: 409,
          json: {
            read: stamp(48),
            error: { code: 'height_gone', message: 'holds 1..48' }
          }
        };
      }
      return {
        status: 200,
        json: { read: stamp(48), data: IDENTITY, next: null }
      };
    });
    expect(await client.getIdentityByPrincipal('0xAB')).toEqual(IDENTITY);
    const reads = calls.filter((c) => path(c) !== '/v1/status');
    expect(reads.map((c) => param(c, 'height'))).toEqual(['50', '50', null]);
    expect(calls.filter((c) => path(c) === '/v1/status')).toHaveLength(2);
  });

  it('throws height_gone for an explicit height', async () => {
    const { client } = setup(() => ({
      status: 409,
      json: { read: stamp(1), error: { code: 'height_gone', message: 'x' } }
    }));
    await expect(client.getLevel('0x01', { height: 3 })).rejects.toMatchObject({
      code: 'height_gone',
      status: 409
    });
  });

  it('asks for many wallets 100 at a time at one height', async () => {
    const wallets = Array.from(
      { length: 150 },
      (_, i) => '0x' + i.toString(16).padStart(40, '0')
    );
    const { client, calls } = setup((call) => {
      if (path(call) === '/v1/status') return status(77);
      const asked = (param(call, 'wallets') ?? '').split(',');
      return {
        status: 200,
        json: {
          read: stamp(77),
          data: Object.fromEntries(
            asked.map((w, i) => [w, i % 2 === 0 ? IDENTITY : null])
          ),
          next: null
        }
      };
    });
    const result = await client.getIdentitiesByWallets([
      ...wallets.map((w) => w.toUpperCase().replace('0X', '0x')),
      wallets[0]
    ]);
    expect(Object.keys(result)).toHaveLength(150);
    expect(result[wallets[0]]).toEqual(IDENTITY);
    expect(result[wallets[1]]).toBeNull();
    const reads = calls.filter((c) => path(c) === '/v1/identities/by-wallets');
    expect(reads).toHaveLength(2);
    expect(reads.map((c) => param(c, 'height'))).toEqual(['77', '77']);
    expect((param(reads[0], 'wallets') ?? '').split(',')).toHaveLength(100);
  });

  it('routes delegation queries with their filters and pages', async () => {
    const { client, calls } = setup((call) =>
      path(call) === '/v1/status'
        ? status(9)
        : {
            status: 200,
            json: { read: stamp(9), data: [{ useCase: 2 }], next: 'cursor-2' }
          }
    );
    const page = await client.getDelegations(
      {
        byDelegate: '0xDD',
        useCase: 2,
        collection: '0xCC',
        live: true
      },
      { after: 'cursor-1', limit: 10 }
    );
    expect(page).toEqual({
      items: [{ useCase: 2 }],
      next: 'cursor-2',
      read: stamp(9)
    });
    const read = calls.find((c) => path(c) !== '/v1/status')!;
    expect(path(read)).toBe('/v1/delegations/by-delegate/0xdd');
    expect(Object.fromEntries(new URL(read.url).searchParams)).toEqual({
      useCase: '2',
      collection: '0xcc',
      live: '1',
      after: 'cursor-1',
      limit: '10',
      height: '9'
    });
    await client.getDelegations({ holder: '0xAA' });
    await client.getDelegations({ byCollection: '0xBB' });
    await client.getDelegations({ byUseCase: 997 });
    expect(
      calls
        .filter((c) => path(c) !== '/v1/status')
        .map(path)
        .slice(1)
    ).toEqual([
      '/v1/delegations/by-holder/0xaa',
      '/v1/delegations/by-collection/0xbb',
      '/v1/delegations/by-use-case/997'
    ]);
  });

  it('reads the membership of a day page by page', async () => {
    const { client, calls } = setup((call) =>
      path(call) === '/v1/status'
        ? status(9)
        : {
            status: 200,
            json: {
              read: stamp(9),
              data: {
                record: { day: 26 },
                wallets: [{ wallet: '0x1', principalId: '0x2' }]
              },
              next: null
            }
          }
    );
    const page = await client.listMembershipDayWallets(26, { limit: 5 });
    expect(page?.items).toEqual([{ wallet: '0x1', principalId: '0x2' }]);
    expect(path(calls[1])).toBe('/v1/membership/days/26/wallets');
  });

  it('follows the change feed by finalized height', async () => {
    const { client, calls: all } = setup(
      withStatus(() => ({
        status: 200,
        json: {
          read: stamp(120),
          data: { from: 100, through: 119, blocks: [] },
          next: 120
        }
      }))
    );
    expect(
      await client.getChanges(100, {
        limit: 20,
        families: ['0x0102', '0x0120']
      })
    ).toEqual({
      from: 100,
      through: 119,
      blocks: [],
      next: '120',
      nextHeight: 120,
      atHead: false,
      network: '0x' + '22'.repeat(32)
    });
    const calls = reads(all);
    expect(path(calls[0])).toBe('/v1/feed');
    expect(param(calls[0], 'families')).toBe('0x0102,0x0120');
    expect(param(calls[0], 'height')).toBeNull();
  });

  it('passes a cursor inside a block back as given, and keeps the whole height', async () => {
    const block = (complete: boolean) => ({
      ...feedBlock(120, complete, complete ? 4096 : 0),
      records: [{ family: '0x0104', name: 'Profile', key: '0x01', value: '0x' }]
    });
    const answers = [
      {
        status: 200,
        json: {
          read: stamp(130),
          data: { from: 120, through: 119, blocks: [block(false)] },
          next: '120:4096'
        }
      },
      {
        status: 200,
        json: {
          read: stamp(130),
          data: { from: '120:4096', through: 120, blocks: [block(true)] },
          next: 121
        }
      },
      {
        status: 200,
        json: {
          read: stamp(130),
          data: { from: 131, through: 130, blocks: [] },
          next: 131
        }
      }
    ];
    const { client, calls: all } = setup(withStatus(() => answers.shift()!));
    const first = await client.getChanges(120, { families: ['0x0104'] });
    expect(first).toEqual(
      expect.objectContaining({
        next: '120:4096',
        nextHeight: 120,
        atHead: false
      })
    );
    const second = await client.getChanges(first.next, {
      families: ['0x0104']
    });
    expect(param(reads(all)[1], 'from')).toBe('120:4096');
    expect(second).toEqual(
      expect.objectContaining({ next: '121', nextHeight: 121, atHead: false })
    );
    expect((await client.getChanges(131)).atHead).toBe(true);
  });

  it.each([
    ['blocks that are not a list', 120, { through: 120, blocks: 'none' }, null],
    [
      'blocks out of order',
      120,
      { through: 121, blocks: [feedBlock(121), feedBlock(120)] },
      '122'
    ],
    [
      'a next inside a block the page does not end in',
      120,
      { through: 120, blocks: [feedBlock(120)] },
      '121:4096'
    ],
    [
      'a whole block past through',
      120,
      { through: 119, blocks: [feedBlock(120)] },
      '120'
    ],
    [
      'two blocks at one height',
      120,
      { through: 120, blocks: [feedBlock(120), feedBlock(120)] },
      '121'
    ],
    [
      'a cut block before the last',
      120,
      { through: 121, blocks: [feedBlock(120, false), feedBlock(121)] },
      '122'
    ],
    [
      'a cut block inside the heights given whole',
      120,
      { through: 121, blocks: [feedBlock(120), feedBlock(121, false)] },
      '121:3'
    ],
    [
      'a cut block named by a cursor in another block',
      120,
      { through: 119, blocks: [feedBlock(120, false)] },
      '125:3'
    ],
    [
      'a whole next that skips heights',
      120,
      { through: 119, blocks: [] },
      '125'
    ],
    [
      'a next behind the height asked from',
      136,
      { through: 130, blocks: [] },
      '131'
    ],
    [
      'a cut block with a whole next',
      120,
      { through: 119, blocks: [feedBlock(120, false)] },
      '120'
    ],
    [
      'a block below the height asked from',
      120,
      { through: 121, blocks: [feedBlock(100), feedBlock(121)] },
      '122'
    ],
    [
      'a block asked from whole that starts inside',
      120,
      { through: 120, blocks: [feedBlock(120, true, 4096)] },
      '121'
    ],
    [
      'the block asked from inside, from its start',
      '120:4096',
      { through: 120, blocks: [feedBlock(120)] },
      '121'
    ],
    [
      'another block where the one asked from inside should be',
      '120:4096',
      { through: 121, blocks: [feedBlock(121)] },
      '122'
    ],
    [
      'a cut block whose next does not move on',
      '120:5',
      { through: 119, blocks: [feedBlock(120, false, 5)] },
      '120:5'
    ],
    [
      'a cursor that is not one',
      120,
      { through: 119, blocks: [feedBlock(120, false)] },
      '120:abc'
    ],
    [
      'a height that is not a number',
      120,
      { through: 120, blocks: [{ ...feedBlock(120), height: '120' }] },
      '121'
    ],
    [
      'no height',
      120,
      { through: 120, blocks: [{ ...feedBlock(120), height: null }] },
      '121'
    ],
    [
      'records that are not a list',
      120,
      { through: 120, blocks: [{ ...feedBlock(120), records: null }] },
      '121'
    ],
    [
      'a block that does not say whether it is whole',
      120,
      { through: 120, blocks: [{ ...feedBlock(120), complete: undefined }] },
      '121'
    ]
  ])('refuses a feed page with %s', async (_name, from, data, next) => {
    const { client } = setup(
      withStatus(() => ({
        status: 200,
        json: { read: stamp(130), data, next }
      }))
    );
    await expect(client.getChanges(from)).rejects.toMatchObject({
      code: 'bad_answer'
    });
  });

  it.each([
    ['a cut block two past through', 120, 119, 121, '121:1', 0],
    [
      'a filtered cut block whose next is its start',
      '120:5',
      119,
      120,
      '120:5',
      5
    ],
    [
      'a filtered cut block whose next is behind it',
      '120:5',
      119,
      120,
      '120:4',
      5
    ]
  ])('refuses %s', async (_name, from, through, height, next, recordsFrom) => {
    const record = {
      family: '0x0104',
      name: 'Profile',
      key: '0x01',
      value: '0x'
    };
    const { client } = setup(
      withStatus(() => ({
        status: 200,
        json: {
          read: stamp(130),
          data: {
            through,
            blocks: [
              { ...feedBlock(height, false, recordsFrom), records: [record] }
            ]
          },
          next
        }
      }))
    );
    await expect(
      client.getChanges(from, { families: ['0x0104'] })
    ).rejects.toMatchObject({ code: 'bad_answer' });
  });

  it('takes a page from a node behind the height asked from, without moving back', async () => {
    const answers = [
      { through: 130, next: '136' },
      { through: 130, next: '136' }
    ];
    const { client } = setup(
      withStatus(() => {
        const answer = answers.shift()!;
        return {
          status: 200,
          json: {
            read: stamp(130),
            data: { through: answer.through, blocks: [] },
            next: answer.next
          }
        };
      })
    );
    expect(await client.getChanges(136)).toEqual(
      expect.objectContaining({ nextHeight: 136, atHead: true, next: 136 })
    );
    // Asked from inside a block it doesn't have yet: the height stays.
    expect(await client.getChanges('136:40')).toEqual(
      expect.objectContaining({ nextHeight: 136, atHead: true, next: '136:40' })
    );
  });

  it('checks a cut block against its records without a family filter', async () => {
    const records = [
      { family: '0x0104', name: 'Profile', key: '0x01', value: '0x' },
      { family: '0x0104', name: 'Profile', key: '0x02', value: '0x' }
    ];
    let next = '120:5';
    const { client } = setup(
      withStatus(() => ({
        status: 200,
        json: {
          read: stamp(130),
          data: {
            through: 119,
            blocks: [{ ...feedBlock(120, false), records }]
          },
          next
        }
      }))
    );
    // Five writes from 0 can't be two records: unless a filter left some out.
    await expect(client.getChanges(120)).rejects.toMatchObject({
      code: 'bad_answer'
    });
    expect((await client.getChanges(120, { families: ['0x0104'] })).next).toBe(
      '120:5'
    );
    next = '120:2';
    expect((await client.getChanges(120)).next).toBe('120:2');
  });

  it('refuses a cursor that is not one before asking', async () => {
    const { client, calls } = setup(withStatus(() => new Error('not asked')));
    await expect(client.getChanges('12:x')).rejects.toMatchObject({
      code: 'bad_request'
    });
    expect(calls).toHaveLength(0);
  });

  it('says the head is reached on an empty page through its start', async () => {
    const { client } = setup(
      withStatus(() => ({
        status: 200,
        json: {
          read: stamp(130),
          data: { through: 120, blocks: [] },
          next: 121
        }
      }))
    );
    // Nothing past 120 yet, read from 120: 120 itself was given (empty).
    expect((await client.getChanges(120)).atHead).toBe(false);
    expect((await client.getChanges(121)).atHead).toBe(true);
  });

  it('refuses an answer read from another chain than the head', async () => {
    const { client, calls } = setup((call) =>
      path(call) === '/v1/status'
        ? status(50)
        : {
            status: 200,
            json: {
              read: { ...stamp(50), network: '0x' + '99'.repeat(32) },
              data: IDENTITY,
              next: null
            }
          }
    );
    await expect(client.getIdentityByHandle('alice')).rejects.toMatchObject({
      code: 'wrong_network'
    });
    await expect(client.getIdentityByHandle('alice')).rejects.toMatchObject({
      code: 'wrong_network'
    });
    expect(calls.filter((c) => path(c) !== '/v1/status')).toHaveLength(2);
  });

  it('refuses a feed page without a whole-height through', async () => {
    const { client } = setup(
      withStatus(() => ({
        status: 200,
        json: { read: stamp(130), data: { blocks: [] }, next: null }
      }))
    );
    await expect(client.getChanges(120)).rejects.toMatchObject({
      code: 'bad_answer'
    });
  });

  it('throws gone when the feed no longer holds the height', async () => {
    const { client } = setup(
      withStatus(() => ({
        status: 410,
        json: { read: stamp(1), error: { code: 'gone', message: 'from 50' } }
      }))
    );
    await expect(client.getChanges(1)).rejects.toMatchObject({ code: 'gone' });
  });
});

describe('ChainGatewayClient status and unpinned routes', () => {
  it("reads a node that isn't ready from its 503 status, without retrying", async () => {
    const { client, calls } = setup(() => {
      const answer = status(10);
      return {
        status: 503,
        json: {
          ...answer.json,
          data: { ...answer.json.data, ready: false, notReady: 'head behind' }
        }
      };
    });
    const head = await client.getHead();
    expect(head).toEqual(
      expect.objectContaining({
        finalizedHeight: 10,
        ready: false,
        notReady: 'head behind'
      })
    );
    expect(calls).toHaveLength(1);
    expect((await client.getHead(true)).ready).toBe(false);
  });

  it('retries a 503 status without a state, then throws it', async () => {
    const { client, calls } = setup(() => ({
      status: 503,
      json: { error: { code: 'starting', message: 'no state yet' } }
    }));
    await expect(client.getHead()).rejects.toMatchObject({
      code: 'starting',
      status: 503
    });
    expect(calls).toHaveLength(3);
  });

  it('says a ready node is ready', async () => {
    const { client } = setup(() => status(10));
    expect(await client.getHead()).toEqual(
      expect.objectContaining({ ready: true, notReady: null })
    );
  });

  it('reads the family table without a read stamp', async () => {
    const { client, calls } = setup(() => ({
      status: 200,
      json: { data: { families: [{ family: '0x0104', name: 'Profile' }] } }
    }));
    expect(await client.getFeedFamilies()).toEqual({
      families: [{ family: '0x0104', name: 'Profile' }]
    });
    expect(calls.map(path)).toEqual(['/v1/feed/families']);
  });

  it('reads the level ranking unpinned', async () => {
    const ranking = { rankedAt: 9, count: 1, rows: [] };
    const { client, calls } = setup(
      withStatus(() => ({
        status: 200,
        json: { read: stamp(10), data: ranking, next: 'cursor' }
      }))
    );
    const answer = await client.getLevelRanking({ after: 'a', limit: 5 });
    expect(answer.data).toEqual(ranking);
    expect(answer.next).toBe('cursor');
    const read = reads(calls)[0];
    expect(path(read)).toBe('/v1/identities/by-level');
    expect(param(read, 'height')).toBeNull();
    expect(param(read, 'at')).toBeNull();
    expect(param(read, 'after')).toBe('a');
  });

  it('refuses a read of the head at a height', async () => {
    const { client, calls } = setup(withStatus(() => new Error('not asked')));
    await expect(
      client.read('/v1/levels/0x01', {}, { at: 'head', height: 3 })
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('reads many wallets again at a fresh height when one is gone', async () => {
    let finalized = 50;
    const wallet = '0x' + '01'.repeat(20);
    const { client, calls } = setup((call) => {
      if (path(call) === '/v1/status') return status(finalized);
      if (param(call, 'height') === '50') {
        finalized = 51;
        return {
          status: 409,
          json: {
            read: stamp(51),
            error: { code: 'height_gone', message: 'x' }
          }
        };
      }
      return {
        status: 200,
        json: { read: stamp(51), data: { [wallet]: IDENTITY }, next: null }
      };
    });
    expect(await client.getIdentitiesByWallets([wallet])).toEqual({
      [wallet]: IDENTITY
    });
    expect(reads(calls).map((it) => param(it, 'height'))).toEqual(['50', '51']);
  });
});

describe('ChainGatewayClient retries and errors', () => {
  it("keeps a proxy's error status code for a page that isn't JSON", async () => {
    const { client } = setup(
      withStatus(() => ({
        status: 502,
        bytes: Buffer.from('<html>bad gateway</html>')
      }))
    );
    await expect(client.getLevel('0x01', { height: 3 })).rejects.toMatchObject({
      code: 'http_502',
      status: 502
    });
  });

  it('retries 503 and network errors, honouring Retry-After', async () => {
    let n = 0;
    const { client, calls, sleeps } = setup(
      withStatus(() => {
        n++;
        if (n === 1)
          return {
            status: 503,
            json: { error: { code: 'busy', message: 'busy' } },
            headers: { 'retry-after': '1' }
          };
        if (n === 2) return new Error('socket hang up');
        return {
          status: 200,
          json: { read: stamp(3), data: { level: 1 }, next: null }
        };
      })
    );
    expect(await client.getLevel('0x01', { height: 3 })).toEqual({ level: 1 });
    expect(reads(calls)).toHaveLength(3);
    expect(sleeps[0]).toBe(1_000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(400);
  });

  it('reads the proxy rate limit answer and retries it', async () => {
    let n = 0;
    const { client, calls } = setup(
      withStatus(() =>
        ++n === 1
          ? {
              status: 429,
              json: { error: 'rate_limited', message: 'slow down' },
              headers: { 'retry-after': '2' }
            }
          : {
              status: 200,
              json: { read: stamp(3), data: { level: 2 }, next: null }
            }
      )
    );
    expect(await client.getLevel('0x01', { height: 3 })).toEqual({ level: 2 });
    expect(reads(calls)).toHaveLength(2);
  });

  it('gives up after its retries with the last error', async () => {
    const { client, calls } = setup(() => ({
      status: 504,
      json: { error: { code: 'timeout', message: 'slow' } }
    }));
    await expect(client.getLevel('0x01', { height: 3 })).rejects.toMatchObject({
      code: 'timeout',
      status: 504
    });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a refusal', async () => {
    const { client, calls } = setup(() => ({
      status: 400,
      json: { read: stamp(1), error: { code: 'bad_request', message: 'no' } }
    }));
    const error = await client
      .getLevel('0x01', { height: 3 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainGatewayError);
    expect(error).toMatchObject({ code: 'bad_request', status: 400 });
    expect(calls).toHaveLength(1);
  });
});

describe('ChainGatewayClient writes', () => {
  it('drafts and relays signed operations', async () => {
    const { client, calls: all } = setup(
      withStatus((call) =>
        path(call) === '/v1/draft'
          ? {
              status: 200,
              json: {
                read: stamp(5, 'head'),
                data: { txId: '0x' + 'cd'.repeat(32), opName: 'IDENTITY_JOIN' }
              }
            }
          : {
              status: 200,
              json: {
                read: stamp(5, 'head'),
                data: { txId: '0x' + 'cd'.repeat(32), accepted: true }
              }
            }
      )
    );
    const draft = await client.getDraft({
      opType: 'IDENTITY_JOIN',
      principal: '0x' + 'ab'.repeat(32),
      signer: '0x' + '01'.repeat(20),
      body: { wallet: '0x' + '02'.repeat(20) }
    });
    expect(draft.opName).toBe('IDENTITY_JOIN');
    const result = await client.submit({
      unsigned: '0x00',
      signatures: [{ role: 0, keyType: 1, sig: '0x' + 'ee'.repeat(65) }]
    });
    expect(result).toEqual({ txId: '0x' + 'cd'.repeat(32), accepted: true });
    const calls = reads(all);
    expect(calls.map((c) => [c.method, path(c)])).toEqual([
      ['POST', '/v1/draft'],
      ['POST', '/v1/submit']
    ]);
    expect(JSON.parse(String(calls[1].body))).toEqual({
      unsigned: '0x00',
      signatures: [{ role: 0, keyType: 1, sig: '0x' + 'ee'.repeat(65) }]
    });
    expect(calls[1].headers['content-type']).toBe('application/json');
  });

  it('refuses a draft or submit answered by another chain', async () => {
    const { client } = setup(
      withStatus(() => ({
        status: 200,
        json: {
          read: { ...stamp(5, 'head'), network: OTHER_NETWORK },
          data: { txId: '0x' + 'cd'.repeat(32), accepted: true }
        }
      }))
    );
    await expect(client.submit({ signed: '0x00' })).rejects.toMatchObject({
      code: 'wrong_network'
    });
  });

  it('throws inadmissible with the chain code', async () => {
    const { client } = setup(
      withStatus(() => ({
        status: 422,
        json: {
          read: stamp(5, 'head'),
          error: {
            code: 'inadmissible',
            message: '0x0201 BAD_SIGNATURE, detail 1'
          }
        }
      }))
    );
    await expect(client.submit({ signed: '0x00' })).rejects.toMatchObject({
      code: 'inadmissible',
      status: 422,
      message: expect.stringContaining('BAD_SIGNATURE')
    });
  });
});

describe('profile documents', () => {
  const doc = Buffer.from('a profile document');
  const cid = '0x01551220' + createHash('sha256').update(doc).digest('hex');

  it('names a CID in base32 as the store does', () => {
    // RFC 4648 test vector: "foobar" is MZXW6YTBOI.
    expect(cidPath('0x' + Buffer.from('foobar').toString('hex'))).toBe(
      'bmzxw6ytboi'
    );
  });

  it('checks the bytes against a raw sha2-256 CID', () => {
    expect(bytesMatchCid(cid, doc)).toBe(true);
    expect(bytesMatchCid(cid, Buffer.from('another'))).toBe(false);
  });

  it('checks a sha2-256 CID of any codec, and no other hash', () => {
    const digest = createHash('sha256').update(doc).digest('hex');
    // dag-json (0x0129, a two-byte varint) and dag-cbor (0x71).
    expect(bytesMatchCid('0x01a9021220' + digest, doc)).toBe(true);
    expect(bytesMatchCid('0x01711220' + digest, doc)).toBe(true);
    expect(bytesMatchCid('0x01711220' + digest, Buffer.from('x'))).toBe(false);
    // sha2-512 (0x13), a short digest, CIDv0-like.
    expect(bytesMatchCid('0x01551340' + digest + digest, doc)).toBe(false);
    expect(bytesMatchCid('0x015512' + '1f' + digest.slice(2), doc)).toBe(false);
    expect(bytesMatchCid('0x1220' + digest, doc)).toBe(false);
    // A 31-byte digest under a 32-byte length, and trailing bytes.
    expect(bytesMatchCid('0x01551220' + digest.slice(2), doc)).toBe(false);
    expect(bytesMatchCid('0x01551220' + digest + '00', doc)).toBe(false);
    // CID version 2.
    expect(bytesMatchCid('0x02551220' + digest, doc)).toBe(false);
  });

  it('refuses to fetch a document whose CID names another hash', async () => {
    const { client, calls } = setup(() => ({ status: 200, bytes: doc }));
    await expect(
      client.getDocument('0x01551340' + '00'.repeat(64))
    ).rejects.toMatchObject({ code: 'bad_request' });
    // A sha2-256 CID with bytes after its digest names no document.
    await expect(
      client.getDocument('0x01551220' + '00'.repeat(33))
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('fetches a document once and checks it', async () => {
    const { client, calls } = setup(() => ({ status: 200, bytes: doc }));
    const first = await client.getProfileDoc(
      cid.toUpperCase().replace('0X', '0x')
    );
    expect(first).toEqual(doc);
    first!.fill(0);
    // The cache keeps its own copy and hands out copies.
    const second = await client.getProfileDoc(cid);
    expect(second).toEqual(doc);
    second!.fill(0);
    expect(await client.getProfileDoc(cid)).toEqual(doc);
    expect(calls).toHaveLength(1);
    expect(path(calls[0])).toBe(`/v1/docs/${cidPath(cid)}`);
  });

  it('refuses a document that does not match its CID', async () => {
    const { client } = setup(() => ({
      status: 200,
      bytes: Buffer.from('tampered')
    }));
    await expect(client.getProfileDoc(cid)).rejects.toMatchObject({
      code: 'cid_mismatch'
    });
  });

  it('answers null when the store has none', async () => {
    const { client } = setup(() => ({ status: 404 }));
    expect(await client.getProfileDoc(cid)).toBeNull();
  });

  it('reads a CID in hex or in base32 text', () => {
    expect(cidHex(cidPath(cid))).toBe(cid);
    expect(cidHex(cid.slice(2))).toBe(cid);
    expect(cidHex(cid.toUpperCase().replace('0X', '0x'))).toBe(cid);
    expect(rawCidHexOf(doc)).toBe(cid);
    for (const bad of [
      '',
      'b',
      '0x',
      '0x0155',
      cidPath(cid).toUpperCase(),
      'zabc',
      'b1',
      `${cidPath(cid)}!junk`
    ]) {
      expect(() => cidHex(bad)).toThrow(ChainGatewayError);
    }
  });

  it('fetches any document by its base32 CID', async () => {
    const { client, calls } = setup(() => ({ status: 200, bytes: doc }));
    expect(await client.getDocument(cidPath(cid))).toEqual(doc);
    expect(await client.getProfileDoc(cid)).toEqual(doc);
    expect(calls).toHaveLength(1);
  });

  it('refuses a document larger than the store holds', async () => {
    const huge = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { client } = setup(() => ({ status: 200, bytes: huge }));
    await expect(client.getDocument(rawCidHexOf(huge))).rejects.toMatchObject({
      code: 'bad_answer'
    });
  });

  it('refuses a document by its length before reading it', async () => {
    const { client } = setup(() => ({
      status: 200,
      bytes: Buffer.from('never read'),
      headers: { 'content-length': String(2 * 1024 * 1024 + 1) }
    }));
    await expect(
      client.getDocument(rawCidHexOf(Buffer.from('x')))
    ).rejects.toMatchObject({ code: 'bad_answer' });
  });

  it('stops reading a streamed document past the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let given = 0;
    let cancelled = false;
    const client = new ChainGatewayClient(() => ({
      baseUrl: BASE,
      serviceKey: null,
      timeoutMs: 1_000,
      retries: 0,
      headTtlMs: 2_000,
      cacheEntries: 10,
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => {
          throw new Error('read whole');
        },
        body: {
          getReader: () => ({
            read: async () =>
              given++ < 5
                ? { done: false, value: chunk }
                : { done: true, value: undefined },
            cancel: async () => {
              cancelled = true;
            }
          })
        }
      })
    }));
    await expect(
      client.getDocument(rawCidHexOf(Buffer.from('x')))
    ).rejects.toMatchObject({ code: 'bad_answer' });
    expect(given).toBe(3);
    expect(cancelled).toBe(true);
  });

  it('refuses an answer over its byte cap', async () => {
    const { client } = setup(() => ({
      status: 200,
      json: status(10).json,
      headers: { 'content-length': String(17 * 1024 * 1024) }
    }));
    await expect(client.getHead()).rejects.toMatchObject({
      code: 'bad_answer'
    });
  });

  it('does not cache a document larger than a profile document', async () => {
    const big = Buffer.alloc(524_289, 7);
    const bigCid = rawCidHexOf(big);
    const { client, calls } = setup(() => ({ status: 200, bytes: big }));
    await client.getDocument(bigCid);
    await client.getDocument(bigCid);
    expect(calls).toHaveLength(2);
  });

  it('stores a document as bytes and checks the CID the store names', async () => {
    const { client, calls } = setup(() => ({
      status: 201,
      json: { cid: cidPath(cid), cid_hex: cid, codec: 'raw', size: doc.length }
    }));
    expect(await client.putDocument(doc)).toBe(cidPath(cid));
    expect(calls[0].method).toBe('POST');
    expect(path(calls[0])).toBe('/v1/docs');
    expect(param(calls[0], 'cid')).toBe(cidPath(cid));
    expect(calls[0].headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(calls[0].body as Uint8Array)).toEqual(doc);
  });

  it('reads the CID the store names in base32 alone', async () => {
    const { client } = setup(() => ({
      status: 200,
      json: { cid: cidPath(cid), cid_hex: cid.slice(2), codec: 'raw', size: 1 }
    }));
    expect(await client.putDocument(doc)).toBe(cidPath(cid));
  });

  it('refuses an answer with another status or an unreadable CID', async () => {
    const accepted = setup(() => ({
      status: 202,
      json: { cid: cidPath(cid), cid_hex: cid, codec: 'raw', size: 1 }
    }));
    await expect(accepted.client.putDocument(doc)).rejects.toBeInstanceOf(
      ChainGatewayError
    );
    const garbled = setup(() => ({
      status: 201,
      json: { cid: 'not a cid', codec: 'raw', size: 1 }
    }));
    await expect(garbled.client.putDocument(doc)).rejects.toMatchObject({
      code: 'bad_answer'
    });
  });

  it('throws the store refusal and an answer without a CID', async () => {
    const tooBig = setup(() => ({
      status: 413,
      json: { error: 'too_large', message: 'over 2 MiB' }
    }));
    await expect(tooBig.client.putDocument(doc)).rejects.toBeInstanceOf(
      ChainGatewayError
    );
    const empty = setup(() => ({ status: 201, json: { size: 1 } }));
    await expect(empty.client.putDocument(doc)).rejects.toBeInstanceOf(
      ChainGatewayError
    );
  });

  it('sends any byte array as bytes', async () => {
    const { client, calls } = setup(() => ({
      status: 201,
      json: { cid: cidPath(cid), cid_hex: cid, codec: 'raw', size: 1 }
    }));
    await client.putDocument(Buffer.from(new Uint8Array(doc)));
    expect(calls[0].headers['content-type']).toBe('application/octet-stream');
  });

  it('refuses an upload the store names differently', async () => {
    const other = rawCidHexOf(Buffer.from('other'));
    const { client } = setup(() => ({
      status: 200,
      json: { cid: cidPath(other), cid_hex: other, codec: 'raw', size: 5 }
    }));
    await expect(client.putDocument(doc)).rejects.toMatchObject({
      code: 'cid_mismatch'
    });
  });
});

describe('document cache', () => {
  it('drops the old value when a key is set to one too heavy to keep', () => {
    const cache = new LruCache<Buffer>(10, (it) => it.length, 10);
    cache.set('a', Buffer.alloc(4));
    cache.set('a', Buffer.alloc(11));
    expect(cache.get('a')).toBeUndefined();
  });

  it('weighs a document set twice once', () => {
    const cache = new LruCache<Buffer>(10, (it) => it.length, 10);
    cache.set('a', Buffer.alloc(4));
    cache.set('a', Buffer.alloc(4));
    cache.set('b', Buffer.alloc(4));
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeDefined();
  });

  it('drops the oldest documents past its total bytes', () => {
    const cache = new LruCache<Buffer>(10, (it) => it.length, 10);
    cache.set('a', Buffer.alloc(4));
    cache.set('b', Buffer.alloc(4));
    cache.set('c', Buffer.alloc(4));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    cache.set('d', Buffer.alloc(11));
    expect(cache.get('d')).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});

describe('import and membership history', () => {
  const P = '0x' + 'ab'.repeat(32);
  const W = '0x' + '01'.repeat(20);

  it('reads the import entry of an identity, and null when none', async () => {
    const entry = {
      principalId: P,
      legacyId: '00000000-0000-4000-8000-000000000001',
      handle: 'alice',
      wallets: [W],
      primary: W,
      profileDocCid: '0x01551220' + '33'.repeat(32),
      xtdh: '0'
    };
    const { client, calls } = setup((call) => {
      if (path(call) === '/v1/status') return status(50);
      return path(call).endsWith(`${P}/imported`)
        ? { status: 200, json: { read: stamp(50), data: entry, next: null } }
        : {
            status: 404,
            json: {
              read: stamp(50),
              error: { code: 'not_found', message: 'none' }
            }
          };
    });
    expect(
      await client.getImportedIdentity(P.toUpperCase().replace('0X', '0x'))
    ).toEqual(entry);
    expect(await client.getImportedIdentity('0x' + 'cd'.repeat(32))).toBeNull();
    expect(calls.some((it) => param(it, 'height') === '50')).toBe(true);
  });

  it("reads a wallet's binding history with its ranges and read height", async () => {
    const history = {
      wallet: W,
      changes: [
        { height: 3, principalId: P.toUpperCase().replace('0X', '0x') },
        { height: 9, principalId: null }
      ],
      ranges: [
        [1, 20],
        [30, 50],
        [55, 55]
      ]
    };
    const { client } = setup((call) =>
      path(call) === '/v1/status'
        ? status(50)
        : { status: 200, json: { read: stamp(50), data: history, next: null } }
    );
    expect(await client.getMembershipWalletHistory(W)).toEqual({
      wallet: W,
      changes: [
        { height: 3, principalId: P },
        { height: 9, principalId: null }
      ],
      ranges: [
        [1, 20],
        [30, 50],
        [55, 55]
      ],
      readHeight: 50
    });
  });

  it('reads a history again at the same height after its ranges grow', async () => {
    let to = 40;
    const { client } = setup((call) =>
      path(call) === '/v1/status'
        ? status(50)
        : {
            status: 200,
            json: {
              read: stamp(50),
              data: { wallet: W, changes: [], ranges: [[1, to]] },
              next: null
            }
          }
    );
    expect((await client.getMembershipWalletHistory(W))?.ranges).toEqual([
      [1, 40]
    ]);
    to = 50;
    expect((await client.getMembershipWalletHistory(W))?.ranges).toEqual([
      [1, 50]
    ]);
  });

  it('answers null for a history it does not have, and no ranges as none', async () => {
    const answers = [
      {
        status: 404,
        json: { read: stamp(50), error: { code: 'not_found', message: 'none' } }
      },
      {
        status: 200,
        json: {
          read: stamp(50),
          data: { wallet: '0x' + '02'.repeat(20), changes: [] },
          next: null
        }
      }
    ];
    const { client } = setup((call) =>
      path(call) === '/v1/status' ? status(50) : answers.shift()!
    );
    expect(await client.getMembershipWalletHistory(W)).toBeNull();
    expect(
      await client.getMembershipWalletHistory('0x' + '02'.repeat(20))
    ).toEqual(
      expect.objectContaining({ changes: [], ranges: [], readHeight: 50 })
    );
  });

  it.each([
    ['a renamed principal field', [{ height: 3, principal: P }]],
    ['a principal that is not one', [{ height: 3, principalId: '0x12' }]],
    ['a height that is not one', [{ height: 'x', principalId: P }]],
    [
      'heights out of order',
      [
        { height: 9, principalId: P },
        { height: 3, principalId: null }
      ]
    ],
    ['no changes at all', undefined],
    ['a height that is null', [{ height: null, principalId: null }]],
    [
      'two changes at one height',
      [
        { height: 3, principalId: P },
        { height: 3, principalId: null }
      ]
    ]
  ])('refuses a history with %s', async (_name, changes) => {
    const { client } = setup((call) =>
      path(call) === '/v1/status'
        ? status(50)
        : {
            status: 200,
            json: {
              read: stamp(50),
              data: { wallet: W, changes, ranges: [[1, 50]] },
              next: null
            }
          }
    );
    await expect(client.getMembershipWalletHistory(W)).rejects.toMatchObject({
      code: 'bad_answer'
    });
  });

  it.each([
    ['a range that is not two heights', { ranges: [[1, 2, 3]] }],
    ['a range that ends before it starts', { ranges: [[9, 4]] }],
    ['a range that ends one before it starts', { ranges: [[5, 4]] }],
    ['a range to infinity', { ranges: [[1, 'Infinity']] }],
    ['a range below zero', { ranges: [[-5, 3]] }],
    ['ranges that are not a list', { ranges: 'all' }],
    ['another wallet', { wallet: '0x' + '02'.repeat(20) }],
    ['no read height', { read: { ...stamp(50), height: undefined } }]
  ])('refuses a history answer with %s', async (_name, change) => {
    const { read: readChange, ...dataChange } = change as {
      read?: unknown;
      [key: string]: unknown;
    };
    const { client } = setup((call) =>
      path(call) === '/v1/status'
        ? status(50)
        : {
            status: 200,
            json: {
              read: readChange ?? stamp(50),
              data: {
                wallet: W,
                changes: [{ height: 3, principalId: P }],
                ranges: [[1, 50]],
                ...dataChange
              },
              next: null
            }
          }
    );
    await expect(client.getMembershipWalletHistory(W)).rejects.toMatchObject({
      code: 'bad_answer'
    });
  });
});

describe('configuration', () => {
  it('reads the environment', () => {
    expect(
      chainGatewayConfigFromEnv({
        CHAIN_GATEWAY_URL: 'https://gateway.test/',
        CHAIN_GATEWAY_SERVICE_KEY: ' key ',
        CHAIN_GATEWAY_RETRIES: '5',
        CHAIN_GATEWAY_TIMEOUT_MS: 'x'
      })
    ).toEqual({
      baseUrl: 'https://gateway.test',
      serviceKey: 'key',
      timeoutMs: 10_000,
      retries: 5,
      headTtlMs: 2_000,
      cacheEntries: 10_000
    });
  });

  it('fails at first use, not at import, without a URL', async () => {
    const client = new ChainGatewayClient(() => chainGatewayConfigFromEnv({}));
    await expect(client.getHead()).rejects.toMatchObject({
      code: 'not_configured'
    });
  });
});

describe('LruCache', () => {
  it('drops the least recently used entry', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
  });
});
