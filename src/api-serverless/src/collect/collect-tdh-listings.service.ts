import { createHash } from 'node:crypto';
import { z } from 'zod';
import { collectingService } from '@/collecting/collecting.service';
import {
  CollectingAsset,
  CollectingFamily
} from '@/collecting/collecting.types';
import { marketDepthApiDb } from '@/api/market-depth/market-depth-api.db';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot
} from '@/market-depth/market-depth.types';
import { describeIndexedMarketListing } from '@/marketplace/provider.opensea';
import { MarketValidationError } from '@/marketplace/provider.types';
import {
  MARKET_ASSET_STANDARDS,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { discoveredOrderDto } from '@/api/marketplace/marketplace.dto';
import { ApiCollectFamily } from '@/api/generated/models/ApiCollectFamily';
import { ApiCollectTdhListing } from '@/api/generated/models/ApiCollectTdhListing';
import {
  ApiCollectTdhListings,
  ApiCollectTdhListingsStatusEnum
} from '@/api/generated/models/ApiCollectTdhListings';
import {
  decodeMarketCursor,
  encodeMarketCursor
} from '@/api/market-depth/market-depth.validation';
import { CustomApiCompliantException } from '@/exceptions';
import { getRedisCacheKeyForPath, redisCached } from '@/redis';
import { Time } from '@/time';

const MAX_INDEXED_ASKS = 10000;
const FRESH_MILLIS = 3600000;
type RankedSnapshot = Omit<ApiCollectTdhListings, 'next'>;
const pendingSnapshots = new Map<CollectingFamily, Promise<RankedSnapshot>>();

/** Production TDH accrual rounds the indexed per-copy rate to hundredths. */
export function baseTdhRateHundredths(rate: number | null): bigint | null {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null;
  const hundredths = Math.round(rate * 100);
  return Number.isSafeInteger(hundredths) && hundredths > 0
    ? BigInt(hundredths)
    : null;
}

/** Compare wei per full held day's base TDH without converting wei to Number. */
export function compareTdhListings(
  a: ApiCollectTdhListing,
  b: ApiCollectTdhListing
): number {
  const left =
    BigInt(a.purchase_cost_wei) * BigInt(b.base_tdh_per_day_hundredths);
  const right =
    BigInt(b.purchase_cost_wei) * BigInt(a.base_tdh_per_day_hundredths);
  if (left !== right) return left < right ? -1 : 1;
  const costA = BigInt(a.purchase_cost_wei),
    costB = BigInt(b.purchase_cost_wei);
  if (costA !== costB) return costA < costB ? -1 : 1;
  return (
    a.asset.asset_key.localeCompare(b.asset.asset_key) ||
    a.order.identity.order_hash.localeCompare(b.order.identity.order_hash)
  );
}

function listingForAsset(
  indexed: CurrentMarketDepthOrder,
  asset: CollectingAsset,
  now: number
): ApiCollectTdhListing | null {
  const rate = baseTdhRateHundredths(asset.hodl_rate);
  if (
    !asset.tdh_eligible ||
    rate === null ||
    indexed.side !== 'ask' ||
    indexed.status !== 'ACTIVE' ||
    indexed.is_private ||
    indexed.scope !== 'token' ||
    indexed.is_executable !== true ||
    indexed.currency_contract !== MARKET_ZERO_ADDRESS ||
    indexed.currency_decimals !== 18 ||
    indexed.source !== 'opensea' ||
    indexed.contract.toLowerCase() !== asset.contract.toLowerCase()
  )
    return null;
  const standard = MARKET_ASSET_STANDARDS[asset.contract.toLowerCase()];
  if (!standard) return null;
  try {
    const order = describeIndexedMarketListing(
      indexed.source_data,
      {
        contract: asset.contract.toLowerCase(),
        tokenId: asset.token_id,
        standard
      },
      indexed.remaining_quantity
    );
    if (
      order.identity.orderHash.toLowerCase() !==
        indexed.order_id.toLowerCase() ||
      order.currency !== MARKET_ZERO_ADDRESS ||
      Number(order.startTime) * 1000 > now ||
      Number(order.endTime) * 1000 <= now ||
      BigInt(order.totalWei) <= BigInt(0)
    )
      return null;
    const quantity = BigInt(order.quantity);
    return {
      asset: { ...asset, family: asset.family as ApiCollectFamily },
      order: discoveredOrderDto(order, asset.asset_key),
      available_quantity: indexed.remaining_quantity,
      purchase_quantity: order.quantity,
      purchase_cost_wei: order.totalWei,
      rate_hundredths: rate.toString(),
      base_tdh_per_day_hundredths: (rate * quantity).toString()
    };
  } catch (error) {
    if (!(error instanceof MarketValidationError)) throw error;
    return null;
  }
}

export function rankIndexedTdhListings(
  family: CollectingFamily,
  catalogVersion: string,
  assets: CollectingAsset[],
  books: CurrentMarketDepthSnapshot[],
  now = Date.now()
): RankedSnapshot {
  const byId = new Map(assets.map((asset) => [asset.token_id, asset]));
  const bestByAsset = new Map<string, ApiCollectTdhListing>();
  let evaluated = 0;
  for (const book of books) {
    for (const indexed of book.orders.slice(0, MAX_INDEXED_ASKS - evaluated)) {
      evaluated++;
      const asset =
        indexed.token_id === null ? undefined : byId.get(indexed.token_id);
      const listing = asset ? listingForAsset(indexed, asset, now) : null;
      if (!listing) continue;
      const prior = bestByAsset.get(listing.asset.asset_key);
      if (!prior || compareTdhListings(listing, prior) < 0)
        bestByAsset.set(listing.asset.asset_key, listing);
    }
  }
  const entries = Array.from(bestByAsset.values()).sort(compareTdhListings);
  const oldest = books.length
    ? Math.min(...books.map((book) => book.snapshot.completed_at.getTime()))
    : null;
  const observedAt = oldest === null ? null : new Date(oldest).toISOString();
  const indexedAskCount = books.reduce(
    (sum, book) => sum + book.snapshot.ask_count,
    0
  );
  const snapshotId = createHash('sha256')
    .update(
      JSON.stringify({
        family,
        catalogVersion,
        books: books
          .map((book) => book.snapshot.id)
          .sort((a, b) => a.localeCompare(b)),
        entries
      })
    )
    .digest('hex');
  return {
    entries,
    family: family as ApiCollectFamily,
    snapshot_id: snapshotId,
    catalog_version: catalogVersion,
    observed_at: observedAt,
    status:
      oldest === null
        ? ApiCollectTdhListingsStatusEnum.Unavailable
        : now - oldest > FRESH_MILLIS
          ? ApiCollectTdhListingsStatusEnum.Stale
          : ApiCollectTdhListingsStatusEnum.Fresh,
    indexed_ask_count: indexedAskCount,
    evaluated_ask_count: evaluated,
    ranked_nft_count: entries.length,
    coverage_complete:
      books.length > 0 &&
      indexedAskCount <= MAX_INDEXED_ASKS &&
      books.every(
        (book) =>
          book.orders.length === book.snapshot.ask_count &&
          book.orders.length <= MAX_INDEXED_ASKS
      ),
    source: 'OpenSea indexed listings'
  };
}

async function buildSnapshot(
  family: CollectingFamily
): Promise<RankedSnapshot> {
  const catalog = await collectingService.getCatalog();
  const assets = catalog.assets.filter((asset) => asset.family === family);
  const contracts = new Set(
    assets.map((asset) => asset.contract.toLowerCase())
  );
  if (contracts.size > 1)
    throw new CustomApiCompliantException(
      503,
      'The collection catalog changed. Refresh before trying again.',
      'CATALOG_CHANGED'
    );
  if (assets.length === 0)
    return rankIndexedTdhListings(family, catalog.version, assets, []);
  const context = {
    contract: assets[0].contract.toLowerCase(),
    token_id: assets[0].token_id,
    collection_id: family === 'pebbles' ? 1 : null
  };
  const books = await marketDepthApiDb.getBooks(context, true);
  return rankIndexedTdhListings(family, catalog.version, assets, books);
}

function sharedSnapshot(family: CollectingFamily): Promise<RankedSnapshot> {
  const existing = pendingSnapshots.get(family);
  if (existing) return existing;
  const pending = buildSnapshot(family).finally(() =>
    pendingSnapshots.delete(family)
  );
  pendingSnapshots.set(family, pending);
  return pending;
}

export async function getCollectTdhListings(
  family: CollectingFamily,
  limit: number,
  cursor?: string
): Promise<ApiCollectTdhListings> {
  const snapshot = await redisCached(
    getRedisCacheKeyForPath(`collect/tdh-listings/v1/${family}`),
    Time.seconds(60),
    () => sharedSnapshot(family)
  );
  let offset = 0;
  if (cursor) {
    const value = z
      .object({
        family: z.literal(family),
        snapshot_id: z.literal(snapshot.snapshot_id),
        offset: z.number().int().min(0).max(MAX_INDEXED_ASKS)
      })
      .strict()
      .safeParse(decodeMarketCursor(cursor));
    if (!value.success)
      throw new CustomApiCompliantException(
        409,
        'Listings changed. Refresh to see the latest order.',
        'LISTINGS_CHANGED'
      );
    offset = value.data.offset;
  }
  const now = Date.now();
  let end = offset;
  const entries: ApiCollectTdhListing[] = [];
  // Advance over expired cache entries without stranding an empty page before
  // later live listings. Cursor positions still refer to the bound snapshot.
  while (end < snapshot.entries.length && entries.length < limit) {
    const entry = snapshot.entries[end++];
    if (Number(entry.order.end_time) * 1000 > now) entries.push(entry);
  }
  return {
    ...snapshot,
    status:
      snapshot.observed_at === null
        ? ApiCollectTdhListingsStatusEnum.Unavailable
        : now - new Date(snapshot.observed_at).getTime() > FRESH_MILLIS
          ? ApiCollectTdhListingsStatusEnum.Stale
          : ApiCollectTdhListingsStatusEnum.Fresh,
    entries,
    next:
      end < snapshot.entries.length
        ? encodeMarketCursor({
            family,
            snapshot_id: snapshot.snapshot_id,
            offset: end
          })
        : null
  };
}
