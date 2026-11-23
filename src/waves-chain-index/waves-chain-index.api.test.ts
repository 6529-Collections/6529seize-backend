import { ChainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { ChainAnswer } from '@/chain-gateway/chain-gateway.types';
import {
  GatewayWavesChainApi,
  LEADERBOARD_LIMIT
} from './waves-chain-index.api';

type Read = {
  path: string;
  query: Record<string, unknown>;
  opts: Record<string, unknown>;
};

function aClient(answers: Record<string, (ChainAnswer<unknown> | null)[]>) {
  const reads: Read[] = [];
  const client = {
    read: jest.fn(
      async (
        path: string,
        query: Record<string, unknown> = {},
        opts: Record<string, unknown> = {}
      ) => {
        reads.push({ path, query, opts });
        const queue = answers[path];
        if (!queue?.length) return null;
        return queue.shift() ?? null;
      }
    ),
    getHead: jest.fn(async () => ({
      headHeight: 12,
      finalizedHeight: 10,
      finalizedTime: 1_764_000_000_000,
      pinnable: null,
      network: 'net-1'
    })),
    getChanges: jest.fn(async (from: number) => ({
      from,
      through: from,
      blocks: [],
      next: from + 1
    }))
  };
  return { client: client as any, reads };
}

const answer = <T>(data: T, next: string | null = null): ChainAnswer<T> => ({
  read: { height: 10 } as any,
  data,
  next
});

describe('GatewayWavesChainApi', () => {
  it('pins every read to the height it is given', async () => {
    const { client, reads } = aClient({
      '/v1/waves': [answer([{ waveId: '0x1' }], '0x1')],
      '/v1/waves/0xabc': [answer({ waveId: '0xabc' })]
    });
    const api = new GatewayWavesChainApi(client);
    expect(await api.listWaves(null, 42)).toEqual({
      items: [{ waveId: '0x1' }],
      next: '0x1'
    });
    expect(await api.wave('0xabc', 42)).toEqual({ waveId: '0xabc' });
    expect(await api.wave('0xdef', 42)).toBeNull();
    expect(reads.map((r) => r.opts)).toEqual([
      { height: 42 },
      { height: 42 },
      { height: 42 }
    ]);
    expect(reads[0].query).toEqual({ limit: 500, after: undefined });
  });

  it('reads a per-object list to its end, and null for an object that is gone', async () => {
    const { client, reads } = aClient({
      '/v1/entries/0xe/votes': [
        answer([{ voter: '0x1' }, { voter: '0x2' }], '0x2'),
        answer([{ voter: '0x3' }], null)
      ]
    });
    const api = new GatewayWavesChainApi(client);
    expect(await api.entryVotes('0xe', 7)).toEqual([
      { voter: '0x1' },
      { voter: '0x2' },
      { voter: '0x3' }
    ]);
    expect(reads.map((r) => r.query.after)).toEqual([undefined, '0x2']);
    expect(await api.entryVotes('0xgone', 7)).toBeNull();
  });

  it('refuses a list whose later page is not found at the same height', async () => {
    const { client } = aClient({
      '/v1/entries/0xe/votes': [answer([{ voter: '0x1' }], '0x1')]
    });
    const api = new GatewayWavesChainApi(client);
    await expect(api.entryVotes('0xe', 7)).rejects.toThrow(
      'a later page was not found'
    );
  });

  it('asks for every entry of a decision, and the largest leaderboard', async () => {
    const { client, reads } = aClient({
      '/v1/decisions/0xd/entries': [answer([{ entryId: '0xe' }], '0xe')],
      '/v1/decisions/0xd/leaderboard': [answer({ rows: [] })]
    });
    const api = new GatewayWavesChainApi(client);
    expect(await api.decisionEntries('0xd', '0xc', 3)).toEqual({
      items: [{ entryId: '0xe' }],
      next: '0xe'
    });
    expect(await api.decisionLeaderboard('0xd', 3)).toEqual({ rows: [] });
    expect(reads[0].query).toEqual({
      status: 'all',
      limit: 500,
      after: '0xc'
    });
    expect(reads[1].query).toEqual({ limit: LEADERBOARD_LIMIT });
  });

  it('reads lists held in an object', async () => {
    const { client } = aClient({
      '/v1/waves/0xw/roles': [answer({ roles: [{ role: 'admin' }] })]
    });
    const api = new GatewayWavesChainApi(client);
    expect(await api.waveRoles('0xw', 1)).toEqual([{ role: 'admin' }]);
  });

  it('reads the import state at the run height, and the head fresh', async () => {
    const { client, reads } = aClient({
      '/v1/waves/import': [answer({ started: true, completed: true })]
    });
    const api = new GatewayWavesChainApi(client);
    expect(await api.importState(9)).toEqual({ completed: true });
    expect(reads[0].opts).toEqual({ height: 9 });
    expect(await api.importState(9)).toBeNull();
    expect(await api.head()).toEqual({
      finalizedHeight: 10,
      finalizedTime: 1_764_000_000_000,
      network: 'net-1'
    });
    expect(client.getHead).toHaveBeenCalledWith(true);
  });

  it("reads the pinned block's time when the status gives none", async () => {
    const belowPin = {
      headHeight: 12,
      finalizedHeight: 11,
      finalizedTime: null,
      nodeFinalizedHeight: 10,
      nodeFinalizedTime: 1_764_000_000_000,
      pinnable: null,
      network: 'net-1'
    };
    const { client, reads } = aClient({
      '/v1/blocks/11': [
        answer({ height: 11, time: 1_764_000_001_000 }),
        answer({ height: 12, time: 1_764_000_002_000 }),
        answer({ height: 11, time: 'soon' }),
        null
      ]
    });
    const api = new GatewayWavesChainApi(client);
    client.getHead.mockResolvedValue(belowPin);
    expect(await api.head()).toEqual({
      finalizedHeight: 11,
      finalizedTime: 1_764_000_001_000,
      network: 'net-1'
    });
    expect(reads[0]).toEqual({
      path: '/v1/blocks/11',
      query: {},
      opts: { height: 11 }
    });
    // Another block's answer, no time, no block: no time, the run waits.
    for (let i = 0; i < 3; i++) {
      expect((await api.head()).finalizedTime).toBeNull();
    }
    client.read.mockRejectedValueOnce(new Error('gateway down'));
    expect((await api.head()).finalizedTime).toBeNull();
    // A status with the time asks for no block.
    client.getHead.mockResolvedValue({ ...belowPin, finalizedTime: 7 });
    const before = reads.length;
    expect((await api.head()).finalizedTime).toBe(7);
    expect(reads.length).toBe(before);
  });

  it('throws when a later page of a list is not found, and reads a missing list as empty', async () => {
    const { client } = aClient({
      '/v1/decisions/0xd/entries': [answer([{ entryId: '0x1' }], '0x1')]
    });
    const api = new GatewayWavesChainApi(client);
    expect(await api.decisionEntries('0xd', null, 10)).toEqual({
      items: [{ entryId: '0x1' }],
      next: '0x1'
    });
    // The list was there a page ago at this height: never an empty end.
    await expect(api.decisionEntries('0xd', '0x1', 10)).rejects.toThrow(
      'a later page was not found'
    );
    await expect(api.listWaves('0x9', 10)).rejects.toThrow(
      'a later page was not found'
    );
    expect(await api.listGroups(null, 10)).toEqual({ items: [], next: null });
  });

  it('asks the feed for the families it follows', async () => {
    const { client } = aClient({});
    const api = new GatewayWavesChainApi(client);
    await api.feed(5, ['0x0501', '0x0607']);
    expect(client.getChanges).toHaveBeenCalledWith(5, {
      limit: 200,
      families: ['0x0501', '0x0607']
    });
  });

  describe('feed pages of whole blocks', () => {
    const record = (n: number) => ({
      family: '0x0501',
      key: `0x${String(n).padStart(4, '0')}`,
      value: null
    });
    const block = (
      height: number,
      records: number[],
      fields: { complete?: boolean; recordsFrom?: number } = {}
    ) => ({
      height,
      slot: height,
      root: '0x00',
      time: 1_000 * height,
      complete: fields.complete ?? true,
      recordsFrom: fields.recordsFrom ?? 0,
      records: records.map(record)
    });
    const page = (
      from: number | string,
      through: number,
      blocks: ReturnType<typeof block>[],
      next: number | string
    ) => ({
      from,
      through,
      blocks,
      next,
      nextHeight: through + 1,
      atHead: false,
      network: 'net-1'
    });

    it('gives a page of whole blocks as it is', async () => {
      const { client } = aClient({});
      const whole = page(5, 6, [block(5, [1]), block(6, [2])], 7);
      client.getChanges.mockResolvedValueOnce(whole);
      expect(await new GatewayWavesChainApi(client).feed(5, [])).toBe(whole);
    });

    it('gives the whole blocks before a cut one alone; the next page starts at it', async () => {
      const { client } = aClient({});
      client.getChanges.mockResolvedValueOnce(
        page(
          5,
          6,
          [block(5, [1]), block(6, [2]), block(7, [3], { complete: false })],
          '7:1'
        )
      );
      const got = await new GatewayWavesChainApi(client).feed(5, ['0x0501']);
      expect(got.blocks.map((b) => b.height)).toEqual([5, 6]);
      expect(got).toMatchObject({ through: 6, next: 7, nextHeight: 7 });
      expect(client.getChanges).toHaveBeenCalledTimes(1);
    });

    it('reads a block split across three pages on from its cursor and gives it whole', async () => {
      const { client } = aClient({});
      client.getChanges
        .mockResolvedValueOnce(
          page(5, 4, [block(5, [1, 2], { complete: false })], '5:2')
        )
        .mockResolvedValueOnce(
          page(
            '5:2',
            4,
            [block(5, [3, 4], { complete: false, recordsFrom: 2 })],
            '5:4'
          )
        )
        .mockResolvedValueOnce(
          page('5:4', 6, [block(5, [5], { recordsFrom: 4 }), block(6, [6])], 7)
        );
      const got = await new GatewayWavesChainApi(client).feed(5, ['0x0501']);
      expect(got).toMatchObject({
        from: 5,
        through: 5,
        next: 6,
        nextHeight: 6,
        atHead: false
      });
      expect(got.blocks).toEqual([
        { ...block(5, [1, 2, 3, 4, 5]), complete: true, recordsFrom: 0 }
      ]);
      expect(client.getChanges.mock.calls).toEqual([
        [5, { limit: 200, families: ['0x0501'] }],
        ['5:2', { limit: 200, families: ['0x0501'], network: 'net-1' }],
        ['5:4', { limit: 200, families: ['0x0501'], network: 'net-1' }]
      ]);
    });

    it('stops before a split block when a node behind it answers the rest', async () => {
      const { client } = aClient({});
      client.getChanges
        .mockResolvedValueOnce(
          page(3, 4, [block(5, [1], { complete: false })], '5:1')
        )
        .mockResolvedValueOnce({ ...page('5:1', 4, [], '5:1'), atHead: true });
      const got = await new GatewayWavesChainApi(client).feed(3, []);
      expect(got).toMatchObject({
        blocks: [],
        through: 4,
        next: 5,
        nextHeight: 5,
        atHead: true
      });
    });

    it('throws for a block past the limits, or a page that goes on with another block', async () => {
      const endless = (from: string | number) =>
        Promise.resolve(
          page(from, 4, [block(5, [1], { complete: false })], '5:1')
        );
      const pages = aClient({}).client;
      pages.getChanges.mockImplementation(endless);
      await expect(
        new GatewayWavesChainApi(pages, {
          maxPages: 3,
          maxBytes: 1_000_000
        }).feed(5, [])
      ).rejects.toThrow('[FEED BLOCK TOO LARGE] block 5');
      expect(pages.getChanges).toHaveBeenCalledTimes(3);
      const bytes = aClient({}).client;
      bytes.getChanges.mockImplementation(endless);
      await expect(
        new GatewayWavesChainApi(bytes, { maxPages: 100, maxBytes: 200 }).feed(
          5,
          []
        )
      ).rejects.toThrow('[FEED BLOCK TOO LARGE] block 5');
      const broken = aClient({}).client;
      broken.getChanges
        .mockResolvedValueOnce(
          page(5, 4, [block(5, [1], { complete: false })], '5:1')
        )
        .mockResolvedValueOnce(page('5:1', 6, [block(6, [2])], 7));
      await expect(
        new GatewayWavesChainApi(broken).feed(5, [])
      ).rejects.toThrow('[FEED BLOCK BROKEN] block 5');
    });
  });

  describe('the feed and lists over the gateway client', () => {
    const NETWORK = '0x' + '22'.repeat(32);
    const stamp = (height: number, at: 'finalized' | 'head' = 'finalized') => ({
      at,
      height,
      root: '0x' + '11'.repeat(32),
      slot: height + 10,
      time: 1_764_000_000_000 + height,
      finalizedHeight: height,
      headHeight: height + 3,
      network: NETWORK
    });
    const record = (n: number) => ({
      family: '0x0501',
      name: 'Wave',
      key: `0x${String(n).padStart(4, '0')}`,
      value: '0x'
    });
    const block = (
      height: number,
      records: number[],
      complete = true,
      recordsFrom = 0
    ) => ({
      height,
      slot: 0,
      root: '0x',
      time: 1,
      complete,
      recordsFrom,
      records: records.map(record)
    });
    /** The real client, with the gateway answering `pages` in order. */
    function clientOf(pages: { read: number; data: unknown; next: unknown }[]) {
      const asked: string[] = [];
      const fetchImpl = async (url: string) => {
        const u = new URL(url);
        let json: unknown;
        if (u.pathname === '/v1/status') {
          json = {
            read: stamp(130, 'head'),
            data: {
              api: '1',
              node: 'rc',
              ready: true,
              head: stamp(133, 'head'),
              finalized: stamp(130),
              pinnable: { from: 67, to: 130 },
              ruleVersion: 7
            },
            next: null
          };
        } else {
          asked.push(
            u.searchParams.get('from') ?? u.searchParams.get('after') ?? ''
          );
          const page = pages.shift()!;
          json = { read: stamp(page.read), data: page.data, next: page.next };
        }
        const text = JSON.stringify(json);
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => text,
          arrayBuffer: async () => {
            const bytes = Buffer.from(text);
            return bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ) as ArrayBuffer;
          }
        };
      };
      const client = new ChainGatewayClient(() => ({
        baseUrl: 'https://gateway.test',
        serviceKey: 'service-key',
        timeoutMs: 1_000,
        retries: 0,
        headTtlMs: 2_000,
        cacheEntries: 0,
        fetchImpl: fetchImpl as any,
        sleep: async () => undefined
      }));
      return { api: new GatewayWavesChainApi(client), asked };
    }

    it('takes an empty page that moves on, and its next height', async () => {
      const { api } = clientOf([
        { read: 130, data: { from: 100, through: 119, blocks: [] }, next: 120 }
      ]);
      const page = await api.feed(100, ['0x0501']);
      expect(page).toMatchObject({ blocks: [], through: 119, atHead: false });
      expect(Number(page.next)).toBe(120);
    });

    it('gives a block cut across three pages whole, read on from the cursor', async () => {
      const { api, asked } = clientOf([
        {
          read: 130,
          data: {
            from: 120,
            through: 119,
            blocks: [block(120, [1, 2], false)]
          },
          next: '120:7'
        },
        {
          read: 130,
          data: {
            from: '120:7',
            through: 119,
            blocks: [block(120, [3, 4], false, 7)]
          },
          next: '120:15'
        },
        {
          read: 130,
          data: {
            from: '120:15',
            through: 121,
            blocks: [block(120, [5], true, 15), block(121, [6])]
          },
          next: 122
        }
      ]);
      const page = await api.feed(120, ['0x0501']);
      expect(asked).toEqual(['120', '120:7', '120:15']);
      expect(page).toMatchObject({ through: 120, next: 121, atHead: false });
      expect(page.blocks.map((b) => b.height)).toEqual([120]);
      expect(page.blocks[0]).toMatchObject({ complete: true, recordsFrom: 0 });
      expect(page.blocks[0].records.map((r) => r.key)).toEqual(
        [1, 2, 3, 4, 5].map((n) => record(n).key)
      );
    });

    it('stops before a cut block when a node behind it answers the rest', async () => {
      const { api } = clientOf([
        {
          read: 130,
          data: { from: 118, through: 119, blocks: [block(120, [1], false)] },
          next: '120:3'
        },
        {
          read: 119,
          data: { from: '120:3', through: 119, blocks: [] },
          next: 120
        }
      ]);
      const page = await api.feed(118, ['0x0501']);
      expect(page).toMatchObject({
        blocks: [],
        through: 119,
        next: 120,
        atHead: true
      });
    });

    it('follows a list through empty pages that move on, to its end', async () => {
      const { api, asked } = clientOf([
        { read: 120, data: [], next: 'k1' },
        { read: 120, data: [{ voter: '0x01' }], next: 'k2' },
        { read: 120, data: [], next: 'k3' },
        { read: 120, data: [{ voter: '0x02' }], next: null }
      ]);
      expect(await api.entryVotes('0x' + 'e1'.repeat(32), 120)).toEqual([
        { voter: '0x01' },
        { voter: '0x02' }
      ]);
      expect(asked).toEqual(['', 'k1', 'k2', 'k3']);
    });

    it('gives an empty list page that moves on as a page, so a full read goes on', async () => {
      const { api } = clientOf([{ read: 120, data: [], next: 'k1' }]);
      expect(await api.listWaves(null, 120)).toEqual({ items: [], next: 'k1' });
    });

    it('stops at the cut block when the node behind is asked from it', async () => {
      const { api } = clientOf([
        { read: 119, data: { from: 120, through: 119, blocks: [] }, next: 120 }
      ]);
      const page = await api.feed(120, ['0x0501']);
      expect(page).toMatchObject({ blocks: [], atHead: true });
      expect(Number(page.next)).toBe(120);
    });
  });
});
