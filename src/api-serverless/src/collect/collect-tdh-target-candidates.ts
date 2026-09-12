import { collectingAssetKey } from '@/collecting/collecting-analysis';
import {
  CollectingAsset,
  CollectingFamily
} from '@/collecting/collecting.types';
import { CollectingTdhSource } from '@/collecting/collecting-tdh-projection';
import {
  COLLECT_TDH_TARGET_LIMITS,
  CollectingTdhTargetCandidate
} from '@/collecting/collecting-tdh-target.types';
import {
  CurrentMarketDepthSnapshot,
  CurrentMarketDepthOrder,
  MAX_MARKET_DEPTH_COLLECTION_ASKS
} from '@/market-depth/market-depth.types';
import { describeIndexedMarketBatchListing } from '@/marketplace/provider.opensea';
import {
  MarketDiscoveredOrder,
  MarketValidationError
} from '@/marketplace/provider.types';
import {
  MARKET_ASSET_STANDARDS,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';

const FRESH_MILLIS = 3600000;
function freshObservation(values: number[], now: number): number | null {
  if (
    values.some(
      (value) =>
        !Number.isFinite(value) || value > now || now - value >= FRESH_MILLIS
    )
  )
    return null;
  return Math.min(...values);
}
export interface CollectTdhTargetListing {
  candidate: CollectingTdhTargetCandidate;
  asset: CollectingAsset;
  order: MarketDiscoveredOrder;
  valid_until: string;
}

function candidateFor(
  indexed: CurrentMarketDepthOrder,
  asset: CollectingAsset,
  wallets: Set<string>,
  now: number,
  validUntil: number
): CollectTdhTargetListing | null {
  if (
    !asset.tdh_eligible ||
    indexed.side !== 'ask' ||
    indexed.status !== 'ACTIVE' ||
    indexed.is_private ||
    indexed.scope !== 'token' ||
    indexed.is_executable !== true ||
    indexed.source !== 'opensea' ||
    indexed.currency_contract !== MARKET_ZERO_ADDRESS ||
    indexed.currency_decimals !== 18 ||
    indexed.contract.toLowerCase() !== asset.contract.toLowerCase() ||
    indexed.token_id !== asset.token_id ||
    asset.asset_key !== collectingAssetKey(asset.contract, asset.token_id)
  )
    return null;
  const standard = MARKET_ASSET_STANDARDS[asset.contract.toLowerCase()];
  if (!standard) return null;
  try {
    const order = describeIndexedMarketBatchListing(
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
      wallets.has(order.maker.toLowerCase()) ||
      order.currency !== MARKET_ZERO_ADDRESS ||
      Number(order.startTime) * 1000 > now ||
      Number(order.endTime) * 1000 <= now ||
      BigInt(order.totalWei) <= BigInt(0)
    )
      return null;
    const step = Number(order.quantity);
    const available = BigInt(order.availableQuantity ?? order.quantity);
    if (
      !Number.isSafeInteger(step) ||
      step > COLLECT_TDH_TARGET_LIMITS.quantity_per_asset
    )
      return null;
    const maximum = Number(
      available > BigInt(COLLECT_TDH_TARGET_LIMITS.quantity_per_asset)
        ? BigInt(COLLECT_TDH_TARGET_LIMITS.quantity_per_asset)
        : available
    );
    return {
      asset,
      order,
      valid_until: new Date(
        Math.min(validUntil, Number(order.endTime) * 1000)
      ).toISOString(),
      candidate: {
        id: `${order.identity.protocolAddress.toLowerCase()}:${order.identity.orderHash.toLowerCase()}`,
        asset_key: asset.asset_key,
        maker: order.maker.toLowerCase(),
        quantity_step: step,
        available_quantity: maximum,
        step_cost_wei: order.totalWei,
        step_fees_wei: order.fees
          .reduce((sum, fee) => sum + BigInt(fee.amountWei), BigInt(0))
          .toString()
      }
    };
  } catch (error) {
    if (error instanceof MarketValidationError) return null;
    throw error;
  }
}

interface CandidateCapture {
  byKey: Map<string, CollectingAsset>;
  wallets: Set<string>;
  listings: Map<string, CollectTdhTargetListing>;
  indexedCount: number;
  evaluatedCount: number;
  complete: boolean;
  observed: number[];
  now: number;
  deadline: number;
}

function captureOrder(
  indexed: CurrentMarketDepthOrder,
  family: CollectingFamily,
  observedAt: number,
  capture: CandidateCapture
): void {
  capture.evaluatedCount++;
  const rowObserved = indexed.observed_at.getTime();
  capture.observed.push(rowObserved);
  const rowSource = freshObservation([observedAt, rowObserved], capture.now);
  if (rowSource === null) {
    capture.complete = false;
    return;
  }
  const key =
    indexed.token_id === null
      ? ''
      : collectingAssetKey(indexed.contract, indexed.token_id);
  const asset = capture.byKey.get(key);
  if (asset?.family !== family) return;
  const listing = candidateFor(
    indexed,
    asset,
    capture.wallets,
    capture.now,
    rowSource + FRESH_MILLIS
  );
  if (listing !== null) capture.listings.set(listing.candidate.id, listing);
}

function captureBook(
  book: CurrentMarketDepthSnapshot,
  family: CollectingFamily,
  familyRead: number,
  capture: CandidateCapture
): number {
  capture.indexedCount += book.snapshot.ask_count;
  const times = [
    book.snapshot.started_at.getTime(),
    book.snapshot.completed_at.getTime()
  ];
  const observedAt = freshObservation(times, capture.now);
  capture.observed.push(...times);
  if (observedAt === null || times[0] > times[1]) {
    capture.complete = false;
    return familyRead;
  }
  if (book.orders.length !== book.snapshot.ask_count) capture.complete = false;
  let read = familyRead;
  for (const indexed of book.orders) {
    if (
      read >= MAX_MARKET_DEPTH_COLLECTION_ASKS ||
      Date.now() >= capture.deadline
    ) {
      capture.complete = false;
      break;
    }
    read++;
    captureOrder(indexed, family, observedAt, capture);
  }
  return read;
}

function compareListingCost(
  a: CollectTdhTargetListing,
  b: CollectTdhTargetListing
): number {
  const costA = BigInt(a.candidate.step_cost_wei),
    costB = BigInt(b.candidate.step_cost_wei);
  if (costA !== costB) return costA < costB ? -1 : 1;
  return a.candidate.id.localeCompare(b.candidate.id);
}

/** Captured ask coverage is distinct from live market and supported order coverage. */
export function collectTdhTargetCandidates(
  source: CollectingTdhSource,
  assets: CollectingAsset[],
  groups: Array<{
    family: CollectingFamily;
    books: CurrentMarketDepthSnapshot[];
  }>,
  now: number,
  deadline: number
) {
  const known = new Set(
    source.input.tokens.map((token) =>
      collectingAssetKey(token.contract, String(token.token_id))
    )
  );
  const capture: CandidateCapture = {
    byKey: new Map(
      assets
        .filter((asset) => known.has(asset.asset_key))
        .map((asset) => [asset.asset_key, asset])
    ),
    wallets: new Set(
      source.account.wallets.map((wallet) => wallet.toLowerCase())
    ),
    listings: new Map(),
    indexedCount: 0,
    evaluatedCount: 0,
    complete: groups.length > 0,
    observed: [],
    now,
    deadline
  };
  for (const group of groups) {
    if (!group.books.length) capture.complete = false;
    let familyRead = 0;
    for (const book of group.books)
      familyRead = captureBook(book, group.family, familyRead, capture);
  }
  // The retained universe is deterministic. Exclusions never imply complete
  // live market coverage or global optimality.
  const selected = Array.from(capture.listings.values())
    .sort(compareListingCost)
    .slice(0, COLLECT_TDH_TARGET_LIMITS.candidates);
  return {
    listings: selected,
    coverage: {
      indexed_ask_count: capture.indexedCount,
      evaluated_ask_count: capture.evaluatedCount,
      candidate_count: selected.length,
      excluded_ask_count: Math.max(0, capture.indexedCount - selected.length),
      index_complete: capture.complete,
      market_complete: false,
      observed_at:
        capture.observed.length && capture.observed.every(Number.isFinite)
          ? new Date(Math.min(...capture.observed)).toISOString()
          : null
    }
  };
}
