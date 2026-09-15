import {
  collectingAssetKey,
  collectingHash
} from '@/collecting/collecting-analysis';
import {
  assertCollectingTdhParity,
  CollectingPurchaseProjectionRequest,
  CollectingTdhSource,
  createCollectingTdhProjector
} from '@/collecting/collecting-tdh-projection';
import { NULL_ADDRESS } from '@/constants';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { isAddress } from 'ethers';

/** Trusted server quote input: cost includes the complete basket execution cost.
 * These amounts must never be accepted directly from a public API request. */
export interface CollectingQuotedTdhCandidate {
  candidate_id: string;
  total_cost_wei: string;
  valid_until: string;
  acquisitions: CollectingPurchaseProjectionRequest['acquisitions'];
}

export interface CollectingTdhRankedCandidate {
  candidate_id: string;
  total_cost_wei: string;
  scenario_id: string;
  additional_tdh: number;
  additional_base_tdh: number;
  changed_boost_on_existing_holdings: number;
  proposed_boost: number;
  proposed_boosted_tdh: number;
  cost_per_additional_tdh: {
    numerator_wei: string;
    denominator_tdh: number;
  } | null;
}

export function prepareCollectingPurchaseProjection(
  source: CollectingTdhSource,
  request: CollectingPurchaseProjectionRequest,
  now: number,
  maxAllocations = 2000
) {
  if (
    ![1, 30, 90, 365].includes(request.horizon_days) ||
    !request.acquisitions.length ||
    request.acquisitions.length > maxAllocations ||
    request.profile_id !== source.account.profile_id
  )
    throw new BadRequestException('Invalid purchase projection bounds');
  const lag = now - Date.parse(source.input.snapshot_timestamp);
  if (!Number.isFinite(lag) || lag < 0 || lag > 36 * 3600000)
    throw new CustomApiCompliantException(
      503,
      'A recent official TDH snapshot is required'
    );
  const at = new Date(now);
  const evaluatedAt = new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate() + request.horizon_days
    )
  );
  const tokens = new Map(
    source.input.tokens.map((token) => [
      collectingAssetKey(token.contract, String(token.token_id)),
      token
    ])
  );
  const seen = new Set<string>();
  const allocations = request.acquisitions.map((acquisition) => {
    const token = tokens.get(acquisition.asset_key);
    const recipient = acquisition.recipient.toLowerCase();
    const key = `${acquisition.asset_key}:${recipient}`;
    if (
      !token ||
      !isAddress(acquisition.recipient) ||
      !/^[1-9]\d{0,3}$/.test(acquisition.quantity) ||
      (token.family !== 'memes' && acquisition.quantity !== '1') ||
      seen.has(key)
    )
      throw new BadRequestException('Invalid purchase allocation');
    seen.add(key);
    return {
      ...acquisition,
      recipient,
      counts_toward_profile: source.account.wallets.includes(recipient)
    };
  });
  const transfers = allocations.map((allocation) => {
    const token = tokens.get(allocation.asset_key)!;
    return {
      contract: token.contract,
      token_id: token.token_id,
      quantity: Number(allocation.quantity),
      from_address: NULL_ADDRESS,
      to_address: allocation.recipient,
      timestamp: at.toISOString()
    };
  });
  return {
    input: {
      ...source.input,
      evaluated_at: evaluatedAt.toISOString(),
      transfers
    },
    allocations,
    acquisition_timestamp: at.toISOString()
  };
}

function quoteCost(candidate: CollectingQuotedTdhCandidate): bigint {
  if (!/^(0|[1-9]\d{0,77})$/.test(candidate.total_cost_wei))
    throw new BadRequestException('Invalid TDH quote cost');
  const cost = BigInt(candidate.total_cost_wei);
  if (
    cost >
    BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  )
    throw new BadRequestException('Invalid TDH quote cost');
  return cost;
}

function compareRanked(
  a: CollectingTdhRankedCandidate,
  b: CollectingTdhRankedCandidate
): number {
  if (a.additional_tdh > 0 && b.additional_tdh <= 0) return -1;
  if (b.additional_tdh > 0 && a.additional_tdh <= 0) return 1;
  const costA = BigInt(a.total_cost_wei);
  const costB = BigInt(b.total_cost_wei);
  if (a.additional_tdh > 0 && b.additional_tdh > 0) {
    const difference =
      costA * BigInt(b.additional_tdh) - costB * BigInt(a.additional_tdh);
    if (difference !== BigInt(0)) return difference < BigInt(0) ? -1 : 1;
  }
  return costA < costB
    ? -1
    : costA > costB
      ? 1
      : a.candidate_id.localeCompare(b.candidate_id);
}

/** Exact marginal TDH for each supplied basket, bounded selection across baskets.
 * A basket may include a season/set completion whose portfolio boost is nonlinear. */
export function rankCollectingTdhQuotes(
  source: CollectingTdhSource,
  horizon: CollectingPurchaseProjectionRequest['horizon_days'],
  candidates: CollectingQuotedTdhCandidate[],
  now: number
) {
  if (candidates.length > 2000)
    throw new BadRequestException(
      'TDH ranking accepts at most 2000 quoted candidates'
    );
  assertCollectingTdhParity(source.input, source.official);
  const seen = new Set<string>();
  const excluded: Array<{
    candidate_id: string;
    reason: 'expired' | 'evaluation_bound';
  }> = [];
  const valid = candidates
    .filter((candidate) => {
      if (
        !candidate.candidate_id ||
        candidate.candidate_id.length > 200 ||
        seen.has(candidate.candidate_id)
      )
        throw new BadRequestException('Invalid TDH candidate identity');
      seen.add(candidate.candidate_id);
      quoteCost(candidate);
      const expiry = Date.parse(candidate.valid_until);
      if (!Number.isFinite(expiry))
        throw new BadRequestException('Invalid TDH quote expiry');
      if (expiry <= now) {
        excluded.push({
          candidate_id: candidate.candidate_id,
          reason: 'expired'
        });
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const difference = quoteCost(a) - quoteCost(b);
      return difference < BigInt(0)
        ? -1
        : difference > BigInt(0)
          ? 1
          : a.candidate_id.localeCompare(b.candidate_id);
    });
  const replayCost = Math.max(
    1,
    source.input.transactions.reduce(
      (sum, transaction) => sum + transaction.token_count + 1,
      0
    ) *
      source.account.wallets.length +
      source.input.tokens.length
  );
  const limit = Math.min(128, Math.max(1, Math.floor(10000000 / replayCost)));
  valid.slice(limit).forEach((candidate) =>
    excluded.push({
      candidate_id: candidate.candidate_id,
      reason: 'evaluation_bound'
    })
  );
  const selected = valid.slice(0, limit);
  const prepared = selected.map((candidate) => ({
    candidate,
    scenario: prepareCollectingPurchaseProjection(
      source,
      {
        profile_id: source.account.profile_id,
        horizon_days: horizon,
        acquisitions: candidate.acquisitions
      },
      now,
      2000
    )
  }));
  // Even an all-expired quote set validates the public time/horizon contract.
  const at = new Date(now);
  const evaluatedAt = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + horizon)
  ).toISOString();
  if (
    ![1, 30, 90, 365].includes(horizon) ||
    now < Date.parse(source.input.snapshot_timestamp) ||
    now - Date.parse(source.input.snapshot_timestamp) > 36 * 3600000
  )
    throw new BadRequestException('Invalid TDH ranking horizon or snapshot');
  const project = createCollectingTdhProjector({
    ...source.input,
    evaluated_at: evaluatedAt,
    transfers: []
  });
  const ranked = prepared
    .map(({ candidate, scenario }): CollectingTdhRankedCandidate => {
      const projection = project(scenario.input.transfers);
      return {
        candidate_id: candidate.candidate_id,
        total_cost_wei: candidate.total_cost_wei,
        scenario_id: projection.scenario_id,
        additional_tdh: projection.additional_tdh,
        additional_base_tdh: projection.additional_base_tdh,
        changed_boost_on_existing_holdings:
          projection.changed_boost_on_existing_holdings,
        proposed_boost: projection.proposed.boost,
        proposed_boosted_tdh: projection.proposed.boosted_tdh,
        cost_per_additional_tdh:
          projection.additional_tdh > 0
            ? {
                numerator_wei: candidate.total_cost_wei,
                denominator_tdh: projection.additional_tdh
              }
            : null
      };
    })
    .sort(compareRanked);
  const result = {
    account: source.account,
    snapshot_block: source.input.snapshot_block,
    snapshot_timestamp: source.input.snapshot_timestamp,
    acquisition_timestamp: at.toISOString(),
    evaluated_at: evaluatedAt,
    horizon_days: horizon,
    rules_version: source.input.rules_version,
    candidate_count: candidates.length,
    evaluated_count: ranked.length,
    optimality: 'best_found' as const,
    candidate_scope: 'supplied_verified_quotes' as const,
    ranked,
    excluded
  };
  return { ranking_id: collectingHash(result), ...result };
}
