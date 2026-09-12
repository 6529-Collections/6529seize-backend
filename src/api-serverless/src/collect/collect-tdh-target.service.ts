import { collectingDb } from '@/collecting/collecting.db';
import { collectingService } from '@/collecting/collecting.service';
import { collectingHash } from '@/collecting/collecting-analysis';
import { CollectingAsset } from '@/collecting/collecting.types';
import { ProjectedAccountTdh } from '@/collecting/collecting-tdh-projection';
import { createCollectingTdhTargetSolver } from '@/collecting/collecting-tdh-target';
import {
  COLLECT_TDH_TARGET_LIMITS,
  CollectingTdhTargetRequest
} from '@/collecting/collecting-tdh-target.types';
import { marketDepthApiDb } from '@/api/market-depth/market-depth-api.db';
import { CustomApiCompliantException } from '@/exceptions';
import { collectTdhTargetCandidates } from '@/api/collect/collect-tdh-target-candidates';
import { discoveredOrderDto } from '@/api/marketplace/marketplace.dto';
import { ApiCollectFamily } from '@/api/generated/models/ApiCollectFamily';
import { ApiCollectTdhTargetRequestTargetModeEnum } from '@/api/generated/models/ApiCollectTdhTargetRequest';
import {
  ApiCollectTdhTargetPlan,
  ApiCollectTdhTargetPlanStatusEnum
} from '@/api/generated/models/ApiCollectTdhTargetPlan';
import {
  ApiCollectTdhTargetSearchOptimalityEnum,
  ApiCollectTdhTargetSearchStopReasonEnum
} from '@/api/generated/models/ApiCollectTdhTargetSearch';

async function readBooks(assets: CollectingAsset[]) {
  if (
    !assets.length ||
    new Set(assets.map((asset) => asset.contract.toLowerCase())).size !== 1
  )
    return [];
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

function accountDto(account: ProjectedAccountTdh) {
  return {
    ...account,
    tokens: account.tokens.map((token) => ({
      ...token,
      family: token.family as ApiCollectFamily
    })),
    boost_breakdown: Object.entries(account.boost_breakdown).map(
      ([id, boost]) => ({ id, ...boost })
    )
  };
}

export async function createCollectTdhTargetPlan(
  request: CollectingTdhTargetRequest
): Promise<ApiCollectTdhTargetPlan> {
  const now = Date.now(),
    deadline = now + COLLECT_TDH_TARGET_LIMITS.duration_ms;
  const [source, catalog] = await Promise.all([
    collectingDb.readTdhProjectionSource(request.profile_id),
    collectingService.getCatalog()
  ]);
  const solve = createCollectingTdhTargetSolver(source, request, now, deadline);
  const baselineOnly = solve([]);
  const groups =
    baselineOnly.status === 'NO_PURCHASE_NEEDED'
      ? []
      : await Promise.all(
          request.families.map(async (family) => ({
            family,
            books: await readBooks(
              catalog.assets.filter((asset) => asset.family === family)
            )
          }))
        );
  const captured = collectTdhTargetCandidates(
    source,
    catalog.assets,
    groups,
    now,
    deadline
  );
  const result =
    baselineOnly.status === 'NO_PURCHASE_NEEDED'
      ? baselineOnly
      : solve(captured.listings.map((listing) => listing.candidate));
  const byId = new Map(
    captured.listings.map((listing) => [listing.candidate.id, listing])
  );
  const items = result.selected.map(({ candidate, quantity }) => {
    const listing = byId.get(candidate.id)!;
    return {
      asset: {
        ...listing.asset,
        family: listing.asset.family as ApiCollectFamily
      },
      order: discoveredOrderDto(listing.order, listing.asset.asset_key),
      quantity: String(quantity),
      recipient: request.recipient
    };
  });
  const allocations = new Map<string, number>();
  items.forEach((item) =>
    allocations.set(
      item.asset.asset_key,
      (allocations.get(item.asset.asset_key) ?? 0) + Number(item.quantity)
    )
  );
  const noPurchase = result.status === 'NO_PURCHASE_NEEDED';
  const value: Omit<ApiCollectTdhTargetPlan, 'plan_id'> = {
    request: {
      ...request,
      target_mode:
        request.target_mode as ApiCollectTdhTargetRequestTargetModeEnum,
      families: request.families as ApiCollectFamily[]
    },
    status: result.status as ApiCollectTdhTargetPlanStatusEnum,
    projection: {
      ...result.projection,
      account: source.account,
      horizon_days: request.horizon_days,
      acquisition_timestamp: new Date(now).toISOString(),
      recipient_allocations: Array.from(
        allocations,
        ([asset_key, quantity]) => ({
          asset_key,
          quantity: String(quantity),
          recipient: request.recipient,
          counts_toward_profile: true
        })
      ),
      baseline: accountDto(result.projection.baseline),
      proposed: accountDto(result.projection.proposed)
    },
    target_total_tdh: result.target_total_tdh,
    shortfall_tdh: result.shortfall_tdh,
    purchase_cost_wei: result.purchase_cost_wei,
    signed_fees_wei: result.signed_fees_wei,
    gas_estimate_wei: noPurchase ? '0' : null,
    funding_estimate_wei: noPurchase ? '0' : null,
    items,
    catalog_version: catalog.version,
    valid_until: result.selected.length
      ? new Date(
          Math.min(
            ...result.selected.map(({ candidate }) =>
              Date.parse(byId.get(candidate.id)!.valid_until)
            )
          )
        ).toISOString()
      : null,
    coverage: captured.coverage,
    search: {
      ...result.search,
      optimality: result.search
        .optimality as ApiCollectTdhTargetSearchOptimalityEnum,
      stop_reason: result.search
        .stop_reason as ApiCollectTdhTargetSearchStopReasonEnum
    },
    assumptions: [
      'Best found among bounded, whole-portfolio evaluations of supported captured OpenSea listings; not a globally minimum budget.',
      'Purchases are assumed to arrive now in the selected profile wallet, with no subsequent transfers before the deadline.',
      'Purchase cost includes the exact signed listing fees. Gas is unquoted until fresh atomic batch review.',
      'Known supply, confirmed profile membership and TDH rules are frozen; future changes can change actual TDH.',
      'Listings are not reserved. Review refreshes the selected order identities, stock, recipients, exact payments and complete transaction simulation.',
      'Search uses cost-first states and completion bundles, at most 128 complete replays and 128 seller orders. Larger portfolios are not silently split.',
      'A gap means no meeting portfolio was found within captured coverage and search bounds, not that the target is impossible.'
    ]
  };
  return { plan_id: collectingHash(value), ...value };
}
