jest.mock('@/redis', () => ({ getRedisClient: () => null }));

import { OpenSeaClient, parseOpenSeaJson } from './opensea-client';

it('preserves JSON integers beyond JavaScript safe-number precision', () => {
  expect(parseOpenSeaJson('{"remaining_quantity":9007199254740993}')).toEqual({
    remaining_quantity: '9007199254740993'
  });
});

describe('OpenSeaClient', () => {
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
