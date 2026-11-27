import { chainHeadTime } from './mint-log-rebuild.chain-clock';

type FetchLike = Parameters<typeof chainHeadTime>[2];

function answering(
  status: number,
  body: unknown
): {
  fetch: FetchLike;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => body };
  }) as unknown as FetchLike;
  return { fetch, calls };
}

describe('chainHeadTime', () => {
  it("reads the head block's timestamp from the ethereum source", async () => {
    const { fetch, calls } = answering(200, {
      jsonrpc: '2.0',
      id: 1,
      result: { number: '0x46', timestamp: '0x69580080' }
    });
    const time = await chainHeadTime('http://127.0.0.1:8545', null, fetch);
    expect(time.toMillis()).toBe(0x69580080 * 1000);
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:8545',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBlockByNumber',
          params: ['latest', false]
        }
      }
    ]);
  });

  it("reads the run's mark block when the run names one", async () => {
    const { fetch, calls } = answering(200, {
      jsonrpc: '2.0',
      id: 1,
      result: { number: '0x2a', timestamp: '0x69560000' }
    });
    const time = await chainHeadTime('http://127.0.0.1:8545', 42, fetch);
    expect(time.toMillis()).toBe(0x69560000 * 1000);
    expect(calls.map((call) => call.body)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBlockByNumber',
        params: ['0x2a', false]
      }
    ]);
  });

  it('fails on an error answer instead of falling back to the wall clock', async () => {
    const { fetch } = answering(200, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'no block' }
    });
    await expect(
      chainHeadTime('http://127.0.0.1:8545', null, fetch)
    ).rejects.toThrow('The ethereum source gave no head block time: no block');
  });

  it('fails on an HTTP error', async () => {
    const { fetch } = answering(502, {});
    await expect(
      chainHeadTime('http://127.0.0.1:8545', null, fetch)
    ).rejects.toThrow('The ethereum source answered 502');
  });
});
