import {
  normalizeOpenSeaEvent,
  normalizeOpenSeaOrder,
  openSeaLifecycleEventId
} from './opensea-normalizer';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const PROTOCOL = '0x2222222222222222222222222222222222222222';
const MAKER = '0x3333333333333333333333333333333333333333';
const WETH = '0x4444444444444444444444444444444444444444';
const OBSERVED_AT = new Date('2026-09-10T12:00:00.000Z');

function offer(overrides: Record<string, unknown> = {}) {
  return {
    order_hash: `0x${'a'.repeat(64)}`,
    chain: 'ethereum',
    protocol_address: PROTOCOL,
    status: 'ACTIVE',
    remaining_quantity: '1',
    price: { currency: 'WETH', decimals: 18, value: '240000000000000000' },
    protocol_data: {
      parameters: {
        offerer: MAKER,
        startTime: '1789040000',
        endTime: '1789050000',
        orderType: 1,
        offer: [
          { itemType: 1, token: WETH, startAmount: '240000000000000000' }
        ],
        consideration: [
          {
            itemType: 3,
            token: CONTRACT,
            identifierOrCriteria: '123456789012345678901234567890',
            startAmount: '4'
          }
        ]
      }
    },
    ...overrides
  };
}

describe('normalizeOpenSeaOrder', () => {
  it('keeps exact partial-fill quantities and derives price from original quantity', () => {
    const result = normalizeOpenSeaOrder(offer(), {
      side: 'bid',
      contract: CONTRACT,
      collectionSlug: 'fixture',
      observedAt: OBSERVED_AT
    });

    expect(result.unsupported).toBe(false);
    expect(result.order).toMatchObject({
      token_id: '123456789012345678901234567890',
      original_quantity: '4',
      remaining_quantity: '1',
      current_price_raw: '240000000000000000',
      current_price_decimal: '0.24',
      unit_price_decimal: '0.06',
      currency_contract: WETH,
      status: 'ACTIVE',
      is_private: false,
      is_executable: true
    });
  });

  it('preserves collection criteria and excludes private orders from executable depth', () => {
    const raw = offer({
      is_private: true,
      criteria: {
        collection: { slug: 'fixture' },
        encoded_token_ids: '10000000000:19999999999',
        traits: []
      },
      protocol_data: {
        parameters: {
          ...offer().protocol_data.parameters,
          consideration: [
            {
              itemType: 5,
              token: CONTRACT,
              identifierOrCriteria: '999',
              startAmount: '1'
            }
          ]
        }
      }
    });
    const result = normalizeOpenSeaOrder(raw, {
      side: 'bid',
      contract: CONTRACT,
      collectionSlug: 'fixture',
      observedAt: OBSERVED_AT
    });

    expect(result.order).toMatchObject({
      token_id: null,
      scope: 'trait',
      is_private: true,
      is_executable: false,
      criteria: { encoded_token_ids: '10000000000:19999999999' }
    });
  });

  it('retains identified unsupported orders with raw source evidence', () => {
    const raw = offer({
      price: { currency: 'WETH', decimals: 18, value: 0.1 }
    });
    const result = normalizeOpenSeaOrder(raw, {
      side: 'bid',
      contract: CONTRACT,
      collectionSlug: 'fixture',
      observedAt: OBSERVED_AT
    });

    expect(result.unsupported).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.order?.source_data).toEqual(raw);
    expect(result.order?.is_executable).toBe(false);
    expect(result.reasons).toContain('missing_exact_price');
  });

  it('uses the zero address as the exact native-currency key', () => {
    const raw = offer({
      price: { currency: 'ETH', decimals: 18, value: '100000000000000000' },
      protocol_data: {
        parameters: {
          ...offer().protocol_data.parameters,
          offer: [
            {
              itemType: 0,
              token: '0x0000000000000000000000000000000000000000',
              startAmount: '100000000000000000'
            }
          ]
        }
      }
    });
    const result = normalizeOpenSeaOrder(raw, {
      side: 'bid',
      contract: CONTRACT,
      collectionSlug: 'fixture',
      observedAt: OBSERVED_AT
    });
    expect(result.order?.currency_contract).toBe(
      '0x0000000000000000000000000000000000000000'
    );
  });

  it('preserves but excludes dynamic and bundled orders', () => {
    const raw = offer({
      protocol_data: {
        parameters: {
          ...offer().protocol_data.parameters,
          consideration: [
            {
              itemType: 3,
              token: CONTRACT,
              identifierOrCriteria: '42',
              startAmount: '4',
              endAmount: '3'
            },
            {
              itemType: 2,
              token: '0x5555555555555555555555555555555555555555',
              identifierOrCriteria: '7',
              startAmount: '1',
              endAmount: '1'
            }
          ]
        }
      }
    });
    const result = normalizeOpenSeaOrder(raw, {
      side: 'bid',
      contract: CONTRACT,
      collectionSlug: 'fixture',
      observedAt: OBSERVED_AT
    });

    expect(result.unsupported).toBe(true);
    expect(result.order?.is_executable).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['bundled_nft_items', 'dynamic_amount_order'])
    );
  });

  it('rejects currency decimal widths that cannot be represented safely', () => {
    const result = normalizeOpenSeaOrder(
      offer({ price: { currency: 'WETH', decimals: 256, value: '1' } }),
      {
        side: 'bid',
        contract: CONTRACT,
        collectionSlug: 'fixture',
        observedAt: OBSERVED_AT
      }
    );
    expect(result.unsupported).toBe(true);
    expect(result.order?.currency_decimals).toBeNull();
  });
});

describe('normalizeOpenSeaEvent', () => {
  it('uses the shared lifecycle tuple for deterministic REST/stream deduplication', () => {
    const event = normalizeOpenSeaEvent(
      {
        event_type: 'item_sold',
        event_timestamp: '2026-09-10T11:59:00.000Z',
        order_hash: `0x${'b'.repeat(64)}`,
        transaction: `0x${'c'.repeat(64)}`,
        nft: { identifier: '42' },
        maker: MAKER,
        taker: WETH,
        quantity: 1,
        payment: {
          quantity: '1000000',
          symbol: 'USDC',
          decimals: 6,
          address: WETH
        }
      },
      CONTRACT,
      'fixture',
      OBSERVED_AT
    );

    expect(event.kind).toBe('sale');
    expect(event.source_evidence).toBe('provider_event');
    expect(event.price_decimal).toBe('1');
    expect(event.event_id).toBe(
      openSeaLifecycleEventId({
        kind: 'sale',
        collectionSlug: 'fixture',
        orderId: `0x${'b'.repeat(64)}`,
        transactionHash: `0x${'c'.repeat(64)}`,
        tokenId: '42',
        providerAt: new Date('2026-09-10T11:59:00.000Z'),
        maker: MAKER,
        taker: WETH,
        quantity: '1'
      })
    );
  });

  it('deduplicates order lifecycle creation regardless of timestamp formatting', () => {
    const common = {
      kind: 'listing',
      collectionSlug: 'fixture',
      orderId: `0x${'d'.repeat(64)}`,
      protocolAddress: PROTOCOL
    };
    expect(
      openSeaLifecycleEventId({
        ...common,
        providerAt: new Date('2026-09-10T11:59:00.000Z')
      })
    ).toBe(
      openSeaLifecycleEventId({
        ...common,
        providerAt: new Date('2026-09-10T11:59:00.123Z')
      })
    );
  });

  it.each(['cancel', 'fulfilled', 'expiration'])(
    'keeps terminal %s IDs stable across absence episodes and observations',
    (kind) => {
      const common = {
        kind,
        collectionSlug: 'fixture',
        orderId: `0x${'d'.repeat(64)}`
      };
      expect(
        openSeaLifecycleEventId({
          ...common,
          providerAt: new Date('2026-09-10T11:59:00Z'),
          eventVersion: 'episode-1'
        })
      ).toBe(
        openSeaLifecycleEventId({
          ...common,
          providerAt: new Date('2026-09-10T12:01:00Z'),
          eventVersion: 'episode-2'
        })
      );
    }
  );

  it('deduplicates realistic REST and stream listing payloads when REST omits protocol', () => {
    const rest = normalizeOpenSeaEvent(
      {
        event_type: 'order',
        order_type: 'listing',
        event_timestamp: 1789041540,
        order_hash: `0x${'e'.repeat(64)}`,
        asset: { identifier: '42' },
        maker: MAKER,
        quantity: 1
      },
      CONTRACT,
      'fixture',
      OBSERVED_AT
    );
    const stream = normalizeOpenSeaEvent(
      {
        event_type: 'item_listed',
        event_timestamp: '2026-09-10T11:59:00.123Z',
        order_hash: `0x${'e'.repeat(64)}`,
        protocol_address: PROTOCOL,
        nft: { identifier: '42' },
        maker: MAKER,
        quantity: '1'
      },
      CONTRACT,
      'fixture',
      OBSERVED_AT
    );
    expect(rest.event_id).toBe(stream.event_id);
  });

  it.each([
    ['listing', 'item_listed', 'listing', '42'],
    ['item_offer', 'item_received_bid', 'offer', '42'],
    ['collection_offer', 'collection_offer', 'collection_offer', null],
    ['trait_offer', 'trait_offer', 'trait_offer', null]
  ])(
    'resolves REST order subtype %s before assigning its lifecycle ID',
    (orderType, streamType, kind, tokenId) => {
      const common = {
        order_hash: `0x${'f'.repeat(64)}`,
        maker: MAKER,
        quantity: 1
      };
      const restRaw = {
        ...common,
        event_type: 'order',
        order_type: orderType,
        event_timestamp: 1789041540,
        asset: tokenId ? { identifier: tokenId } : undefined
      };
      const rest = normalizeOpenSeaEvent(
        restRaw,
        CONTRACT,
        'fixture',
        OBSERVED_AT
      );
      const stream = normalizeOpenSeaEvent(
        {
          ...common,
          event_type: streamType,
          event_timestamp: '2026-09-10T11:59:00.123Z',
          protocol_address: PROTOCOL,
          nft: tokenId ? { identifier: tokenId } : undefined
        },
        CONTRACT,
        'fixture',
        OBSERVED_AT
      );
      expect(rest.kind).toBe(kind);
      expect(rest.token_id).toBe(tokenId);
      expect(rest.event_id).toBe(stream.event_id);
      expect(rest.raw).toMatchObject({
        event_type: 'order',
        order_type: orderType
      });
    }
  );

  it('retains unknown REST order subtypes without inventing an action', () => {
    const event = normalizeOpenSeaEvent(
      { event_type: 'order', order_type: 'future_type' },
      CONTRACT,
      'fixture',
      OBSERVED_AT
    );
    expect(event.kind).toBe('order');
    expect(event.raw).toEqual({
      event_type: 'order',
      order_type: 'future_type'
    });
  });
});
