jest.mock('@/redis', () => ({ getRedisClient: () => null }));

import { OpenSeaClient, OpenSeaHttpError } from './opensea-client';
import * as normalizer from './opensea-normalizer';
import {
  explainedByRecordedEvent,
  missingOrders,
  OpenSeaReconciliationDb,
  reconcileOpenSeaOrders
} from './opensea-reconciliation';
import {
  MarketDepthOrderStatusEvidence,
  MarketDepthReconciliation,
  NormalizedMarketDepthOrder
} from './market-depth.types';

const ORDER: NormalizedMarketDepthOrder = {
  order_key: 'order-key',
  order_id: `0x${'a'.repeat(64)}`,
  source: 'opensea',
  protocol: '0x2222222222222222222222222222222222222222',
  contract: '0x1111111111111111111111111111111111111111',
  collection_slug: 'fixture',
  token_id: '42',
  side: 'ask',
  status: 'ACTIVE',
  is_private: false,
  scope: 'token',
  maker: '0x3333333333333333333333333333333333333333',
  original_quantity: '1',
  remaining_quantity: '1',
  currency_contract: '0x0000000000000000000000000000000000000000',
  currency_symbol: 'ETH',
  currency_decimals: 18,
  current_price_raw: '100000000000000000',
  current_price_decimal: '0.1',
  unit_price_decimal: '0.1',
  start_at: new Date('2026-09-10T10:00:00.000Z'),
  end_at: new Date('2026-09-10T11:00:00.000Z'),
  observed_at: new Date('2026-09-10T10:30:00.000Z'),
  source_url: null,
  criteria: null,
  protocol_data: null,
  source_data: null,
  is_executable: true,
  executable_caveats: null
};

function reconciliation(order = ORDER): MarketDepthReconciliation {
  return {
    id: 'queue-id',
    prior_snapshot_id: 'snapshot-id',
    source: 'opensea',
    chain: 'ethereum',
    chain_id: '1',
    contract: order.contract,
    collection_slug: order.collection_slug,
    protocol: order.protocol,
    order_id: order.order_id,
    order_key: order.order_key,
    token_id: order.token_id,
    side: order.side,
    prior_order: order,
    status: 'PENDING',
    first_missing_at: new Date('2026-09-10T10:45:00.000Z'),
    next_attempt_at: new Date('2026-09-10T10:45:00.000Z'),
    last_attempt_at: null,
    attempt_count: 0,
    resolved_at: null,
    last_error: null
  };
}

function database(
  due: MarketDepthReconciliation[],
  evidence: MarketDepthOrderStatusEvidence[] = []
): jest.Mocked<OpenSeaReconciliationDb> {
  return {
    enqueueReconciliations: jest.fn().mockResolvedValue(undefined),
    getDueReconciliations: jest.fn().mockResolvedValue(due),
    getOrderStatusEvidence: jest.fn().mockResolvedValue(evidence),
    markReconciliationRetry: jest.fn().mockResolvedValue(true),
    resolveReconciliations: jest
      .fn()
      .mockImplementation(async ({ items }) => items.length),
    deferReconciliations: jest
      .fn()
      .mockImplementation(async ({ items }) => items.length),
    getCursor: jest.fn().mockResolvedValue(null),
    appendEvents: jest.fn().mockResolvedValue(undefined)
  };
}

function evidence(
  kind: string,
  occurredAt: string,
  orderId = ORDER.order_id
): MarketDepthOrderStatusEvidence {
  return { order_id: orderId, kind, occurred_at: new Date(occurredAt) };
}

describe('OpenSea order reconciliation', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    { timestamp: '2000-01-01T00:00:00Z', budget: 60_000, shouldRequest: true },
    { timestamp: '2099-01-01T00:00:00Z', budget: 2_000, shouldRequest: false }
  ])(
    'uses the injected clock $timestamp for request-budget decisions',
    async ({ timestamp, budget, shouldRequest }) => {
      const attemptedAt = new Date(timestamp);
      const db = database([reconciliation({ ...ORDER, end_at: null })]);
      const client = {
        getOrder: jest
          .fn()
          .mockRejectedValue(new OpenSeaHttpError(404, 0, 'not found'))
      } as unknown as OpenSeaClient;
      await reconcileOpenSeaOrders({
        target: { contract: ORDER.contract, collection_slug: 'fixture' },
        client,
        db,
        now: () => attemptedAt,
        deadlineMs: attemptedAt.getTime() + budget
      });
      expect(client.getOrder).toHaveBeenCalledTimes(shouldRequest ? 1 : 0);
      expect(db.markReconciliationRetry).toHaveBeenCalledTimes(
        shouldRequest ? 1 : 0
      );
      expect(db.deferReconciliations).toHaveBeenCalledTimes(
        shouldRequest ? 0 : 1
      );
    }
  );
  it('queues only previously active orders absent from the new book', () => {
    expect(missingOrders([ORDER], [])).toEqual([ORDER]);
    expect(missingOrders([ORDER], [ORDER])).toEqual([]);
    expect(missingOrders([{ ...ORDER, status: 'CANCELLED' }], [])).toEqual([]);
  });

  it('records elapsed expiry without making a provider request', async () => {
    const db = database([reconciliation()]);
    const client = { getOrder: jest.fn() } as unknown as OpenSeaClient;

    await expect(
      reconcileOpenSeaOrders({
        target: { contract: ORDER.contract, collection_slug: 'fixture' },
        client,
        db,
        deadlineMs: Date.now() + 60_000,
        now: () => new Date('2026-09-10T12:00:00.000Z')
      })
    ).resolves.toBe(1);
    expect(client.getOrder).not.toHaveBeenCalled();
    expect(db.appendEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            kind: 'expiration',
            source_evidence: 'elapsed_expiry'
          })
        ]
      })
    );
    expect(db.resolveReconciliations).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ id: 'queue-id', expected_attempt_count: 0 }]
      })
    );
  });

  it('treats a provider 404 as unknown and leaves durable retry work', async () => {
    const futureOrder = {
      ...ORDER,
      end_at: new Date('2026-09-11T12:00:00.000Z')
    };
    const db = database([reconciliation(futureOrder)]);
    const client = {
      getOrder: jest
        .fn()
        .mockRejectedValue(new OpenSeaHttpError(404, 0, 'OpenSea HTTP 404'))
    } as unknown as OpenSeaClient;

    await expect(
      reconcileOpenSeaOrders({
        target: { contract: ORDER.contract, collection_slug: 'fixture' },
        client,
        db,
        deadlineMs: Date.now() + 60_000,
        now: () => new Date('2026-09-10T12:00:00.000Z')
      })
    ).resolves.toBe(0);
    expect(db.markReconciliationRetry).toHaveBeenCalledWith(
      expect.objectContaining({ last_error: 'provider_order_404_unknown' })
    );
    expect(db.appendEvents).not.toHaveBeenCalled();
    expect(db.resolveReconciliations).not.toHaveBeenCalled();
  });

  it('keeps inactive retries idempotent but records each new absence episode', async () => {
    const futureOrder = { ...ORDER, end_at: new Date('2026-09-11T12:00:00Z') };
    const episode = reconciliation(futureOrder);
    const db = database([episode]);
    const client = {
      getOrder: jest.fn().mockResolvedValue({ order: {} })
    } as unknown as OpenSeaClient;
    jest.spyOn(normalizer, 'normalizeOpenSeaOrder').mockReturnValue({
      order: { ...futureOrder, status: 'INACTIVE' },
      unsupported: false,
      skipped: false,
      reasons: []
    });
    let attemptedAt = new Date('2026-09-10T12:00:00Z');
    const input = {
      target: { contract: ORDER.contract, collection_slug: 'fixture' },
      client,
      db,
      deadlineMs: Date.now() + 60_000,
      now: () => attemptedAt
    };
    await reconcileOpenSeaOrders(input);
    attemptedAt = new Date('2026-09-10T12:01:00Z');
    await reconcileOpenSeaOrders(input);
    jest.mocked(db.getDueReconciliations).mockResolvedValue([
      {
        ...episode,
        id: 'next-episode',
        first_missing_at: new Date('2026-09-10T12:02:00Z')
      }
    ]);
    attemptedAt = new Date('2026-09-10T12:03:00Z');
    await reconcileOpenSeaOrders(input);

    const events = jest
      .mocked(db.appendEvents)
      .mock.calls.map(([append]) => append.events[0]);
    expect(events).toHaveLength(3);
    expect(events[0].event_id).toBe(events[1].event_id);
    expect(events[2].event_id).not.toBe(events[0].event_id);
    expect(events[0].provider_at?.toISOString()).toBe(
      '2026-09-10T12:00:00.000Z'
    );
    expect(events[1].provider_at?.toISOString()).toBe(
      '2026-09-10T12:01:00.000Z'
    );
    expect(events[2].provider_at?.toISOString()).toBe(
      '2026-09-10T12:03:00.000Z'
    );
  });

  describe('local resolution', () => {
    const NOW = new Date('2026-09-10T12:00:00.000Z');
    const FUTURE_ORDER = {
      ...ORDER,
      end_at: new Date('2026-09-11T12:00:00.000Z')
    };

    function run(db: OpenSeaReconciliationDb, client?: OpenSeaClient) {
      return reconcileOpenSeaOrders({
        target: { contract: ORDER.contract, collection_slug: 'fixture' },
        client: client ?? ({ getOrder: jest.fn() } as unknown as OpenSeaClient),
        db,
        deadlineMs: NOW.getTime() + 60_000,
        now: () => NOW
      });
    }

    it('resolves an order closed by a recorded cancellation without a request or a new event', async () => {
      const db = database(
        [reconciliation(FUTURE_ORDER)],
        [evidence('cancel', '2026-09-10T09:00:00.000Z')]
      );
      const client = { getOrder: jest.fn() } as unknown as OpenSeaClient;
      await expect(run(db, client)).resolves.toBe(1);
      expect(client.getOrder).not.toHaveBeenCalled();
      expect(db.appendEvents).not.toHaveBeenCalled();
      expect(db.getOrderStatusEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          contract: ORDER.contract,
          sources: ['opensea', 'opensea_stream'],
          orderIds: [ORDER.order_id]
        })
      );
    });

    it('prefers a recorded cancellation over a later elapsed expiry', async () => {
      const db = database(
        [reconciliation()],
        [evidence('cancel', '2026-09-10T10:40:00.000Z')]
      );
      await expect(run(db)).resolves.toBe(1);
      expect(db.appendEvents).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'counts an invalidation after the order was last seen active',
        events: [evidence('invalidate', '2026-09-10T10:40:00.000Z')],
        explained: true
      },
      {
        name: 'ignores an invalidation from before the order was last seen active',
        events: [evidence('invalidate', '2026-09-10T10:00:00.000Z')],
        explained: false
      },
      {
        name: 'ignores an invalidation that was later revalidated',
        events: [
          evidence('invalidate', '2026-09-10T10:40:00.000Z'),
          evidence('revalidate', '2026-09-10T10:41:00.000Z')
        ],
        explained: false
      },
      {
        name: 'does not treat a sale as proof the order closed',
        events: [evidence('sale', '2026-09-10T10:40:00.000Z')],
        explained: false
      }
    ])('$name', ({ events, explained }) => {
      expect(
        explainedByRecordedEvent(reconciliation(FUTURE_ORDER), events)
      ).toBe(explained);
    });

    it('caps provider requests per run while still resolving expired orders', async () => {
      const due = Array.from({ length: 500 }, (_, index) =>
        reconciliation(
          index % 2 === 0
            ? {
                ...FUTURE_ORDER,
                order_id: `future-${index}`,
                order_key: `future-${index}`
              }
            : {
                ...ORDER,
                order_id: `expired-${index}`,
                order_key: `expired-${index}`
              }
        )
      ).map((item, index) => ({ ...item, id: `queue-${index}` }));
      const db = database([]);
      db.getDueReconciliations
        .mockResolvedValueOnce(due)
        .mockResolvedValueOnce([]);
      const client = {
        getOrder: jest
          .fn()
          .mockRejectedValue(new OpenSeaHttpError(404, 0, 'not found'))
      } as unknown as OpenSeaClient;

      await expect(run(db, client)).resolves.toBe(250);
      expect(client.getOrder).toHaveBeenCalledTimes(25);
      expect(db.markReconciliationRetry).toHaveBeenCalledTimes(25);
      // The other 225 move behind newer work without counting an attempt.
      expect(db.deferReconciliations).toHaveBeenCalledTimes(1);
      const deferral = db.deferReconciliations.mock.calls[0][0];
      expect(deferral.items).toHaveLength(225);
      expect(deferral.items[0]).toEqual({
        id: 'queue-50',
        expected_attempt_count: 0
      });
      expect(deferral.next_attempt_at).toEqual(
        new Date(NOW.getTime() + 6 * 60 * 60_000)
      );
      expect(db.appendEvents.mock.calls[0][0].events).toHaveLength(250);
      // A full page continues after its last key.
      expect(db.getDueReconciliations).toHaveBeenNthCalledWith(
        2,
        'opensea',
        ORDER.contract,
        'fixture',
        NOW,
        500,
        { next_attempt_at: due[499].next_attempt_at, id: 'queue-499' }
      );
    });

    it('stops paging at the per-run limit', async () => {
      const page = Array.from({ length: 500 }, (_, index) => ({
        ...reconciliation(),
        id: `queue-${index}`
      }));
      const db = database(page);
      await run(db);
      expect(db.getDueReconciliations).toHaveBeenCalledTimes(10);
      expect(db.resolveReconciliations).toHaveBeenCalledTimes(10);
    });

    it('stops paging when the work budget is spent', async () => {
      let clock = NOW.getTime();
      const page = Array.from({ length: 500 }, (_, index) => ({
        ...reconciliation(),
        id: `queue-${index}`
      }));
      const db = database(page);
      db.resolveReconciliations.mockImplementation(async ({ items }) => {
        clock += 25_000;
        return items.length;
      });
      await reconcileOpenSeaOrders({
        target: { contract: ORDER.contract, collection_slug: 'fixture' },
        client: { getOrder: jest.fn() } as unknown as OpenSeaClient,
        db,
        deadlineMs: NOW.getTime() + 600_000,
        now: () => new Date(clock)
      });
      // 60 seconds of work: pages at 0s, 25s and 50s.
      expect(db.getDueReconciliations).toHaveBeenCalledTimes(3);
    });
  });
});
