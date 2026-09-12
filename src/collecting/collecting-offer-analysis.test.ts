import * as fc from 'fast-check';
import { allocateCollectOffers } from '@/collecting/collecting-offer-analysis';
import {
  offerAnalysisSchema,
  OfferAnalysisRequest,
  OfferAssetSignals,
  OfferPriceReference
} from '@/collecting/collecting-offer-analysis.types';
import {
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';

const wallet = '0x1111111111111111111111111111111111111111';
function request(
  patch: Partial<OfferAnalysisRequest> = {}
): OfferAnalysisRequest {
  return {
    profile_id: 'profile',
    wallet,
    recipient: wallet,
    acknowledge_external_recipient: false,
    expires_at: 2000000000,
    assets: [{ asset_key: 'nft-a', quantity: '1' }],
    method: { kind: 'match_bid' },
    ...patch
  };
}
function reference(kind: 'bid' | 'ask', amount = '100'): OfferPriceReference {
  return {
    kind,
    order_hash: kind,
    protocol_address: wallet,
    maker: wallet,
    currency: MARKET_WETH,
    quantity: '1',
    unit_amount_wei: amount,
    total_amount_wei: amount,
    observed_at: 1,
    expires_at: 100000,
    source: 'OpenSea',
    eligibility: 'EXACT_TOKEN_TERMS',
    verification: 'OBSERVED_NOT_CHAIN_VERIFIED',
    funding: 'UNKNOWN'
  };
}
function signals(keys = ['nft-a'], patch: Partial<OfferAssetSignals> = {}) {
  return new Map(
    keys.map((key) => [
      key,
      {
        asset_key: key,
        standard: 'ERC1155' as const,
        bid: reference('bid'),
        ask: reference('ask', '200'),
        distinct_ask_makers: 3,
        distinct_bid_makers: 2,
        coverage_complete: true,
        reason_codes: [],
        ...patch
      }
    ])
  );
}

describe('per-NFT offer pricing', () => {
  it('requires a manual amount on every NFT and rejects duplicate assets and invalid method parameters', () => {
    expect(
      offerAnalysisSchema.safeParse(
        request({ method: { kind: 'manual' }, max_total_weth_wei: '100' })
      ).success
    ).toBe(false);
    expect(
      offerAnalysisSchema.safeParse(request({ method: { kind: 'goal' } }))
        .success
    ).toBe(false);
    for (const method of [
      { kind: 'improve_bid' },
      { kind: 'discount_ask', basis_points: 10000 },
      { kind: 'match_bid', basis_points: 1 },
      { kind: 'improve_bid', basis_points: 0.5 }
    ] as OfferAnalysisRequest['method'][]) {
      expect(offerAnalysisSchema.safeParse(request({ method })).success).toBe(
        false
      );
    }
    expect(
      offerAnalysisSchema.safeParse(
        request({
          assets: [
            { asset_key: 'NFT-A', quantity: '1' },
            { asset_key: 'nft-a', quantity: '2' }
          ]
        })
      ).success
    ).toBe(false);
    expect(
      offerAnalysisSchema.safeParse(
        request({ assets: [{ asset_key: 'a', quantity: '0' }] })
      ).success
    ).toBe(false);
    expect(
      offerAnalysisSchema.safeParse(
        request({ method: { kind: 'improve_bid', basis_points: 100000 } })
      ).success
    ).toBe(true);
  });

  it('passes the full quantity total into the existing offer preparation proposal', () => {
    const result = allocateCollectOffers(
      request({
        assets: [
          { asset_key: 'nft-a', quantity: '3', manual_unit_amount_wei: '101' }
        ],
        method: { kind: 'manual' }
      }),
      signals(),
      BigInt(1000)
    );
    expect(result.rows[0]).toMatchObject({
      pinned: true,
      selected: true,
      unit_amount_wei: '101',
      total_amount_wei: '303',
      prepare_request: {
        kind: 'OFFER',
        quantity: '3',
        amount_wei: '303',
        currency: MARKET_WETH
      }
    });
    expect(result.proposed_weth_wei).toBe('303');
    expect(result.rows[0]).not.toHaveProperty('signedOrder');
  });

  it('rounds positive bid improvements upward and ask discounts downward using wei arithmetic', () => {
    const improved = allocateCollectOffers(
      request({ method: { kind: 'improve_bid', basis_points: 1 } }),
      signals(),
      BigInt(1000)
    );
    expect(improved.rows[0].unit_amount_wei).toBe('101');
    const discounted = allocateCollectOffers(
      request({ method: { kind: 'discount_ask', basis_points: 3333 } }),
      signals(undefined, {
        ask: { ...reference('ask', '101'), currency: MARKET_ZERO_ADDRESS }
      }),
      BigInt(1000)
    );
    expect(discounted.rows[0].unit_amount_wei).toBe('67');
    expect(discounted.rows[0].reason_codes).toContain(
      'ETH_ASK_WETH_COMPARISON'
    );
  });

  it('leaves missing quotes unresolved rather than inventing zero prices', () => {
    const result = allocateCollectOffers(
      request(),
      signals(undefined, {
        bid: undefined,
        reason_codes: ['STALE_MARKET_DATA']
      }),
      BigInt(1000)
    );
    expect(result.rows[0]).toMatchObject({
      status: 'UNAVAILABLE',
      selected: false
    });
    expect(result.rows[0].unit_amount_wei).toBeUndefined();
    expect(result.rows[0].reason_codes).toEqual([
      'STALE_MARKET_DATA',
      'NO_APPLICABLE_BID'
    ]);
  });

  it('keeps formula and manual amounts unchanged when the complete group exceeds capacity', () => {
    for (const method of ['match_bid', 'manual'] as const) {
      const result = allocateCollectOffers(
        request({
          assets: ['nft-a', 'nft-b'].map((key) => ({
            asset_key: key,
            quantity: '2',
            ...(method === 'manual' ? { manual_unit_amount_wei: '100' } : {})
          })),
          method: { kind: method },
          max_total_weth_wei: '300'
        }),
        signals(['nft-a', 'nft-b']),
        BigInt(1000)
      );
      expect(result.rows.map((row) => row.total_amount_wei)).toEqual([
        '200',
        '200'
      ]);
      expect(
        result.rows.every(
          (row) => !row.selected && row.prepare_request === undefined
        )
      ).toBe(true);
      expect(result.proposed_weth_wei).toBe('0');
    }
  });

  it('excludes unsupported ERC721 quantities and overflows', () => {
    const maximum = ((BigInt(1) << BigInt(256)) - BigInt(1)).toString();
    const overflow = allocateCollectOffers(
      request({
        assets: [
          { asset_key: 'nft-a', quantity: '2', manual_unit_amount_wei: maximum }
        ],
        method: { kind: 'manual' }
      }),
      signals(),
      BigInt(maximum)
    );
    expect(overflow.rows[0].reason_codes).toContain('AMOUNT_OVERFLOW');
    const unique = allocateCollectOffers(
      request({ assets: [{ asset_key: 'nft-a', quantity: '2' }] }),
      signals(undefined, { standard: 'ERC721' }),
      BigInt(1000)
    );
    expect(unique.rows[0].reason_codes).toContain('UNSUPPORTED_ASSET');
  });
});

describe('conservative group allocation', () => {
  it('bounds goal allocations and every partial-fill subset while preserving pinned prices', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ask: fc.integer({ min: 100, max: 100000 }),
            quantity: fc.integer({ min: 1, max: 100 }),
            pin: fc.boolean(),
            fill: fc.boolean()
          }),
          { minLength: 1, maxLength: 20 }
        ),
        fc.integer({ min: 1, max: 1000000 }),
        fc.integer({ min: 0, max: 1000000 }),
        (items, budget, balance) => {
          const input = request({
            method: { kind: 'goal' },
            max_total_weth_wei: String(budget),
            assets: items.map((item, index) => ({
              asset_key: `nft-${index}`,
              quantity: String(item.quantity),
              ...(item.pin ? { manual_unit_amount_wei: String(item.ask) } : {})
            }))
          });
          const book = signals(input.assets.map((item) => item.asset_key));
          items.forEach((item, index) => {
            book.get(`nft-${index}`)!.ask = reference('ask', String(item.ask));
          });
          const result = allocateCollectOffers(input, book, BigInt(balance));
          const total = BigInt(result.proposed_weth_wei);
          expect(total).toBeLessThanOrEqual(BigInt(Math.min(budget, balance)));
          let partial = BigInt(0);
          result.rows.forEach((row, index) => {
            if (items[index].pin)
              expect(row.unit_amount_wei).toBe(String(items[index].ask));
            expect(row.quantity).toBe(String(items[index].quantity));
            if (row.selected && items[index].fill)
              partial += BigInt(row.total_amount_wei!);
          });
          expect(partial).toBeLessThanOrEqual(total);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('keeps pins and chooses the largest affordable count at fixed supported openings, leaving spare capacity', () => {
    const input = request({
      method: { kind: 'goal' },
      max_total_weth_wei: '200',
      assets: [
        { asset_key: 'nft-a', quantity: '1', manual_unit_amount_wei: '20' },
        { asset_key: 'nft-b', quantity: '1' },
        { asset_key: 'nft-c', quantity: '2' }
      ]
    });
    const result = allocateCollectOffers(
      input,
      signals(['nft-a', 'nft-b', 'nft-c']),
      BigInt(1000)
    );
    expect(
      result.rows.filter((row) => row.selected).map((row) => row.asset_key)
    ).toEqual(['nft-a', 'nft-b']);
    expect(result.rows[0].unit_amount_wei).toBe('20');
    expect(result.rows[1].unit_amount_wei).toBe('140');
    expect(result.proposed_weth_wei).toBe('160');
    expect(result.unallocated_weth_wei).toBe('40');
    const reverse = allocateCollectOffers(
      { ...input, assets: [...input.assets].reverse() },
      signals(['nft-a', 'nft-b', 'nft-c']),
      BigInt(1000)
    );
    expect(
      reverse.rows
        .filter((row) => row.selected)
        .map((row) => row.asset_key)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(['nft-a', 'nft-b']);
  });

  it('does not drop an over-budget pin or fabricate unique-art / thin-book goal valuations', () => {
    const pin = allocateCollectOffers(
      request({
        method: { kind: 'goal' },
        max_total_weth_wei: '50',
        assets: [
          { asset_key: 'nft-a', quantity: '1', manual_unit_amount_wei: '100' }
        ]
      }),
      signals(),
      BigInt(1000)
    );
    expect(pin.rows[0]).toMatchObject({
      status: 'PIN_CONFLICT',
      unit_amount_wei: '100',
      selected: false
    });
    for (const patch of [
      { standard: 'ERC721' as const },
      { distinct_ask_makers: 2 },
      { coverage_complete: false }
    ]) {
      const result = allocateCollectOffers(
        request({ method: { kind: 'goal' }, max_total_weth_wei: '1000' }),
        signals(undefined, patch),
        BigInt(1000)
      );
      expect(result.rows[0].reason_codes).toContain(
        'INSUFFICIENT_GOAL_EVIDENCE'
      );
      expect(result.proposed_weth_wei).toBe('0');
    }
  });

  it('keeps every reachable partial acceptance within the group budget and available balance', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            unit: fc.bigInt({
              min: BigInt(1),
              max: BigInt('1000000000000000000000000')
            }),
            quantity: fc.integer({ min: 1, max: 100 }),
            fill: fc.boolean()
          }),
          { minLength: 1, maxLength: 20 }
        ),
        fc.bigInt({
          min: BigInt(0),
          max: BigInt('10000000000000000000000000')
        }),
        (items, capacity) => {
          const input = request({
            method: { kind: 'manual' },
            assets: items.map((item, index) => ({
              asset_key: `nft-${index}`,
              quantity: String(item.quantity),
              manual_unit_amount_wei: String(item.unit)
            }))
          });
          const result = allocateCollectOffers(
            input,
            signals(input.assets.map((asset) => asset.asset_key)),
            capacity
          );
          const total = BigInt(result.proposed_weth_wei);
          const partial = result.rows.reduce(
            (sum, row, index) =>
              sum +
              (row.selected && items[index].fill
                ? BigInt(row.total_amount_wei!)
                : BigInt(0)),
            BigInt(0)
          );
          expect(total).toBeLessThanOrEqual(capacity);
          expect(partial).toBeLessThanOrEqual(total);
          result.rows.forEach((row, index) =>
            expect(row.total_amount_wei).toBe(
              String(items[index].unit * BigInt(items[index].quantity))
            )
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
