import { ChainGatewayClient } from './chain-gateway.client';
import { isWavesImportRouteMissing } from './waves-import-route';

/**
 * A gateway on a release without the waves routes, end to end through the
 * real client: the node answers an unknown GET with 404, its read stamp and
 * `{"code": "not_found", "message": "no such route"}`; the client turns that
 * into not_held (notHeld). The wait must know it, and nothing else.
 */

const NETWORK = '0x' + '22'.repeat(32);

function stamp(height: number, at: 'finalized' | 'head' = 'finalized') {
  return {
    at,
    height,
    root: '0x' + '11'.repeat(32),
    slot: height + 10,
    time: 1_764_000_000_000 + height,
    finalizedHeight: height,
    headHeight: height + 3,
    network: NETWORK
  };
}

const status = (finalized: number) => ({
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
});

/** A client whose node knows no route but /v1/status. */
function gatewayWithoutRoutes(notFoundMessage = 'no such route') {
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string> }
  ) => {
    const route = new URL(url).pathname;
    const reply =
      route === '/v1/status'
        ? status(10)
        : {
            status: 404,
            json: {
              read: stamp(10, init.method === 'GET' ? 'head' : 'finalized'),
              error: { code: 'not_found', message: notFoundMessage }
            }
          };
    const text = JSON.stringify(reply.json);
    return {
      status: reply.status,
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
  return new ChainGatewayClient(() => ({
    baseUrl: 'https://gateway.test',
    serviceKey: 'service-key',
    timeoutMs: 1_000,
    retries: 0,
    headTtlMs: 2_000,
    cacheEntries: 100,
    fetchImpl,
    sleep: async () => undefined,
    now: () => 1_000_000
  }));
}

async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

describe("the client's answer for a gateway without /v1/waves/import", () => {
  it('is the "no such route" the wait waits on, read at the head (the sender) and at a height (the chain index)', async () => {
    const client = gatewayWithoutRoutes();
    for (const opts of [{ at: 'head' as const }, { height: 10 }]) {
      const error = await failureOf(() =>
        client.read('/v1/waves/import', {}, opts)
      );
      expect(error).toMatchObject({
        code: 'not_held',
        status: 404,
        path: '/v1/waves/import'
      });
      expect(isWavesImportRouteMissing(error)).toBe(true);
    }
  });

  it('is not it for another route, nor for another not_held message', async () => {
    const client = gatewayWithoutRoutes();
    expect(
      isWavesImportRouteMissing(
        await failureOf(() =>
          client.read('/v1/decisions/due', {}, { at: 'head' })
        )
      )
    ).toBe(false);
    const another = gatewayWithoutRoutes("this node didn't save day 5");
    const error = await failureOf(() =>
      another.read('/v1/waves/import', {}, { at: 'head' })
    );
    expect(error).toMatchObject({ code: 'not_held' });
    expect(isWavesImportRouteMissing(error)).toBe(false);
  });
});
