import { isAddress } from 'ethers';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import {
  assertCollectingTdhParity,
  CollectingTdhSource,
  createCollectingTdhProjector,
  getCollectingTdhEligibleRates,
  ProjectedAccountTdh
} from '@/collecting/collecting-tdh-projection';
import { CollectingTdhTargetCandidate } from '@/collecting/collecting-tdh-target.types';
import { CollectingFamily } from '@/collecting/collecting.types';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import { solveCollectingDailyTdhSearch } from '@/collecting/collecting-daily-tdh-search';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { NULL_ADDRESS } from '@/constants';

export interface CollectingDailyTdhRequest {
  profile_id: string;
  recipient: string;
  families: CollectingFamily[];
  mode: 'BASE_TDH_TARGET' | 'ETH_BUDGET';
  target_base_tdh_per_day_hundredths?: string;
  budget_wei?: string;
}

function safeHundredths(value: number): bigint {
  const scaled = Math.round(value * 100);
  if (!Number.isSafeInteger(scaled) || scaled < 0)
    throw new CustomApiCompliantException(
      503,
      'TDH rate exceeds exact supported precision'
    );
  return BigInt(scaled);
}

function accountRate(account: ProjectedAccountTdh): bigint {
  return account.tokens.reduce(
    (sum, token) =>
      sum + safeHundredths(token.hodl_rate) * BigInt(token.balance),
    BigInt(0)
  );
}

function validateSource(
  source: CollectingTdhSource,
  request: CollectingDailyTdhRequest,
  now: number
) {
  if (
    source.account.profile_id !== request.profile_id ||
    !isAddress(request.recipient) ||
    request.recipient.toLowerCase() === NULL_ADDRESS
  )
    throw new BadRequestException('A valid profile and recipient are required');
  const age = now - Date.parse(source.input.snapshot_timestamp);
  if (!Number.isFinite(age) || age < 0 || age > 36 * 3600000)
    throw new CustomApiCompliantException(
      503,
      'A recent official TDH snapshot is required'
    );
  const historyWork = source.input.transactions.reduce(
    (sum, tx) => sum + tx.token_count + 1,
    0
  );
  // One parity replay, one baseline and one selected portfolio; reserve for
  // hypothetical inventory validation as well as the production calculation.
  const work =
    historyWork * source.account.wallets.length + source.input.tokens.length;
  if (!Number.isSafeInteger(work) || work * 4 > 10000000)
    throw new CustomApiCompliantException(
      503,
      'The profile exceeds the daily analysis work window'
    );
  return { historyWork, baseWork: work };
}

/** Base-rate optimization is linear. Recompute the chosen portfolio's nonlinear
 * personal boost with the production replay, rather than summing card effects. */
export function createCollectingDailyTdhPlanner(
  source: CollectingTdhSource,
  request: CollectingDailyTdhRequest,
  now: number,
  budget: CollectingWorkBudget
) {
  const work = validateSource(source, request, now);
  budget.assertAvailable();
  assertCollectingTdhParity(source.input, source.official);
  const acquisitionTimestamp = new Date(now).toISOString();
  const project = createCollectingTdhProjector({
    ...source.input,
    evaluated_at: acquisitionTimestamp,
    transfers: []
  });
  const baseline = project([]).baseline;
  const rates = new Map(
    getCollectingTdhEligibleRates(source.input, new Date(now)).map(
      ({ token, rate }) => [
        collectingAssetKey(token.contract, String(token.token_id)),
        {
          token,
          rate_hundredths: safeHundredths(rate).toString()
        }
      ]
    )
  );
  const owned = new Set(
    baseline.tokens
      .filter((token) => token.balance > 0)
      .map((token) => token.asset_key)
  );
  const wallets = new Set(
    source.account.wallets.map((wallet) => wallet.toLowerCase())
  );
  const countsTowardProfile = wallets.has(request.recipient.toLowerCase());
  budget.assertAvailable();
  return (supplied: CollectingTdhTargetCandidate[]) => {
    const candidates = supplied.flatMap((candidate) => {
      const entry = rates.get(candidate.asset_key);
      if (
        !entry ||
        !request.families.includes(entry.token.family) ||
        wallets.has(candidate.maker.toLowerCase()) ||
        (entry.token.family !== 'memes' && owned.has(candidate.asset_key))
      )
        return [];
      return [
        {
          ...candidate,
          rate_hundredths: entry.rate_hundredths,
          unique: entry.token.family !== 'memes'
        }
      ];
    });
    // Leave time for a complete replay and response after the bounded search.
    const result = solveCollectingDailyTdhSearch(
      candidates,
      request,
      budget.child(8000, 3000)
    );
    budget.assertAvailable();
    const quantities = new Map<string, number>();
    result.selected.forEach(({ candidate, quantity }) =>
      quantities.set(
        candidate.asset_key,
        (quantities.get(candidate.asset_key) ?? 0) + quantity
      )
    );
    const hypotheticalWork = Array.from(quantities.values()).reduce(
      (sum, quantity) => sum + quantity + 1,
      0
    );
    const replayWork =
      work.baseWork * 3 +
      (work.historyWork * quantities.size +
        hypotheticalWork * (quantities.size + 1)) *
        source.account.wallets.length;
    if (!Number.isSafeInteger(replayWork) || replayWork > 10000000)
      throw new CustomApiCompliantException(
        503,
        'The selected basket exceeds the daily analysis work window'
      );
    const projection = project(
      Array.from(quantities, ([asset_key, quantity]) => ({
        contract: rates.get(asset_key)!.token.contract,
        token_id: rates.get(asset_key)!.token.token_id,
        from_address: NULL_ADDRESS,
        to_address: request.recipient,
        quantity,
        timestamp: acquisitionTimestamp
      }))
    );
    if (
      ![
        baseline.base_tdh,
        baseline.boosted_tdh,
        projection.proposed.base_tdh,
        projection.proposed.boosted_tdh,
        projection.changed_boost_on_existing_holdings
      ].every(Number.isSafeInteger)
    )
      throw new CustomApiCompliantException(
        503,
        'Projected TDH exceeds exact supported precision'
      );
    const baselineRate = accountRate(baseline);
    const proposedRate = accountRate(projection.proposed);
    const baselineBoostedRate = baselineRate * safeHundredths(baseline.boost);
    const proposedBoostedRate =
      proposedRate * safeHundredths(projection.proposed.boost);
    budget.assertAvailable();
    return {
      ...result,
      snapshot_block: source.input.snapshot_block,
      snapshot_timestamp: source.input.snapshot_timestamp,
      acquisition_timestamp: acquisitionTimestamp,
      rules_version: source.input.rules_version,
      personal_effects: {
        counts_toward_profile: countsTowardProfile,
        baseline_base_tdh_per_day_hundredths: baselineRate.toString(),
        proposed_base_tdh_per_day_hundredths: proposedRate.toString(),
        baseline_boost: baseline.boost,
        proposed_boost: projection.proposed.boost,
        baseline_boosted_tdh_per_day_ten_thousandths:
          baselineBoostedRate.toString(),
        proposed_boosted_tdh_per_day_ten_thousandths:
          proposedBoostedRate.toString(),
        additional_boosted_tdh_per_day_ten_thousandths: (
          proposedBoostedRate - baselineBoostedRate
        ).toString(),
        changed_boost_on_existing_tdh:
          projection.changed_boost_on_existing_holdings
      }
    };
  };
}
