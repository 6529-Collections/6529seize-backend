import { CollectingAsset } from '@/collecting/collecting.types';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot
} from '@/market-depth/market-depth.types';
import { describeIndexedMarketOrder } from '@/marketplace/provider.opensea';
import { MarketValidationError } from '@/marketplace/provider.types';
import {
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import {
  OFFER_ANALYSIS_FRESH_MILLIS,
  OfferAnalysisRequest,
  OfferAssetSignals,
  OfferPriceReference
} from '@/collecting/collecting-offer-analysis.types';

function applicableReference(
  order: CurrentMarketDepthOrder,
  asset: CollectingAsset,
  quantity: string,
  excludedMakers: Set<string>,
  observedAt: number,
  now: number
): OfferPriceReference | undefined {
  if (
    order.source !== 'opensea' ||
    order.status !== 'ACTIVE' ||
    order.is_private ||
    order.scope !== 'token' ||
    order.is_executable !== true ||
    order.token_id !== asset.token_id ||
    order.contract.toLowerCase() !== asset.contract.toLowerCase() ||
    !order.maker ||
    excludedMakers.has(order.maker.toLowerCase()) ||
    order.currency_decimals !== 18 ||
    (order.side === 'bid'
      ? order.currency_contract !== MARKET_WETH
      : ![MARKET_WETH, MARKET_ZERO_ADDRESS].includes(
          order.currency_contract ?? ''
        ))
  )
    return undefined;
  try {
    if (BigInt(order.remaining_quantity) < BigInt(quantity)) return undefined;
    const described = describeIndexedMarketOrder(
      order.source_data,
      {
        contract: asset.contract,
        tokenId: asset.token_id,
        standard: asset.family === 'memes' ? 'ERC1155' : 'ERC721'
      },
      order.side === 'bid' ? 'OFFER' : 'LISTING',
      quantity
    );
    const total = BigInt(described.totalWei),
      units = BigInt(quantity);
    const expiry = Number(described.endTime) * 1000;
    if (
      described.identity.orderHash.toLowerCase() !==
        order.order_id.toLowerCase() ||
      described.maker.toLowerCase() !== order.maker.toLowerCase() ||
      described.currency !== order.currency_contract ||
      Number(described.startTime) * 1000 > now ||
      expiry <= now ||
      total <= BigInt(0) ||
      total % units !== BigInt(0)
    )
      return undefined;
    return {
      kind: order.side,
      order_hash: described.identity.orderHash,
      protocol_address: described.identity.protocolAddress,
      maker: described.maker.toLowerCase(),
      currency: described.currency,
      quantity,
      unit_amount_wei: (total / units).toString(),
      total_amount_wei: total.toString(),
      observed_at: observedAt,
      expires_at: expiry,
      source: 'OpenSea',
      eligibility: 'EXACT_TOKEN_TERMS',
      verification: 'OBSERVED_NOT_CHAIN_VERIFIED',
      funding: 'UNKNOWN'
    };
  } catch (error) {
    if (error instanceof MarketValidationError || error instanceof SyntaxError)
      return undefined;
    throw error;
  }
}

function preferReference(
  candidate: OfferPriceReference,
  prior?: OfferPriceReference
): boolean {
  if (!prior) return true;
  const a = BigInt(candidate.unit_amount_wei),
    b = BigInt(prior.unit_amount_wei);
  if (a === b) return candidate.order_hash.localeCompare(prior.order_hash) < 0;
  return candidate.kind === 'bid' ? a > b : a < b;
}

function initialSignals(
  catalog: Map<string, CollectingAsset>,
  books: CurrentMarketDepthSnapshot[]
) {
  const signals = new Map<string, OfferAssetSignals>();
  for (const asset of Array.from(catalog.values())) {
    const familyBooks = books.filter(
      (book) =>
        book.snapshot.contract.toLowerCase() === asset.contract.toLowerCase()
    );
    signals.set(asset.asset_key, {
      asset_key: asset.asset_key,
      standard: asset.family === 'memes' ? 'ERC1155' : 'ERC721',
      distinct_ask_makers: 0,
      distinct_bid_makers: 0,
      coverage_complete:
        familyBooks.length > 0 &&
        familyBooks.every(
          (book) => book.orders.length === book.snapshot.order_count
        ),
      reason_codes: familyBooks.length ? [] : ['NO_MARKET_DATA']
    });
  }
  return signals;
}

interface SignalRead {
  budget: CollectingWorkBudget;
  requested: Map<string, string>;
  catalog: Map<string, CollectingAsset>;
  signals: Map<string, OfferAssetSignals>;
  makers: Record<'ask' | 'bid', Map<string, Set<string>>>;
  excludedMakers: Set<string>;
  now: number;
  evaluated: number;
  applicable: number;
}

function markStale(signal: OfferAssetSignals): void {
  signal.coverage_complete = false;
  if (!signal.reason_codes.includes('STALE_MARKET_DATA'))
    signal.reason_codes.push('STALE_MARKET_DATA');
}

function freshObservation(times: number[], now: number): boolean {
  return (
    times.every((time) => Number.isFinite(time) && time <= now) &&
    now - Math.min(...times) < OFFER_ANALYSIS_FRESH_MILLIS
  );
}

function readOrder(
  read: SignalRead,
  order: CurrentMarketDepthOrder,
  snapshotTime: number
): void {
  read.budget.assertAvailable();
  read.evaluated++;
  const key = `1:${order.contract.toLowerCase()}:${order.token_id}`;
  const asset = read.catalog.get(key),
    signal = read.signals.get(key),
    quantity = read.requested.get(key);
  if (!asset || !signal || !quantity) return;
  const times = [snapshotTime, order.observed_at.getTime()];
  if (!freshObservation(times, read.now)) {
    markStale(signal);
    return;
  }
  const reference = applicableReference(
    order,
    asset,
    quantity,
    read.excludedMakers,
    Math.min(...times),
    read.now
  );
  if (!reference) return;
  read.applicable++;
  read.makers[reference.kind].get(key)!.add(reference.maker);
  if (preferReference(reference, signal[reference.kind]))
    signal[reference.kind] = reference;
}

function readBook(read: SignalRead, book: CurrentMarketDepthSnapshot): void {
  const times = [
    book.snapshot.started_at.getTime(),
    book.snapshot.completed_at.getTime()
  ];
  if (!freshObservation(times, read.now)) {
    for (const asset of Array.from(read.catalog.values()))
      if (asset.contract.toLowerCase() === book.snapshot.contract.toLowerCase())
        markStale(read.signals.get(asset.asset_key)!);
    return;
  }
  book.orders.forEach((order) => readOrder(read, order, Math.min(...times)));
}

/** Applicability of indexed terms is distinct from live funding or fulfillment. */
export function collectOfferSignals(
  request: OfferAnalysisRequest,
  assets: CollectingAsset[],
  books: CurrentMarketDepthSnapshot[],
  wallets: string[],
  now: number,
  budget = new CollectingWorkBudget(8000)
) {
  budget.assertAvailable();
  const requested = new Map(
    request.assets.map((asset) => [
      asset.asset_key.toLowerCase(),
      asset.quantity
    ])
  );
  const catalog = new Map(
    assets
      .filter((asset) => requested.has(asset.asset_key))
      .map((asset) => [asset.asset_key, asset])
  );
  const signals = initialSignals(catalog, books);
  const makersFor = () =>
    new Map(Array.from(catalog.keys(), (key) => [key, new Set<string>()]));
  const read: SignalRead = {
    budget,
    requested,
    catalog,
    signals,
    now,
    excludedMakers: new Set(
      [...wallets, request.wallet].map((wallet) => wallet.toLowerCase())
    ),
    makers: { ask: makersFor(), bid: makersFor() },
    evaluated: 0,
    applicable: 0
  };
  books.forEach((book) => readBook(read, book));
  for (const [key, signal] of Array.from(signals.entries())) {
    signal.distinct_ask_makers = read.makers.ask.get(key)!.size;
    signal.distinct_bid_makers = read.makers.bid.get(key)!.size;
  }
  budget.assertAvailable();
  return {
    signals,
    evaluated_order_count: read.evaluated,
    applicable_order_count: read.applicable
  };
}
