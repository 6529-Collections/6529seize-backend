jest.mock('@/redis', () => ({ getRedisClient: () => null }));

import {
  OpenSeaClient,
  OpenSeaDeadlineError,
  OpenSeaHttpError,
  parseOpenSeaJson
} from './opensea-client';
import { normalizeOpenSeaEvent } from './opensea-normalizer';

it('preserves JSON integers beyond JavaScript safe-number precision', () => {
  expect(parseOpenSeaJson('{"remaining_quantity":9007199254740993}')).toEqual({
    remaining_quantity: '9007199254740993'
  });
});

describe('planned OpenSea request budgets', () => {
  it('uses a typed deadline error when the unused local request allowance cannot fit', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(Response.json({ asset_events: [], next: null }));
    const client = new OpenSeaClient({
      apiKey: 'fixture',
      fetchImpl,
      now: () => 1_000
    });
    await client.getEventsPage('fixture', 0, 1, null, 10_000);
    await expect(
      client.getEventsPage('fixture', 0, 1, null, 1_500)
    ).rejects.toBeInstanceOf(OpenSeaDeadlineError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])(
    'preserves HTTP %i when its retry does not fit the deadline',
    async (status) => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response('', { status }));
      const client = new OpenSeaClient({
        apiKey: 'fixture',
        fetchImpl,
        now: () => 1_000
      });
      await expect(
        client.getEventsPage('fixture', 0, 1, null, 1_100)
      ).rejects.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves a request abort when its retry does not fit the deadline', async () => {
    const failure = Object.assign(new Error('fixture aborted'), {
      name: 'AbortError'
    });
    const client = new OpenSeaClient({
      apiKey: 'fixture',
      fetchImpl: jest.fn().mockRejectedValue(failure),
      now: () => 1_000
    });
    await expect(
      client.getEventsPage('fixture', 0, 1, null, 1_100)
    ).rejects.toBe(failure);
  });

  it('preserves an earlier provider failure when the next attempt runs out of request budget', async () => {
    let now = 1_000;
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('', { status: 503 }));
    const client = new OpenSeaClient({
      apiKey: 'fixture',
      fetchImpl,
      now: () => now,
      sleep: async () => {
        now = 2_000;
      }
    });
    await expect(
      client.getEventsPage('fixture', 0, 1, null, 2_000)
    ).rejects.toBeInstanceOf(OpenSeaHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

it.each([
  '9007199254740993',
  '-9007199254740993',
  '9007199254740993.5',
  '9.007199254740993e15',
  '1e400',
  '1e-400',
  '1.0000000000000001'
])(
  'preserves the exact numeric literal %s without rejecting the page',
  (literal) => {
    expect(
      parseOpenSeaJson(`{"quantity":${literal},"metadata":0.125}`)
    ).toEqual({
      quantity: literal,
      metadata: 0.125
    });
  }
);

it('accepts ordinary fractional metadata and safe integer quantities', () => {
  expect(
    parseOpenSeaJson(
      '{"quantity":9007199254740991,"metadata":[0.5,-1.25,1.2e-3]}'
    )
  ).toEqual({
    quantity: Number.MAX_SAFE_INTEGER,
    metadata: [0.5, -1.25, 0.0012]
  });
});

it.each(['9007199254740993.5', '1.0000000000000001', '1e-400'])(
  'does not normalize rounded fractional quantity %s as an integer',
  (literal) => {
    const event = normalizeOpenSeaEvent(
      parseOpenSeaJson(`{"event_type":"sale","quantity":${literal}}`),
      '0x1111111111111111111111111111111111111111',
      'fixture',
      new Date('2026-09-10T12:00:00Z')
    );
    expect(event.quantity).toBeNull();
  }
);

describe('OpenSeaClient', () => {
  it('rejects oversized declared responses before reading and cancels their body', async () => {
    const pull = jest.fn();
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
      {
        headers: { 'content-length': String(16 * 1024 * 1024 + 1) }
      }
    );
    const fetchImpl = jest.fn().mockResolvedValue(response);
    const client = new OpenSeaClient({ apiKey: 'fixture-key', fetchImpl });

    await expect(client.getAllOffers('fixture')).rejects.toThrow(
      'OpenSea response exceeds the size limit'
    );
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '1'])(
    'bounds streamed bytes when Content-Length is %s and does not retry',
    async (contentLength) => {
      const cancel = jest.fn();
      const chunk = new Uint8Array(1024 * 1024);
      const pull = jest.fn(
        (controller: ReadableStreamDefaultController<Uint8Array>) => {
          controller.enqueue(chunk);
        }
      );
      const response = new Response(
        new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
        {
          headers: contentLength ? { 'content-length': contentLength } : {}
        }
      );
      const fetchImpl = jest.fn().mockResolvedValue(response);
      const client = new OpenSeaClient({ apiKey: 'fixture-key', fetchImpl });

      await expect(client.getAllOffers('fixture')).rejects.toThrow(
        'OpenSea response exceeds the size limit'
      );
      expect(pull).toHaveBeenCalledTimes(17);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts a response exactly at the byte limit', async () => {
    const source = '{"offers":[]}'.padEnd(16 * 1024 * 1024, ' ');
    const client = new OpenSeaClient({
      apiKey: 'fixture-key',
      fetchImpl: jest.fn().mockResolvedValue(new Response(source))
    });
    await expect(client.getAllOffers('fixture')).resolves.toEqual([]);
  });

  it('decodes UTF-8 split across chunks before parsing numeric literals', async () => {
    const source = Buffer.from(
      '{"offers":[{"name":"🌊","quantity":9007199254740993,"rarity":0.5}]}'
    );
    const split = source.indexOf(Buffer.from('🌊')) + 1;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(source.subarray(0, split));
          controller.enqueue(source.subarray(split));
          controller.close();
        }
      })
    );
    const client = new OpenSeaClient({
      apiKey: 'fixture-key',
      fetchImpl: jest.fn().mockResolvedValue(response)
    });
    await expect(client.getAllOffers('fixture')).resolves.toEqual([
      { name: '🌊', quantity: '9007199254740993', rarity: 0.5 }
    ]);
  });

  it('walks every listing page and requests private listings', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ listings: [{ order_hash: 'one' }], next: 'cursor' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ listings: [{ order_hash: 'two' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const client = new OpenSeaClient({
      apiKey: 'fixture-key',
      fetchImpl,
      sleep: async () => undefined,
      now: () => 1_000
    });

    await expect(
      client.getAllListings('fixture', 100_000)
    ).resolves.toHaveLength(2);
    const firstUrl = String(fetchImpl.mock.calls[0][0]);
    const secondUrl = String(fetchImpl.mock.calls[1][0]);
    expect(firstUrl).toContain('limit=200');
    expect(firstUrl).toContain('include_private_listings=true');
    expect(secondUrl).toContain('next=cursor');
  });

  it('honors Retry-After for throttled requests', async () => {
    const sleeps: number[] = [];
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '2' } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ offers: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const client = new OpenSeaClient({
      apiKey: 'fixture-key',
      fetchImpl,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      now: () => 1_000
    });

    await expect(client.getAllOffers('fixture', 100_000)).resolves.toEqual([]);
    expect(sleeps).toContain(2_000);
  });

  it('rejects a repeated pagination cursor', async () => {
    const response = () =>
      new Response(JSON.stringify({ offers: [], next: 'same' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    const client = new OpenSeaClient({
      apiKey: 'fixture-key',
      fetchImpl: jest.fn().mockImplementation(response),
      sleep: async () => undefined,
      now: () => 1_000
    });

    await expect(client.getAllOffers('fixture', 100_000)).rejects.toThrow(
      'Repeated OpenSea offers cursor'
    );
  });
});
