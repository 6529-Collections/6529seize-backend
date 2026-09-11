jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('@/nextgen/nextgen.db', () => ({
  fetchNextGenCollections: jest.fn(),
  fetchNextgenTokens: jest.fn()
}));

import { getDataSource } from '@/db';
import { Logger } from '@/logging';
import { gunzipSync } from 'node:zlib';
import {
  fetchNextGenCollections,
  fetchNextgenTokens
} from '@/nextgen/nextgen.db';
import {
  OpenSeaClient,
  OpenSeaDeadlineError,
  OpenSeaHttpError
} from './opensea-client';
import {
  discoverOpenSeaCollections,
  MarketDepthPersistence,
  OpenSeaCollectionTarget,
  pollOpenSeaCollection,
  pollOpenSeaEvents,
  pollOpenSeaMarketDepthForContract
} from './opensea-poller';
import { MarketDepthCursor } from './market-depth.types';
import { PublishMarketDepthSnapshotInput } from './market-depth.types';

const TARGET: OpenSeaCollectionTarget = {
  contract: '0x1111111111111111111111111111111111111111',
  collection_slug: 'fixture',
  collection_id: 7
};

describe('discoverOpenSeaCollections', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses local NextGen links and falls back to representative token lookup', async () => {
    (getDataSource as jest.Mock).mockReturnValue({ manager: {} });
    (fetchNextGenCollections as jest.Mock).mockResolvedValue([
      { id: 2 },
      {
        id: 1,
        opensea_link: 'https://opensea.io/collection/local-slug?tab=items'
      }
    ]);
    (fetchNextgenTokens as jest.Mock).mockResolvedValue([
      { id: '20000000001', collection_id: 2 }
    ]);
    const client = {
      getNftCollection: jest.fn().mockResolvedValue('fallback-slug')
    } as unknown as OpenSeaClient;

    const targets = await discoverOpenSeaCollections(client);

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection_id: 1,
          collection_slug: 'local-slug'
        }),
        expect.objectContaining({
          collection_id: 2,
          collection_slug: 'fallback-slug'
        })
      ])
    );
    expect(client.getNftCollection).toHaveBeenCalledWith(
      expect.any(String),
      '20000000001'
    );
  });

  it.each([
    ['not indexed', new OpenSeaHttpError(404, 0, 'fixture request details')],
    ['transport failure', new Error('fixture authenticated URL')]
  ])(
    'preserves other targets when the first project lookup fails: %s',
    async (_reason, error) => {
      const warn = jest
        .spyOn(Logger.get('OPENSEA_MARKET_DEPTH'), 'warn')
        .mockImplementation(() => undefined);
      (getDataSource as jest.Mock).mockReturnValue({ manager: {} });
      (fetchNextGenCollections as jest.Mock).mockResolvedValue([
        { id: 1 },
        { id: 2 },
        { id: 3, opensea_link: 'https://opensea.io/collection/local-slug' }
      ]);
      (fetchNextgenTokens as jest.Mock).mockResolvedValue([
        { id: '10000000001', collection_id: 1 },
        { id: '20000000001', collection_id: 2 }
      ]);
      const getNftCollection = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('later-slug');
      const client = { getNftCollection } as unknown as OpenSeaClient;

      const targets = await discoverOpenSeaCollections(client, 100_000);

      expect(targets.map((target) => target.collection_slug)).toEqual([
        'thememes6529',
        'memelab6529',
        '6529-gradient',
        'later-slug',
        'local-slug'
      ]);
      expect(targets.map((target) => target.collection_id)).toEqual([
        null,
        null,
        null,
        2,
        3
      ]);
      expect(getNftCollection).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        '20000000001',
        100_000
      );
      // Do not log provider errors, whose messages or causes can contain credentials.
      expect(warn.mock.calls).toEqual([
        [
          '[NEXTGEN COLLECTION 1] OpenSea discovery lookup failed; will retry next scheduled run'
        ]
      ]);

      getNftCollection.mockResolvedValueOnce('recovered-slug');
      const retried = await discoverOpenSeaCollections(client, 200_000);
      expect(retried).toContainEqual(
        expect.objectContaining({
          collection_id: 1,
          collection_slug: 'recovered-slug'
        })
      );
      expect(getNftCollection).toHaveBeenNthCalledWith(
        3,
        expect.any(String),
        '10000000001',
        200_000
      );
    }
  );

  it('still fails a NextGen poll visibly when all project lookups fail', async () => {
    jest
      .spyOn(Logger.get('OPENSEA_MARKET_DEPTH'), 'warn')
      .mockImplementation(() => undefined);
    (getDataSource as jest.Mock).mockReturnValue({ manager: {} });
    (fetchNextGenCollections as jest.Mock).mockResolvedValue([{ id: 1 }]);
    (fetchNextgenTokens as jest.Mock).mockResolvedValue([
      { id: '10000000001', collection_id: 1 }
    ]);
    const client = {
      getNftCollection: jest
        .fn()
        .mockRejectedValue(new OpenSeaHttpError(404, 0, 'OpenSea HTTP 404')),
      getAllListings: jest.fn()
    } as unknown as OpenSeaClient;
    const db = database();

    await expect(
      pollOpenSeaMarketDepthForContract('nextgen', { client, db })
    ).rejects.toThrow('No OpenSea market-depth target for nextgen');
    expect(client.getAllListings).not.toHaveBeenCalled();
    expect(db.publishCompletedSnapshot).not.toHaveBeenCalled();
  });
});

function database(
  cursor: MarketDepthCursor | null = null
): MarketDepthPersistence {
  return {
    getCursor: jest.fn().mockResolvedValue(cursor),
    getLatestCompletedSnapshot: jest.fn().mockResolvedValue(null),
    appendEvents: jest.fn().mockResolvedValue(undefined),
    enqueueReconciliations: jest.fn().mockResolvedValue(undefined),
    getDueReconciliations: jest.fn().mockResolvedValue([]),
    markReconciliationRetry: jest.fn().mockResolvedValue(true),
    resolveReconciliation: jest.fn().mockResolvedValue(true),
    publishCompletedSnapshot: jest
      .fn()
      .mockImplementation(async (input: PublishMarketDepthSnapshotInput) => ({
        ...input,
        chain: 'ethereum',
        chain_id: '1',
        schema_version: 1,
        order_count: input.orders.length,
        ask_count: input.orders.filter((order) => order.side === 'ask').length,
        bid_count: input.orders.filter((order) => order.side === 'bid').length
      }))
  };
}

describe('pollOpenSeaEvents', () => {
  it('advances the completed watermark only on the last page', async () => {
    const db = database();
    const client = {
      getEventsPage: jest
        .fn()
        .mockResolvedValueOnce({ entries: [], next: 'page-two' })
        .mockResolvedValueOnce({ entries: [], next: null })
    } as unknown as OpenSeaClient;
    const now = () => new Date('2026-09-10T12:00:00.000Z');

    await expect(
      pollOpenSeaEvents(TARGET, { client, db, now })
    ).resolves.toMatchObject({
      eventCount: 0,
      pageCount: 2,
      completed: true,
      deferred: false
    });
    const append = db.appendEvents as jest.Mock;
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0][0]).toMatchObject({
      expected_cursor: null,
      expected_watermark: null,
      next_cursor: 'page-two',
      provider_watermark: null
    });
    expect(append.mock.calls[1][0]).toMatchObject({
      expected_cursor: 'page-two',
      expected_watermark: null,
      next_cursor: null,
      provider_watermark: '1789041480'
    });
  });

  it('defers at the page limit and resumes the exact closed window before advancing the watermark', async () => {
    const db = database();
    let cursor: MarketDepthCursor | null = null;
    (db.getCursor as jest.Mock).mockImplementation(async () => cursor);
    (db.appendEvents as jest.Mock).mockImplementation(async (input) => {
      cursor = { ...input, chain_id: '1', provider_cursor: input.next_cursor };
    });
    const getEventsPage = jest
      .fn()
      .mockResolvedValueOnce({ entries: [], next: 'resume-page' })
      .mockResolvedValueOnce({ entries: [], next: null });
    const client = { getEventsPage } as unknown as OpenSeaClient;
    let time = new Date('2026-09-10T12:00:00Z');
    const now = () => time;
    const first = await pollOpenSeaEvents(TARGET, {
      client,
      db,
      now,
      eventPageLimit: 1
    });
    expect(first).toMatchObject({
      pageCount: 1,
      completed: false,
      deferred: true,
      completedWatermark: null
    });
    time = new Date('2026-09-10T12:30:00Z');
    const second = await pollOpenSeaEvents(TARGET, {
      client,
      db,
      now,
      eventPageLimit: 1
    });
    expect(getEventsPage.mock.calls[1].slice(0, 4)).toEqual([
      'fixture',
      getEventsPage.mock.calls[0][1],
      getEventsPage.mock.calls[0][2],
      'resume-page'
    ]);
    expect(second).toMatchObject({
      completed: true,
      deferred: false,
      windowBefore: first.windowBefore,
      completedWatermark: String(first.windowBefore)
    });
    expect((db.appendEvents as jest.Mock).mock.calls[1][0]).toMatchObject({
      expected_cursor: 'resume-page',
      expected_watermark: null,
      next_cursor: null,
      provider_watermark: String(first.windowBefore)
    });
  });

  it('defers a typed request-budget exhaustion without advancing the checkpoint', async () => {
    const db = database();
    const client = {
      getEventsPage: jest
        .fn()
        .mockRejectedValue(new OpenSeaDeadlineError('fixture budget exhausted'))
    } as unknown as OpenSeaClient;
    await expect(
      pollOpenSeaEvents(TARGET, { client, db })
    ).resolves.toMatchObject({
      completed: false,
      deferred: true,
      pageCount: 0
    });
    expect(db.appendEvents).not.toHaveBeenCalled();
  });

  it.each([
    new OpenSeaHttpError(429, 0, 'fixture HTTP 429'),
    new OpenSeaHttpError(503, 0, 'fixture HTTP 503'),
    Object.assign(new Error('fixture aborted'), { name: 'AbortError' }),
    new Error('fixture provider failure')
  ])(
    'preserves actual provider errors instead of treating them as deferral',
    async (failure) => {
      const client = {
        getEventsPage: jest.fn().mockRejectedValue(failure)
      } as unknown as OpenSeaClient;
      await expect(
        pollOpenSeaEvents(TARGET, { client, db: database() })
      ).rejects.toBe(failure);
    }
  );

  it('preserves a failed checkpoint write', async () => {
    const db = database();
    const failure = new Error('fixture database failure');
    (db.appendEvents as jest.Mock).mockRejectedValue(failure);
    const client = {
      getEventsPage: jest.fn().mockResolvedValue({ entries: [], next: 'next' })
    } as unknown as OpenSeaClient;
    await expect(pollOpenSeaEvents(TARGET, { client, db })).rejects.toBe(
      failure
    );
  });
});

describe('multi-project lifecycle scheduling', () => {
  it('attempts all books and reconciliation passes before fairly bounded catch-up', async () => {
    (getDataSource as jest.Mock).mockReturnValue({ manager: {} });
    (fetchNextGenCollections as jest.Mock).mockResolvedValue([
      { id: 1, opensea_link: 'https://opensea.io/collection/first' },
      { id: 2, opensea_link: 'https://opensea.io/collection/second' }
    ]);
    (fetchNextgenTokens as jest.Mock).mockResolvedValue([]);
    const calls: string[] = [];
    const db = database();
    (db.getDueReconciliations as jest.Mock).mockImplementation(
      async (_source, _contract, slug) => {
        calls.push(`reconcile:${slug}`);
        return [];
      }
    );
    let time = Date.parse('2026-09-10T12:00:00Z');
    const started = time;
    const now = () => new Date(time);
    let cursorNumber = 0;
    const getEventsPage = jest.fn().mockImplementation(async (slug) => {
      calls.push(`events:${slug}`);
      time += 60_000;
      return { entries: [], next: `page-${++cursorNumber}` };
    });
    const client = {
      getAllListings: jest.fn().mockImplementation(async (slug) => {
        calls.push(`book:${slug}`);
        return [];
      }),
      getAllOffers: jest.fn().mockResolvedValue([]),
      getEventsPage
    } as unknown as OpenSeaClient;
    await expect(
      pollOpenSeaMarketDepthForContract('nextgen', {
        client,
        db,
        now,
        deadlineMs: started + 780_000,
        eventPageLimit: 4
      })
    ).resolves.toHaveLength(2);
    expect(calls).toEqual([
      'book:first',
      'book:second',
      'reconcile:first',
      'reconcile:second',
      'events:first',
      'events:first',
      'events:second',
      'events:second'
    ]);
    expect(getEventsPage.mock.calls[0][4]).toBe(started + 150_000);
    expect(getEventsPage.mock.calls[2][4]).toBe(started + 300_000);
    expect(db.appendEvents).toHaveBeenCalledTimes(4);
    expect(
      (db.appendEvents as jest.Mock).mock.calls.every(
        ([input]) => input.provider_watermark === null
      )
    ).toBe(true);
  });

  it('stops on the time slice after persisting its current page', async () => {
    const db = database();
    let time = Date.now();
    const deadlineMs = time + 1_000;
    const getEventsPage = jest.fn().mockImplementation(async () => {
      time += 1_000;
      return { entries: [], next: 'resume' };
    });
    await expect(
      pollOpenSeaEvents(TARGET, {
        client: { getEventsPage } as unknown as OpenSeaClient,
        db,
        now: () => new Date(time),
        deadlineMs
      })
    ).resolves.toMatchObject({
      completed: false,
      deferred: true,
      pageCount: 1
    });
    expect(getEventsPage).toHaveBeenCalledTimes(1);
    expect(db.appendEvents).toHaveBeenCalledTimes(1);
  });
});

function listingOrder() {
  return {
    order_hash: `0x${'a'.repeat(64)}`,
    chain: 'ethereum',
    protocol_address: '0x2222222222222222222222222222222222222222',
    status: 'ACTIVE',
    remaining_quantity: '1',
    price: {
      current: { currency: 'ETH', decimals: 18, value: '100000000000000000' }
    },
    protocol_data: {
      parameters: {
        offerer: '0x3333333333333333333333333333333333333333',
        orderType: 0,
        startTime: '1789040000',
        endTime: '1789050000',
        offer: [
          {
            itemType: 3,
            token: TARGET.contract,
            identifierOrCriteria: '42',
            startAmount: '1'
          }
        ],
        consideration: [
          {
            itemType: 0,
            token: '0x0000000000000000000000000000000000000000',
            startAmount: '100000000000000000'
          }
        ]
      }
    }
  };
}

describe('pollOpenSeaCollection', () => {
  it('publishes only after listings, offers, and the closed event window complete', async () => {
    const db = database();
    const order = listingOrder();
    const client = {
      getAllListings: jest.fn().mockResolvedValue([order]),
      getAllOffers: jest.fn().mockResolvedValue([]),
      getEventsPage: jest.fn().mockResolvedValue({ entries: [], next: null })
    } as unknown as OpenSeaClient;
    const now = () => new Date('2026-09-10T12:00:00.000Z');

    const snapshot = await pollOpenSeaCollection(TARGET, { client, db, now });

    expect(snapshot.collection_id).toBe(7);
    expect(db.publishCompletedSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: TARGET.contract,
        collection_slug: 'fixture',
        collection_id: 7,
        raw_order_count: 1,
        unsupported_count: 0,
        skipped_count: 0,
        event_count: 0,
        orders: [expect.objectContaining({ token_id: '42', side: 'ask' })]
      })
    );
  });

  it.each([
    { remaining_quantity: '3', status: 'ACTIVE' },
    { remaining_quantity: '0', status: 'FULFILLED' }
  ])(
    'keeps the collection available but excludes conflicting order observations %j',
    async (changedState) => {
      const db = database();
      const first = listingOrder();
      first.protocol_data.parameters.offer[0].startAmount = '4';
      first.remaining_quantity = '4';
      const changed = { ...first, ...changedState };
      const unaffected = { ...first, order_hash: `0x${'b'.repeat(64)}` };
      const rawListings = [first, changed, first, unaffected];
      const client = {
        getAllListings: jest.fn().mockResolvedValue(rawListings),
        getAllOffers: jest.fn().mockResolvedValue([]),
        getEventsPage: jest.fn().mockResolvedValue({ entries: [], next: null })
      } as unknown as OpenSeaClient;
      await pollOpenSeaCollection(TARGET, {
        client,
        db,
        now: () => new Date('2026-09-10T12:00:00Z')
      });
      const publication = jest.mocked(db.publishCompletedSnapshot).mock
        .calls[0][0];
      expect(publication.raw_order_count).toBe(4);
      expect(publication.orders).toHaveLength(2);
      expect(publication.orders[0]).toMatchObject({
        order_id: first.order_hash,
        remaining_quantity: '4',
        is_executable: false,
        executable_caveats: ['conflicting_provider_observations']
      });
      expect(publication.orders[1].is_executable).toBe(true);
      expect(
        JSON.parse(gunzipSync(publication.raw_archive_gzip).toString()).listings
      ).toEqual(rawListings);
    }
  );

  it('deduplicates matching observations without excluding executable depth', async () => {
    const db = database();
    const order = listingOrder();
    const client = {
      getAllListings: jest
        .fn()
        .mockResolvedValue([
          order,
          { ...order, provider_metadata: 'second page' }
        ]),
      getAllOffers: jest.fn().mockResolvedValue([]),
      getEventsPage: jest.fn().mockResolvedValue({ entries: [], next: null })
    } as unknown as OpenSeaClient;
    await pollOpenSeaCollection(TARGET, {
      client,
      db,
      now: () => new Date('2026-09-10T12:00:00Z')
    });
    const publication = jest.mocked(db.publishCompletedSnapshot).mock
      .calls[0][0];
    expect(publication.orders).toHaveLength(1);
    expect(publication.orders[0]).toMatchObject({
      is_executable: true,
      executable_caveats: null
    });
  });

  it('keeps the completed book published when event catch-up fails', async () => {
    const db = database();
    const client = {
      getAllListings: jest.fn().mockResolvedValue([]),
      getAllOffers: jest.fn().mockResolvedValue([]),
      getEventsPage: jest
        .fn()
        .mockRejectedValue(new Error('events unavailable'))
    } as unknown as OpenSeaClient;

    await expect(
      pollOpenSeaCollection(TARGET, {
        client,
        db,
        now: () => new Date('2026-09-10T12:00:00.000Z')
      })
    ).rejects.toThrow('events unavailable');
    expect(db.publishCompletedSnapshot).toHaveBeenCalledTimes(1);
    expect(db.appendEvents).not.toHaveBeenCalled();
  });
});
