import { collectingDb } from '@/collecting/collecting.db';
import { collectingService } from '@/collecting/collecting.service';
import { collectingHash } from '@/collecting/collecting-analysis';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import {
  createCollectingDailyTdhPlanner,
  CollectingDailyTdhRequest
} from '@/collecting/collecting-daily-tdh';
import { collectTdhTargetCandidates } from '@/api/collect/collect-tdh-target-candidates';
import { readTargetBooks } from '@/api/collect/collect-tdh-target.service';
import { discoveredOrderDto } from '@/api/marketplace/marketplace.dto';
import { ApiCollectFamily } from '@/api/generated/models/ApiCollectFamily';
import { ApiCollectDailyTdhRequest } from '@/api/generated/models/ApiCollectDailyTdhRequest';
import { ApiCollectDailyTdhPlan } from '@/api/generated/models/ApiCollectDailyTdhPlan';
import { ApiCollectDailyTdhSearch } from '@/api/generated/models/ApiCollectDailyTdhSearch';

function resultStatus(
  request: CollectingDailyTdhRequest,
  achieved: bigint,
  candidateCount: number,
  captureComplete: boolean
): ApiCollectDailyTdhPlan['status'] {
  if (
    (request.mode === 'ETH_BUDGET' && request.budget_wei === '0') ||
    (request.mode === 'BASE_TDH_TARGET' &&
      request.target_base_tdh_per_day_hundredths === '0')
  )
    return 'NO_PURCHASE_NEEDED' as ApiCollectDailyTdhPlan['status'];
  if (
    request.mode === 'BASE_TDH_TARGET' &&
    achieved >= BigInt(request.target_base_tdh_per_day_hundredths!)
  )
    return 'TARGET_MET_BEST_FOUND' as ApiCollectDailyTdhPlan['status'];
  if (!candidateCount)
    return (
      captureComplete ? 'NO_LISTINGS' : 'PARTIAL'
    ) as ApiCollectDailyTdhPlan['status'];
  return (
    request.mode === 'ETH_BUDGET' ? 'BUDGET_ALLOCATED_BEST_FOUND' : 'PARTIAL'
  ) as ApiCollectDailyTdhPlan['status'];
}

export async function createCollectDailyTdhPlan(
  request: CollectingDailyTdhRequest,
  budget = new CollectingWorkBudget()
): Promise<ApiCollectDailyTdhPlan> {
  const analysisBudget = budget.child(18000, 2000);
  const now = Date.now();
  const [source, catalog] = await analysisBudget.waitFor(() =>
    Promise.all([
      collectingDb.readTdhProjectionSource(request.profile_id),
      collectingService.getCatalog()
    ])
  );
  const plan = createCollectingDailyTdhPlanner(
    source,
    request,
    now,
    analysisBudget
  );
  const noInput =
    request.target_base_tdh_per_day_hundredths === '0' ||
    request.budget_wei === '0';
  const candidateBudget = analysisBudget.child(8000, 4000);
  const deadline = Date.now() + analysisBudget.remainingMs();
  const groups = noInput
    ? []
    : await readTargetBooks(catalog.assets, request.families, candidateBudget);
  const captured = collectTdhTargetCandidates(
    source,
    catalog.assets,
    groups,
    now,
    deadline,
    candidateBudget
  );
  const captureTimedOut = candidateBudget.expired();
  const result = plan(captured.listings.map((listing) => listing.candidate));
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
  const achieved = BigInt(result.base_tdh_per_day_hundredths);
  const target =
    request.mode === 'BASE_TDH_TARGET'
      ? BigInt(request.target_base_tdh_per_day_hundredths!)
      : null;
  const value: Omit<ApiCollectDailyTdhPlan, 'plan_id'> = {
    request: request as ApiCollectDailyTdhRequest,
    status: resultStatus(
      request,
      achieved,
      result.search.candidate_count,
      captured.coverage.index_complete && !captureTimedOut
    ),
    base_tdh_per_day_hundredths: achieved.toString(),
    shortfall_base_tdh_per_day_hundredths:
      target === null
        ? null
        : (target > achieved ? target - achieved : BigInt(0)).toString(),
    purchase_cost_wei: result.purchase_cost_wei,
    signed_fees_wei: result.signed_fees_wei,
    remaining_budget_wei:
      request.mode === 'ETH_BUDGET'
        ? (
            BigInt(request.budget_wei!) - BigInt(result.purchase_cost_wei)
          ).toString()
        : null,
    gas_estimate_wei: items.length ? null : '0',
    funding_estimate_wei: items.length ? null : '0',
    items,
    personal_effects: result.personal_effects,
    catalog_version: catalog.version,
    valid_until: items.length
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
      stop_reason: (!noInput && captureTimedOut
        ? 'TIME_LIMIT'
        : result.search.stop_reason) as ApiCollectDailyTdhSearch['stop_reason'],
      optimality: result.search
        .optimality as ApiCollectDailyTdhSearch['optimality']
    },
    snapshot_block: result.snapshot_block,
    snapshot_timestamp: result.snapshot_timestamp,
    acquisition_timestamp: result.acquisition_timestamp,
    rules_version: result.rules_version,
    assumptions: [
      'Best found within bounded searches of supported captured ETH listings; not a globally optimal price or daily rate.',
      'Base TDH per day is the nominal rate per complete held day. A new acquisition starts at zero TDH; integer rounding and daily snapshots affect the next published change.',
      'Acquisitions are assumed to arrive now. Personal rates recompute the whole profile boost; the separately reported change to existing TDH is a stock revaluation at that time, not daily accrual.',
      'Delivering to a wallet outside this profile gives this profile no TDH or boost benefit. The basket base rate is still shown for the acquired artwork.',
      'Purchase cost includes exact signed fees for the selected quantities; fees must not be added again. Gas is unknown until fresh atomic basket review and is outside the purchase budget.',
      'Known catalog, supply and confirmed profile membership are frozen at the official snapshot. Only already eligible artwork is considered; subsequent mints, transfers or rule changes may change actual rates.',
      'Listings are not reserved or prepared by this analysis. Review refreshes exact order identities, quantities, recipients, payments and simulation.',
      'Alternative orders from the same maker for the same artwork are not combined because they may share inventory. No plan exceeds the atomic order or per-artwork quantity limits.',
      'Partial or empty results describe captured coverage and bounded search, not impossibility. Unfilled offers provide no TDH and are outside this Collect now calculation.'
    ]
  };
  budget.assertAvailable();
  return { plan_id: collectingHash(value), ...value };
}
