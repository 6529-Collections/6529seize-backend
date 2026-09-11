import { randomUUID } from 'node:crypto';
import { ApiMarketDepthStatusEnum } from '@/api/generated/models/ApiMarketDepth';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot
} from '@/market-depth/market-depth.types';
import {
  buildMarketDepthResponse,
  encodedTokenSetContains
} from './market-depth.service';
import { applyOrderStatusObservation } from './market-depth-api.db';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const ETH = '0x0000000000000000000000000000000000000000';
const WETH = '0x2222222222222222222222222222222222222222';
const now = Date.parse('2026-09-10T12:00:00Z');

function order(
  patch: Partial<CurrentMarketDepthOrder> = {}
): CurrentMarketDepthOrder {
  return {
    order_key: randomUUID(),
    order_id: randomUUID(),
    source: 'opensea',
    protocol: CONTRACT,
    contract: CONTRACT,
    collection_slug: 'collection',
    token_id: '8',
    side: 'ask',
    scope: 'token',
    status: 'ACTIVE',
    is_private: false,
    maker: CONTRACT,
    original_quantity: '4',
    remaining_quantity: '1',
    currency_contract: ETH,
    currency_symbol: 'ETH',
    currency_decimals: 18,
    current_price_raw: '120000000000000000',
    current_price_decimal: '0.12',
    unit_price_decimal: '0.03',
    start_at: new Date(now - 3600000),
    end_at: new Date(now + 3600000),
    observed_at: new Date(now),
    source_url: null,
    criteria: null,
    protocol_data: null,
    source_data: null,
    is_executable: true,
    executable_caveats: [],
    snapshot_id: 'snapshot-1',
    chain: 'ethereum',
    chain_id: '1',
    ...patch
  };
}

function snapshot(
  orders: CurrentMarketDepthOrder[]
): CurrentMarketDepthSnapshot {
  return {
    snapshot: {
      id: 'snapshot-1',
      chain: 'ethereum',
      chain_id: '1',
      contract: CONTRACT,
      collection_slug: 'collection',
      collection_id: null,
      source: 'opensea',
      schema_version: 1,
      normalizer_version: '1',
      started_at: new Date(now - 60000),
      completed_at: new Date(now),
      raw_order_count: orders.length,
      order_count: orders.length,
      ask_count: orders.length,
      bid_count: 0,
      unsupported_count: 0,
      skipped_count: 0,
      event_count: 0
    },
    orders
  };
}

describe('market depth projections', () => {
  it('uses remaining quantities at the stored unit price after a partial fill', () => {
    const result = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [snapshot([order()])],
      50,
      undefined,
      now
    );
    expect(result.books[0].asks).toEqual([
      {
        unit_price: '0.03',
        quantity: '1',
        cumulative_quantity: '1',
        order_count: 1
      }
    ]);
  });

  it('does not combine different payment contracts or claim criteria liquidity', () => {
    const result = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [
        snapshot([
          order(),
          order({
            side: 'bid',
            currency_contract: WETH,
            currency_symbol: 'WETH',
            unit_price_decimal: '0.02'
          }),
          order({
            side: 'bid',
            scope: 'trait',
            token_id: null,
            unit_price_decimal: '99'
          })
        ])
      ],
      50,
      undefined,
      now
    );
    expect(result.books).toHaveLength(2);
    expect(result.books[0].bids).toEqual([]);
    expect(result.books[1].bids[0].unit_price).toBe('0.02');
    expect(result.criteria_order_count).toBe(1);
  });

  it('omits private, ended, inactive and other-token orders', () => {
    const result = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [
        snapshot([
          order({ is_private: true }),
          order({ end_at: new Date(now) }),
          order({ status: 'CANCELLED' }),
          order({ token_id: '9' })
        ])
      ],
      50,
      undefined,
      now
    );
    expect(result.orders).toEqual([]);
    expect(result.status).toBe(ApiMarketDepthStatusEnum.Fresh);
  });

  it('keeps exact large quantities and does not duplicate the same order', () => {
    const large =
      '999999999999999999999999999999999999999999999999999999999999999999999999999';
    const entry = order({ remaining_quantity: large });
    const result = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [snapshot([entry, entry])],
      50,
      undefined,
      now
    );
    expect(result.order_count).toBe(1);
    expect(result.books[0].asks[0].quantity).toBe(large);
  });

  it('binds pagination to the same book and rejects replacement snapshots', () => {
    const book = snapshot([order(), order()]);
    const first = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [book],
      1,
      undefined,
      now
    );
    const second = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [book],
      1,
      first.next!,
      now + 1000
    );
    expect(second.orders[0].order_id).not.toBe(first.orders[0].order_id);
    expect(second.next).toBeNull();
    book.snapshot.id = 'replacement';
    expect(() =>
      buildMarketDepthResponse(
        CONTRACT,
        '8',
        [book],
        1,
        first.next!,
        now + 1000
      )
    ).toThrow('book changed');
  });

  it('distinguishes unavailable capture from a completed empty book and stale data', () => {
    expect(
      buildMarketDepthResponse(CONTRACT, '8', [], 50, undefined, now).status
    ).toBe('unavailable');
    expect(
      buildMarketDepthResponse(
        CONTRACT,
        '8',
        [snapshot([])],
        50,
        undefined,
        now
      ).status
    ).toBe('fresh');
    expect(
      buildMarketDepthResponse(
        CONTRACT,
        '8',
        [snapshot([])],
        50,
        undefined,
        now + 3600001
      ).status
    ).toBe('stale');
  });

  it('suppresses recorded cancellations and recent fills while keeping revalidation conservative', () => {
    const entry = order();
    const observation = {
      order_id: entry.order_id,
      kind: 'cancel',
      occurred_at: new Date(now + 1000)
    };
    expect(applyOrderStatusObservation(entry, observation).status).toBe(
      'CANCELLED'
    );
    expect(
      applyOrderStatusObservation(entry, { ...observation, kind: 'item_sold' })
        .status
    ).toBe('INACTIVE');
    expect(
      applyOrderStatusObservation(entry, {
        ...observation,
        occurred_at: new Date(now - 1000)
      }).status
    ).toBe('CANCELLED');
    expect(
      applyOrderStatusObservation(order({ status: 'INACTIVE' }), {
        ...observation,
        kind: 'revalidate'
      }).status
    ).toBe('INACTIVE');
  });

  it('invalidates order pagination when a live cancellation changes the quoted book', () => {
    const book = snapshot([order(), order()]);
    const first = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [book],
      1,
      undefined,
      now
    );
    book.orders[0].status = 'CANCELLED';
    expect(() =>
      buildMarketDepthResponse(
        CONTRACT,
        '8',
        [book],
        1,
        first.next!,
        now + 1000
      )
    ).toThrow('book changed');
  });

  it('suppresses cancellations and invalidations received during snapshot pagination', () => {
    const entry = order();
    const startedAt = new Date(now - 60_000);
    const observation = {
      order_id: entry.order_id,
      kind: 'cancel',
      occurred_at: new Date(now - 30_000)
    };
    expect(
      applyOrderStatusObservation(entry, observation, startedAt).status
    ).toBe('CANCELLED');
    expect(
      applyOrderStatusObservation(
        entry,
        { ...observation, kind: 'invalidate' },
        startedAt
      ).status
    ).toBe('INACTIVE');
  });

  it('suppresses provider inactive observations as mutable invalidations', () => {
    const entry = order();
    expect(
      applyOrderStatusObservation(entry, {
        order_id: entry.order_id,
        kind: 'inactive',
        occurred_at: new Date(now + 1000)
      }).status
    ).toBe('INACTIVE');
  });

  it('orders unknown prices after quoted prices with stable pagination', () => {
    const book = snapshot([
      order({ order_key: 'a', unit_price_decimal: '2' }),
      order({ order_key: 'b', unit_price_decimal: null }),
      order({ order_key: 'c', unit_price_decimal: '1' })
    ]);
    const first = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [book],
      2,
      undefined,
      now
    );
    expect(first.orders.map((entry) => entry.order_key)).toEqual(['c', 'a']);
    const next = buildMarketDepthResponse(
      CONTRACT,
      '8',
      [book],
      2,
      first.next!,
      now + 1000
    );
    expect(next.orders.map((entry) => entry.order_key)).toEqual(['b']);
  });

  it('allows a new complete ACTIVE refresh after an older mutable invalidation', () => {
    const entry = order();
    const observation = {
      order_id: entry.order_id,
      kind: 'invalidate',
      occurred_at: new Date(now - 60_000)
    };
    expect(
      applyOrderStatusObservation(entry, observation, new Date(now - 30_000))
    ).toBe(entry);
  });

  it.each(['cancel', 'fulfilled', 'expiration'])(
    'never revives the terminal %s state of the same order hash',
    (kind) => {
      const entry = order();
      expect(
        applyOrderStatusObservation(
          entry,
          {
            order_id: entry.order_id,
            kind,
            occurred_at: new Date(now - 120_000)
          },
          new Date(now - 60_000)
        ).status
      ).not.toBe('ACTIVE');
    }
  );
});

describe('exact criteria token sets', () => {
  it('checks uint256-size IDs and inclusive ranges without expanding them', () => {
    expect(
      encodedTokenSetContains(
        '9007199254740992:9007199254740994',
        '9007199254740993'
      )
    ).toBe(true);
    expect(
      encodedTokenSetContains(
        '9007199254740992,9007199254740994',
        '9007199254740993'
      )
    ).toBe(false);
    expect(encodedTokenSetContains('9:2', '4')).toBeNull();
    expect(encodedTokenSetContains('2:9,invalid', '4')).toBeNull();
  });
});
