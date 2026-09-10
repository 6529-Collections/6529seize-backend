jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('@/nextgen/nextgen.db', () => ({
  fetchNextGenCollections: jest.fn(),
  fetchNextgenTokens: jest.fn()
}));

import { getDataSource } from '@/db';
import {
  fetchNextGenCollections,
  fetchNextgenTokens
} from '@/nextgen/nextgen.db';
import { OpenSeaClient } from './opensea-client';
import {
  discoverOpenSeaCollections,
  MarketDepthPersistence,
  OpenSeaCollectionTarget,
  pollOpenSeaCollection,
  pollOpenSeaEvents
} from './opensea-poller';
import { MarketDepthCursor } from './market-depth.types';
import { PublishMarketDepthSnapshotInput } from './market-depth.types';

const TARGET: OpenSeaCollectionTarget = {
  contract: '0x1111111111111111111111111111111111111111',
  collection_slug: 'fixture',
  collection_id: 7
};

describe('discoverOpenSeaCollections', () => {
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

    await expect(pollOpenSeaEvents(TARGET, { client, db, now })).resolves.toBe(
      0
    );
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
});

describe('pollOpenSeaCollection', () => {
  it('publishes only after listings, offers, and the closed event window complete', async () => {
    const db = database();
    const order = {
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
