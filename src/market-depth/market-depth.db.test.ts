import 'reflect-metadata';
import { gzipSync } from 'node:zlib';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  MarketDepthCursorConflictError,
  marketDepthDb,
  StaleMarketDepthSnapshotError
} from './market-depth.db';
import {
  MarketDepthEventInput,
  MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES,
  NormalizedMarketDepthOrder,
  PublishMarketDepthSnapshotInput
} from './market-depth.types';

const CONTRACT = '0x1234567890abcdef1234567890abcdef12345678';
const UINT256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

function order(
  overrides: Partial<NormalizedMarketDepthOrder> = {}
): NormalizedMarketDepthOrder {
  return {
    order_key: 'order-key-1',
    order_id: 'provider-order-1',
    source: 'opensea-rest',
    protocol: 'seaport',
    contract: CONTRACT,
    collection_slug: 'project-a',
    token_id: '1',
    side: 'ask',
    status: 'ACTIVE',
    is_private: false,
    scope: 'token',
    maker: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    original_quantity: '1',
    remaining_quantity: '1',
    currency_contract: null,
    currency_symbol: 'ETH',
    currency_decimals: 18,
    current_price_raw: '1000000000000000000',
    current_price_decimal: '1',
    unit_price_decimal: '1',
    start_at: new Date('2026-09-10T00:00:00.000Z'),
    end_at: new Date('2026-09-11T00:00:00.000Z'),
    observed_at: new Date('2026-09-10T00:01:00.000Z'),
    source_url: null,
    criteria: { token_id: '1' },
    protocol_data: null,
    source_data: { preserved: true },
    is_executable: true,
    executable_caveats: [],
    ...overrides
  };
}

function snapshot(
  id: string,
  overrides: Partial<PublishMarketDepthSnapshotInput> = {}
): PublishMarketDepthSnapshotInput {
  return {
    id,
    source: 'opensea-rest',
    contract: CONTRACT,
    collection_slug: 'project-a',
    collection_id: null,
    started_at: new Date('2026-09-10T00:00:00.000Z'),
    completed_at: new Date('2026-09-10T00:01:00.000Z'),
    normalizer_version: 'test-v1',
    raw_order_count: 1,
    unsupported_count: 0,
    skipped_count: 0,
    event_count: 0,
    raw_archive_gzip: gzipSync(JSON.stringify({ raw: true })),
    normalized_archive_gzip: gzipSync(JSON.stringify({ normalized: true })),
    orders: [order()],
    ...overrides
  };
}

function event(overrides: Partial<MarketDepthEventInput> = {}) {
  return {
    event_id: 'event-1',
    kind: 'order_created',
    source: 'opensea-stream',
    source_evidence: 'stream',
    provider_at: new Date('2026-09-10T00:00:00.000Z'),
    observed_at: new Date('2026-09-10T00:00:01.000Z'),
    order_id: 'provider-order-1',
    contract: CONTRACT,
    collection_slug: 'project-a',
    token_id: UINT256,
    maker: null,
    taker: null,
    quantity: UINT256,
    currency_contract: null,
    currency_symbol: 'ETH',
    currency_decimals: 18,
    price_raw: UINT256,
    price_decimal: null,
    transaction_hash: null,
    raw: { exact: UINT256 },
    ...overrides
  } satisfies MarketDepthEventInput;
}

describeWithSeed('MarketDepthDb', [] as never[], () => {
  it('rejects archives that cannot fit safely in the configured SQL packet', async () => {
    await expect(
      marketDepthDb.publishCompletedSnapshot(
        snapshot('00000000-0000-4000-8000-000000000000', {
          raw_archive_gzip: Buffer.concat([
            Buffer.from([0x1f, 0x8b]),
            Buffer.alloc(MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES / 2 - 1)
          ]),
          normalized_archive_gzip: Buffer.concat([
            Buffer.from([0x1f, 0x8b]),
            Buffer.alloc(MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES / 2 - 1)
          ])
        })
      )
    ).rejects.toThrow('combined compressed archive limit');
  });

  it('rolls back a failed replacement and retains the last complete book', async () => {
    const first = snapshot('00000000-0000-4000-8000-000000000001');
    await marketDepthDb.publishCompletedSnapshot(first);

    const duplicateProviderOrder = order({
      order_key: 'different-key',
      order_id: first.orders[0].order_id
    });
    await expect(
      marketDepthDb.publishCompletedSnapshot(
        snapshot('00000000-0000-4000-8000-000000000002', {
          started_at: new Date('2026-09-10T01:00:00.000Z'),
          completed_at: new Date('2026-09-10T01:01:00.000Z'),
          raw_order_count: 2,
          orders: [first.orders[0], duplicateProviderOrder]
        })
      )
    ).rejects.toThrow();

    const current = await marketDepthDb.getLatestCompletedSnapshot(
      first.source,
      first.contract,
      first.collection_slug
    );
    expect(current?.snapshot.id).toBe(first.id);
    expect(current?.orders.map((item) => item.order_key)).toEqual([
      'order-key-1'
    ]);
    const archive = await marketDepthDb.getSnapshotArchive(first.id);
    expect(Buffer.isBuffer(archive?.raw_archive_gzip)).toBe(true);
    expect(archive?.raw_archive_gzip.subarray(0, 2)).toEqual(
      Buffer.from([0x1f, 0x8b])
    );
  });

  it('rolls back publication when its durable reconciliation enqueue fails', async () => {
    const first = snapshot('00000000-0000-4000-8000-000000000010');
    await marketDepthDb.publishCompletedSnapshot(first);

    await expect(
      marketDepthDb.publishCompletedSnapshot(
        snapshot('00000000-0000-4000-8000-000000000011', {
          started_at: new Date('2026-09-10T01:00:00.000Z'),
          completed_at: new Date('2026-09-10T01:01:00.000Z'),
          orders: [
            order({ order_key: 'replacement', order_id: 'replacement' })
          ],
          reconciliations: [
            {
              prior_snapshot_id: first.id,
              source: first.source,
              contract: first.contract,
              collection_slug: first.collection_slug,
              missing_at: new Date('2026-09-10T01:01:00.000Z'),
              order: order({
                source_data: BigInt(1) as unknown as Record<string, never>
              })
            }
          ]
        })
      )
    ).rejects.toThrow();

    const current = await marketDepthDb.getLatestCompletedSnapshot(
      first.source,
      first.contract,
      first.collection_slug
    );
    expect(current?.snapshot.id).toBe(first.id);
    const queues = await sqlExecutor.execute<{ count: number }>(
      'SELECT COUNT(*) AS count FROM market_depth_reconciliation_queue'
    );
    expect(Number(queues[0].count)).toBe(0);
  });

  it('rejects an older-started overlapping poll even if it finishes later', async () => {
    const newer = snapshot('00000000-0000-4000-8000-000000000003', {
      started_at: new Date('2026-09-10T02:00:00.000Z'),
      completed_at: new Date('2026-09-10T02:01:00.000Z')
    });
    await marketDepthDb.publishCompletedSnapshot(newer);

    await expect(
      marketDepthDb.publishCompletedSnapshot(
        snapshot('00000000-0000-4000-8000-000000000004', {
          started_at: new Date('2026-09-10T01:00:00.000Z'),
          completed_at: new Date('2026-09-10T03:00:00.000Z')
        })
      )
    ).rejects.toBeInstanceOf(StaleMarketDepthSnapshotError);
  });

  it('keeps project partitions independent and excludes wrong-snapshot rows', async () => {
    const projectA = snapshot('00000000-0000-4000-8000-000000000005');
    const projectB = snapshot('00000000-0000-4000-8000-000000000006', {
      collection_slug: 'project-b',
      collection_id: 2,
      orders: [
        order({
          order_key: 'project-b-order',
          order_id: 'project-b-order',
          collection_slug: 'project-b'
        })
      ]
    });
    await marketDepthDb.publishCompletedSnapshot(projectA);
    await marketDepthDb.publishCompletedSnapshot(projectB);

    await sqlExecutor.execute(
      `INSERT INTO market_depth_current_orders
       SELECT 'stale-row', :oldSnapshotId, chain, chain_id, 'stale-order',
              source, protocol, contract, collection_slug, token_id, side,
              status, is_private, scope, maker, original_quantity,
              remaining_quantity, currency_contract, currency_symbol,
              currency_decimals, current_price_raw, current_price_decimal,
              unit_price_decimal, start_at, end_at, observed_at, source_url,
              criteria, protocol_data, source_data, is_executable,
              executable_caveats
       FROM market_depth_current_orders WHERE order_key='project-b-order'`,
      { oldSnapshotId: projectA.id }
    );

    const currentB = await marketDepthDb.getLatestCompletedSnapshot(
      projectB.source,
      projectB.contract,
      projectB.collection_slug
    );
    expect(currentB?.snapshot.collection_id).toBe(2);
    expect(currentB?.orders.map((item) => item.order_key)).toEqual([
      'project-b-order'
    ]);

    await marketDepthDb.publishCompletedSnapshot(
      snapshot('00000000-0000-4000-8000-000000000007', {
        started_at: new Date('2026-09-10T04:00:00.000Z'),
        completed_at: new Date('2026-09-10T04:01:00.000Z'),
        orders: [],
        raw_order_count: 0
      })
    );
    expect(
      await marketDepthDb.getLatestCompletedSnapshot(
        projectB.source,
        projectB.contract,
        projectB.collection_slug
      )
    ).toEqual(currentB);
  });

  it('round-trips uint256 identifiers, quantities, and raw prices as strings', async () => {
    const exact = snapshot('00000000-0000-4000-8000-000000000008', {
      raw_order_count: 3,
      orders: [
        order({
          token_id: UINT256,
          status: 'INACTIVE',
          is_private: true,
          original_quantity: UINT256,
          remaining_quantity: UINT256,
          current_price_raw: UINT256
        }),
        order({
          order_key: 'order-key-2',
          order_id: 'provider-order-2',
          token_id: '2'
        }),
        order({
          order_key: 'order-key-collection',
          order_id: 'provider-order-collection',
          token_id: null,
          scope: 'collection'
        })
      ]
    });
    await marketDepthDb.publishCompletedSnapshot(exact);

    const current = await marketDepthDb.getLatestCompletedSnapshot(
      exact.source,
      exact.contract,
      exact.collection_slug
    );
    expect(current?.orders[0]).toMatchObject({
      token_id: UINT256,
      status: 'INACTIVE',
      is_private: true,
      original_quantity: UINT256,
      remaining_quantity: UINT256,
      current_price_raw: UINT256
    });
    const compact = await marketDepthDb.getLatestCompletedSnapshot(
      exact.source,
      exact.contract,
      exact.collection_slug,
      { token_id: UINT256, include_payloads: false }
    );
    expect(compact?.orders[0]).toMatchObject({
      criteria: { token_id: '1' },
      protocol_data: null,
      source_data: null
    });
    expect(compact?.orders.map(({ order_key }) => order_key)).toEqual([
      'order-key-1',
      'order-key-collection'
    ]);
  });

  it('bounds collection ask reads without including bids or changing the snapshot counts', async () => {
    const published = snapshot('00000000-0000-4000-8000-000000000099', {
      raw_order_count: 3,
      orders: [
        order(),
        order({ order_key: 'ask-two', order_id: 'ask-two' }),
        order({ order_key: 'bid-one', order_id: 'bid-one', side: 'bid' })
      ]
    });
    await marketDepthDb.publishCompletedSnapshot(published);
    const current = await marketDepthDb.getLatestCompletedSnapshot(
      published.source,
      published.contract,
      published.collection_slug,
      { side: 'ask', limit: 1 }
    );
    expect(current?.orders).toHaveLength(1);
    expect(current?.orders[0].side).toBe('ask');
    expect(current?.snapshot).toMatchObject({ ask_count: 2, bid_count: 1 });
    await expect(
      marketDepthDb.getLatestCompletedSnapshot(
        published.source,
        published.contract,
        published.collection_slug,
        { side: 'ask', limit: 10002 }
      )
    ).rejects.toThrow('Invalid market-depth read limit');
  });

  it('deduplicates events and advances a cursor with cursor and watermark CAS', async () => {
    const base = {
      source: 'opensea-stream',
      contract: CONTRACT,
      collection_slug: 'project-a',
      provider_at: new Date('2026-09-10T00:00:00.000Z'),
      observed_at: new Date('2026-09-10T00:00:01.000Z'),
      events: [event()]
    };
    await marketDepthDb.appendEvents({
      ...base,
      expected_cursor: null,
      expected_watermark: null,
      next_cursor: 'page-2',
      provider_watermark: null
    });
    await marketDepthDb.appendEvents({
      ...base,
      expected_cursor: 'page-2',
      expected_watermark: null,
      next_cursor: null,
      provider_watermark: 'window-100'
    });

    const count = await sqlExecutor.execute<{ count: number }>(
      'SELECT COUNT(*) AS count FROM market_depth_events'
    );
    expect(Number(count[0].count)).toBe(1);
    const occurred = await sqlExecutor.execute<{ occurred_at: Date }>(
      'SELECT occurred_at FROM market_depth_events WHERE event_id=:eventId',
      { eventId: event().event_id }
    );
    expect(new Date(occurred[0].occurred_at)).toEqual(event().provider_at);
    expect(
      await marketDepthDb.getCursor(
        base.source,
        base.contract,
        base.collection_slug
      )
    ).toMatchObject({
      provider_cursor: null,
      provider_watermark: 'window-100'
    });

    await expect(
      marketDepthDb.appendEvents({
        ...base,
        expected_cursor: null,
        expected_watermark: null,
        next_cursor: 'stale',
        provider_watermark: null
      })
    ).rejects.toBeInstanceOf(MarketDepthCursorConflictError);
  });

  it('durably queues missing orders and resolves retries with attempt CAS', async () => {
    const missingAt = new Date('2026-09-10T02:00:00.000Z');
    const input = {
      prior_snapshot_id: '00000000-0000-4000-8000-000000000009',
      source: 'opensea-rest',
      contract: CONTRACT,
      collection_slug: 'project-a',
      missing_at: missingAt,
      order: order()
    };
    await marketDepthDb.enqueueReconciliations([input, input]);

    const pending = await marketDepthDb.getDueReconciliations(
      input.source,
      input.contract,
      input.collection_slug,
      new Date('2026-09-10T02:00:01.000Z')
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      prior_snapshot_id: input.prior_snapshot_id,
      order_id: input.order.order_id,
      order_key: input.order.order_key,
      status: 'PENDING',
      attempt_count: 0
    });
    expect(pending[0].prior_order.observed_at).toEqual(input.order.observed_at);

    const attemptedAt = new Date('2026-09-10T02:00:02.000Z');
    const nextAttemptAt = new Date('2026-09-10T02:05:00.000Z');
    expect(
      await marketDepthDb.markReconciliationRetry({
        id: pending[0].id,
        expected_attempt_count: 0,
        attempted_at: attemptedAt,
        next_attempt_at: nextAttemptAt,
        last_error: 'provider timeout'
      })
    ).toBe(true);
    expect(
      await marketDepthDb.markReconciliationRetry({
        id: pending[0].id,
        expected_attempt_count: 0,
        attempted_at: attemptedAt,
        next_attempt_at: nextAttemptAt,
        last_error: 'stale worker'
      })
    ).toBe(false);

    const retry = await marketDepthDb.getDueReconciliations(
      input.source,
      input.contract,
      input.collection_slug,
      nextAttemptAt
    );
    expect(retry[0]).toMatchObject({
      attempt_count: 1,
      last_error: 'provider timeout'
    });
    expect(
      await marketDepthDb.resolveReconciliation({
        id: retry[0].id,
        expected_attempt_count: 1,
        resolved_at: new Date('2026-09-10T02:05:01.000Z')
      })
    ).toBe(true);
    expect(
      await marketDepthDb.getDueReconciliations(
        input.source,
        input.contract,
        input.collection_slug,
        new Date('2026-09-10T03:00:00.000Z')
      )
    ).toEqual([]);
  });
});
