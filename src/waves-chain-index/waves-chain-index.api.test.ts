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

  it('asks the feed for the families it follows', async () => {
    const { client } = aClient({});
    const api = new GatewayWavesChainApi(client);
    await api.feed(5, ['0x0501', '0x0607']);
    expect(client.getChanges).toHaveBeenCalledWith(5, {
      limit: 200,
      families: ['0x0501', '0x0607']
    });
  });
});
