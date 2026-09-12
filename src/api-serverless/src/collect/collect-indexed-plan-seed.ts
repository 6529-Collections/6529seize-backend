import { marketDepthApiDb } from '@/api/market-depth/market-depth-api.db';
import { CollectingCandidate } from '@/collecting/collecting-planner';
import { collectingService } from '@/collecting/collecting.service';
import {
  CollectingAnalysis,
  CollectingAsset
} from '@/collecting/collecting.types';
import { CustomApiCompliantException } from '@/exceptions';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot,
  MAX_MARKET_DEPTH_COLLECTION_ASKS
} from '@/market-depth/market-depth.types';
import { describeIndexedMarketListing } from '@/marketplace/provider.opensea';
import { MarketValidationError } from '@/marketplace/provider.types';
import {
  MARKET_ASSET_STANDARDS,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { marketUintSchema } from '@/marketplace/seaport.schema';
import {
  CollectingWorkBudget,
  CollectingWorkTimeout
} from '@/collecting/collecting-work-budget';

const FRESH_MILLIS = 3600000;
// Planner candidates and raw indexed asks have independent bounds: a complete
// book may contain many listings for the same NFT but at most 2,000 candidates.
const MAX_CANDIDATES = 2000;

export interface CollectIndexedPlanSeed {
  candidates: CollectingCandidate[];
  checked_asset_count: number;
  unavailable_asset_count: number;
  indexed_ask_count: number;
  source_snapshot_ids: string[];
  observed_at: string;
  source: 'OPENSEA_COMPLETE_INDEX';
}

function completeFreshBooks(books: CurrentMarketDepthSnapshot[], now: number) {
  return (
    books.length > 0 &&
    books.reduce((sum, book) => sum + book.orders.length, 0) <=
      MAX_MARKET_DEPTH_COLLECTION_ASKS &&
    books.every((book) => {
      const age = now - book.snapshot.completed_at.getTime();
      return (
        Number.isFinite(age) &&
        age >= 0 &&
        age < FRESH_MILLIS &&
        book.orders.length === book.snapshot.ask_count
      );
    })
  );
}

async function readFamilyBooks(assets: CollectingAsset[]) {
  const contracts = new Set(
    assets.map((asset) => asset.contract.toLowerCase())
  );
  // A catalog outside the supported one-contract-per-family model retains the
  // scanner; it must not turn an uncertain collection boundary into coverage.
  if (contracts.size !== 1) return [];
  const first = assets[0];
  try {
    return await marketDepthApiDb.getBooks(
      {
        contract: first.contract.toLowerCase(),
        token_id: first.token_id,
        collection_id: first.family === 'pebbles' ? 1 : null
      },
      true
    );
  } catch (error) {
    if (
      error instanceof CustomApiCompliantException &&
      error.getStatusCode() === 503
    )
      return [];
    throw error;
  }
}

function indexedCandidate(
  order: CurrentMarketDepthOrder,
  asset: CollectingAsset,
  wallets: Set<string>,
  gasReserve: string,
  validUntil: number,
  now: number
): CollectingCandidate | null {
  if (
    order.side !== 'ask' ||
    order.status !== 'ACTIVE' ||
    order.is_private ||
    order.scope !== 'token' ||
    order.is_executable !== true ||
    order.source !== 'opensea' ||
    order.currency_contract !== MARKET_ZERO_ADDRESS ||
    order.currency_decimals !== 18
  )
    return null;
  const standard = MARKET_ASSET_STANDARDS[asset.contract.toLowerCase()];
  if (!standard) return null;
  try {
    const unit = describeIndexedMarketListing(
      order.source_data,
      {
        contract: asset.contract.toLowerCase(),
        tokenId: asset.token_id,
        standard
      },
      order.remaining_quantity
    );
    // The existing cost planner represents independently divisible copies.
    // Preserve its supported scope; indivisible lots need a separate model.
    if (
      unit.quantity !== '1' ||
      unit.identity.orderHash.toLowerCase() !== order.order_id.toLowerCase() ||
      unit.currency !== MARKET_ZERO_ADDRESS ||
      wallets.has(unit.maker.toLowerCase()) ||
      Number(unit.startTime) * 1000 > now ||
      Number(unit.endTime) * 1000 <= now ||
      BigInt(unit.totalWei) <= BigInt(0)
    )
      return null;
    const available = BigInt(order.remaining_quantity);
    // Match the collecting planner's per-NFT quantity bound.
    const quantity = (
      available > BigInt(9999) ? BigInt(9999) : available
    ).toString();
    const identity = `1:${unit.identity.protocolAddress}:${unit.identity.orderHash}`;
    return {
      candidate_id: identity,
      order_id: unit.identity.orderHash,
      asset_key: asset.asset_key,
      quantity_available: quantity,
      unit_price_wei: unit.totalWei,
      execution_group: identity,
      group_cost_wei: gasReserve,
      inventory_key: `${unit.maker.toLowerCase()}:${asset.asset_key}`,
      inventory_quantity: quantity,
      valid_until: new Date(
        Math.min(validUntil, Number(unit.endTime) * 1000)
      ).toISOString()
    };
  } catch (error) {
    if (error instanceof MarketValidationError) return null;
    throw error;
  }
}

function chooseBest(
  candidates: Map<string, CollectingCandidate>,
  candidate: CollectingCandidate | null
) {
  if (candidate === null) return;
  const previous = candidates.get(candidate.asset_key);
  if (
    previous === undefined ||
    BigInt(candidate.unit_price_wei) < BigInt(previous.unit_price_wei) ||
    (candidate.unit_price_wei === previous.unit_price_wei &&
      candidate.candidate_id.localeCompare(previous.candidate_id) < 0)
  )
    candidates.set(candidate.asset_key, candidate);
}

/** Null retains the resumable provider scan; a seed accounts for every requested asset. */
export async function seedCollectPlanFromIndex(
  options: {
    analysis: Pick<CollectingAnalysis, 'catalog_version' | 'account'>;
    assetKeys: string[];
    gasReservePerOrderWei: string;
    now?: number;
  },
  budget = new CollectingWorkBudget(8000)
): Promise<CollectIndexedPlanSeed | null> {
  try {
    return await readIndexedSeed(options, budget);
  } catch (error) {
    if (error instanceof CollectingWorkTimeout) return null;
    throw error;
  }
}

async function readIndexedSeed(
  options: {
    analysis: Pick<CollectingAnalysis, 'catalog_version' | 'account'>;
    assetKeys: string[];
    gasReservePerOrderWei: string;
    now?: number;
  },
  budget: CollectingWorkBudget
): Promise<CollectIndexedPlanSeed | null> {
  const now = options.now ?? Date.now();
  marketUintSchema.parse(options.gasReservePerOrderWei);
  const catalog = await budget.waitFor(() => collectingService.getCatalog());
  if (catalog.version !== options.analysis.catalog_version) return null;
  const keys = new Set(options.assetKeys);
  const assets = catalog.assets.filter((asset) => keys.has(asset.asset_key));
  if (!assets.length || assets.length !== keys.size) return null;
  // The canonical catalog maps Memes, Gradients and Pebbles to distinct
  // contracts; Pebbles currently contains only NextGen collection 1.
  const families = Array.from(new Set(assets.map((asset) => asset.family)));
  const groups = await budget.waitFor(() =>
    Promise.all(
      families.map((family) =>
        readFamilyBooks(assets.filter((asset) => asset.family === family))
      )
    )
  );
  if (!groups.every((books) => completeFreshBooks(books, now))) return null;
  const books = groups.flat();
  const oldest = Math.min(
    ...books.map((book) => book.snapshot.completed_at.getTime())
  );
  const byIdentity = new Map(
    assets.map((asset) => [
      `${asset.contract.toLowerCase()}:${asset.token_id}`,
      asset
    ])
  );
  const wallets = new Set(
    options.analysis.account.wallets.map((wallet) => wallet.toLowerCase())
  );
  const best = new Map<string, CollectingCandidate>();
  for (const book of books) {
    for (const order of book.orders) {
      budget.assertAvailable();
      const asset = byIdentity.get(
        `${order.contract.toLowerCase()}:${order.token_id}`
      );
      if (asset === undefined) continue;
      chooseBest(
        best,
        indexedCandidate(
          order,
          asset,
          wallets,
          options.gasReservePerOrderWei,
          oldest + FRESH_MILLIS,
          now
        )
      );
    }
  }
  budget.assertAvailable();
  if (best.size > MAX_CANDIDATES) return null;
  return {
    candidates: Array.from(best.values()).sort((a, b) =>
      a.asset_key.localeCompare(b.asset_key)
    ),
    checked_asset_count: keys.size,
    unavailable_asset_count: keys.size - best.size,
    indexed_ask_count: books.reduce(
      (sum, book) => sum + book.snapshot.ask_count,
      0
    ),
    source_snapshot_ids: books
      .map((book) => book.snapshot.id)
      .sort((a, b) => a.localeCompare(b)),
    observed_at: new Date(oldest).toISOString(),
    source: 'OPENSEA_COMPLETE_INDEX'
  };
}
