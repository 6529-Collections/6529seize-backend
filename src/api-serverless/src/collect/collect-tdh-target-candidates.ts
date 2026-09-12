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
  const byKey = new Map(
    assets
      .filter((asset) => known.has(asset.asset_key))
      .map((asset) => [asset.asset_key, asset])
  );
  const wallets = new Set(
    source.account.wallets.map((wallet) => wallet.toLowerCase())
  );
  const listings = new Map<string, CollectTdhTargetListing>();
  let indexedCount = 0,
    evaluatedCount = 0,
    complete = groups.length > 0;
  const observed: number[] = [];
  for (const group of groups) {
    if (!group.books.length) complete = false;
    let familyRead = 0;
    for (const book of group.books) {
      indexedCount += book.snapshot.ask_count;
      const observationTimes = [
        book.snapshot.started_at.getTime(),
        book.snapshot.completed_at.getTime()
      ];
      const observedAt = freshObservation(observationTimes, now);
      observed.push(...observationTimes);
      if (observedAt === null || observationTimes[0] > observationTimes[1]) {
        complete = false;
        continue;
      }
      if (book.orders.length !== book.snapshot.ask_count) complete = false;
      for (const indexed of book.orders) {
        if (
          familyRead >= MAX_MARKET_DEPTH_COLLECTION_ASKS ||
          Date.now() >= deadline
        ) {
          complete = false;
          break;
        }
        familyRead++;
        evaluatedCount++;
        const rowObserved = indexed.observed_at.getTime();
        observed.push(rowObserved);
        const rowSource = freshObservation([observedAt, rowObserved], now);
        if (rowSource === null) {
          complete = false;
          continue;
        }
        const key =
          indexed.token_id === null
            ? ''
            : collectingAssetKey(indexed.contract, indexed.token_id);
        const asset = byKey.get(key);
        const listing =
          asset?.family === group.family
            ? candidateFor(
                indexed,
                asset,
                wallets,
                now,
                rowSource + FRESH_MILLIS
              )
            : null;
        if (listing !== null) listings.set(listing.candidate.id, listing);
      }
    }
  }
  // Cost ordering makes the retained universe deterministic. Exclusion is exposed;
  // no truncation is advertised as complete market coverage or a global optimum.
  const selected = Array.from(listings.values())
    .sort((a, b) => {
      const costA = BigInt(a.candidate.step_cost_wei),
        costB = BigInt(b.candidate.step_cost_wei);
      return costA < costB
        ? -1
        : costA > costB
          ? 1
          : a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, COLLECT_TDH_TARGET_LIMITS.candidates);
  return {
    listings: selected,
    coverage: {
      indexed_ask_count: indexedCount,
      evaluated_ask_count: evaluatedCount,
      candidate_count: selected.length,
      excluded_ask_count: Math.max(0, indexedCount - selected.length),
      index_complete: complete,
      market_complete: false,
      observed_at:
        observed.length && observed.every(Number.isFinite)
          ? new Date(Math.min(...observed)).toISOString()
          : null
    }
  };
}
