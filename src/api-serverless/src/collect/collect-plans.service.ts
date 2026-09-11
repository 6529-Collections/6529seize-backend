import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CollectingAnalysis,
  CollectingAnalysisRequest
} from '@/collecting/collecting.types';
import { collectingService } from '@/collecting/collecting.service';
import {
  CollectingCandidate,
  planCollectingAcquisitions
} from '@/collecting/collecting-planner';
import { CustomApiCompliantException, NotFoundException } from '@/exceptions';
import { dbSupplier } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import { marketChain } from '@/marketplace/market-chain';
import {
  marketUintSchema,
  marketAddressSchema
} from '@/marketplace/seaport.schema';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';
import {
  describeMarketOrder,
  OPENSEA_REQUEST_TIMEOUT_MS
} from '@/marketplace/provider.opensea';
import { marketplaceProvider } from '@/api/marketplace/marketplace.service';
import { marketRequestHash } from '@/marketplace/market-operations.db';
import { CollectingQuotedTdhCandidate } from '@/collecting/collecting-tdh-ranking';

const MAX_CANDIDATES = 2000;
// Each artwork may need discovery and order reads. Keep one concurrent pair
// within the API request budget, persisting progress between requests.
const BATCH_SIZE = 2;
const SCAN_BUDGET_MS = 20000;
export const collectPlanOptionsSchema = z
  .object({
    budget_wei: marketUintSchema,
    recipient: marketAddressSchema,
    expected_analysis_id: z.string().max(100).optional()
  })
  .strict();
export type CollectPlanOptions = z.infer<typeof collectPlanOptionsSchema>;
interface PlanData {
  goal: CollectingAnalysisRequest;
  analysis: CollectingAnalysis;
  budget_wei: string;
  asset_keys: string[];
  cursor: number;
  candidates: CollectingCandidate[];
  unavailable: number;
  failed: number;
  gas_reserve_per_order_wei: string;
}
interface PlanRow {
  id: string;
  profile_id: string;
  state: 'SCANNING' | 'READY' | 'STALE';
  payload_json: string | PlanData;
  updated_at: number;
  lease_token: string | null;
  lease_until: number;
}
const data = (row: PlanRow): PlanData =>
  typeof row.payload_json === 'string'
    ? JSON.parse(row.payload_json)
    : row.payload_json;
const collectingStateHash = (analysis: CollectingAnalysis) =>
  marketRequestHash({
    catalog_version: analysis.catalog_version,
    // MySQL JSON storage can reorder object properties. Rebuild the compared
    // state explicitly so unchanged holdings survive a database round trip.
    account: {
      profile_id: analysis.account.profile_id,
      consolidation_key: analysis.account.consolidation_key,
      wallets: analysis.account.wallets,
      membership_hash: analysis.account.membership_hash
    },
    requirements: analysis.requirements.map((requirement) => ({
      id: requirement.id,
      label: requirement.label,
      target_quantity: requirement.target_quantity,
      owned_quantity: requirement.owned_quantity,
      missing_quantity: requirement.missing_quantity,
      asset_keys: requirement.asset_keys,
      holdings: requirement.holdings.map((holding) => ({
        asset_key: holding.asset_key,
        wallet: holding.wallet,
        quantity: holding.quantity
      }))
    })),
    recipient: analysis.recipient
  });

export function collectPlanView(row: PlanRow) {
  const payload = data(row);
  const result = planCollectingAcquisitions(
    payload.analysis,
    payload.candidates,
    {
      evaluated_at: new Date().toISOString(),
      budget_wei: payload.budget_wei,
      max_states: 20000
    }
  );
  const candidates = new Map(
    payload.candidates.map((candidate) => [candidate.candidate_id, candidate])
  );
  return {
    id: row.id,
    state: row.state,
    revision: marketRequestHash({
      id: row.id,
      updated_at: row.updated_at,
      cursor: payload.cursor
    }),
    profile_id: row.profile_id,
    analysis: payload.analysis,
    result: {
      ...result,
      legs: result.legs.map((leg) => ({
        ...leg,
        unit_price_wei: candidates.get(leg.candidate_id)?.unit_price_wei
      }))
    },
    checked_asset_count: payload.cursor,
    total_asset_count: payload.asset_keys.length,
    unavailable_asset_count: payload.unavailable,
    failed_asset_count: payload.failed,
    candidate_universe_complete: false,
    asset_scan_complete:
      payload.cursor === payload.asset_keys.length && payload.failed === 0,
    gas_reserve_per_order_wei: payload.gas_reserve_per_order_wei,
    assumptions: [
      'One best exact OpenSea listing per artwork was checked; this does not exhaust market depth, and additional copies may need other listings.',
      'Listings and seller inventory are rechecked before purchase.',
      'The plan reserves estimated gas for each separate purchase transaction. Actual gas can change.',
      'Plan purchases require your review and wallet approval.'
    ],
    updated_at: Number(row.updated_at)
  };
}

export async function createCollectPlan(
  profileId: string,
  goal: CollectingAnalysisRequest,
  options: CollectPlanOptions
) {
  if (goal.profile_id !== profileId)
    throw new CustomApiCompliantException(
      403,
      'Create a plan for your active profile.'
    );
  const analysis = await collectingService.analyze({
    ...goal,
    recipient: options.recipient
  });
  if (
    options.expected_analysis_id &&
    options.expected_analysis_id !== analysis.analysis_id
  )
    throw new CustomApiCompliantException(
      409,
      'Your collection changed. Refresh the analysis.',
      'HOLDINGS_CHANGED'
    );
  const fee = await marketChain().rpc.getFeeData();
  if (fee.maxFeePerGas === null || fee.maxFeePerGas <= BigInt(0))
    throw new CustomApiCompliantException(
      503,
      'A gas estimate is unavailable.'
    );
  const gasReserve = fee.maxFeePerGas * BigInt(450000);
  const assetKeys = Array.from(
    new Set(
      analysis.requirements
        .filter((item) => BigInt(item.missing_quantity) > BigInt(0))
        .flatMap((item) => item.asset_keys)
    )
  ).sort((a, b) => a.localeCompare(b));
  const payload: PlanData = {
    goal,
    analysis,
    budget_wei: options.budget_wei,
    asset_keys: assetKeys,
    cursor: 0,
    candidates: [],
    unavailable: 0,
    failed: 0,
    gas_reserve_per_order_wei: gasReserve.toString()
  };
  const row = {
    id: randomUUID(),
    profile_id: profileId,
    state: assetKeys.length ? 'SCANNING' : 'READY',
    payload_json: JSON.stringify(payload),
    created_at: Date.now(),
    updated_at: Date.now()
  };
  await dbSupplier().execute(
    'INSERT INTO collect_plans (id,profile_id,state,payload_json,created_at,updated_at) VALUES (:id,:profile_id,:state,:payload_json,:created_at,:updated_at)',
    row
  );
  return readCollectPlan(row.id, profileId);
}

async function rowFor(id: string, profileId: string): Promise<PlanRow> {
  // Creation, lease checks and checkpoints must observe the latest primary state.
  const row = await dbSupplier().oneOrNull<PlanRow>(
    'SELECT * FROM collect_plans WHERE id=:id AND profile_id=:profileId',
    { id, profileId },
    { forcePool: DbPoolName.WRITE }
  );
  if (!row) throw new NotFoundException('Collecting plan not found.');
  return row;
}
export async function readCollectPlan(id: string, profileId: string) {
  return collectPlanView(await rowFor(id, profileId));
}

export async function collectPlanRankingCandidates(
  id: string,
  profileId: string,
  recipient: string
): Promise<CollectingQuotedTdhCandidate[]> {
  const row = await rowFor(id, profileId),
    payload = data(row);
  if (row.state !== 'READY')
    throw new CustomApiCompliantException(
      409,
      'Finish or refresh the collecting plan before comparing its TDH.'
    );
  const current = await collectingService.analyze({
    ...payload.goal,
    recipient
  });
  if (collectingStateHash(current) !== collectingStateHash(payload.analysis))
    throw new CustomApiCompliantException(
      409,
      'The profile or recipient changed. Refresh this plan.',
      'HOLDINGS_CHANGED'
    );
  // Projection source is frozen at the official TDH snapshot. Do not rank newly
  // released artwork whose supply and transfer history are outside that proof.
  const catalog = await collectingService.getCatalog();
  const eligible = new Set(
    catalog.assets
      .filter((asset) => asset.tdh_eligible)
      .map((asset) => asset.asset_key)
  );
  const byId = new Map(
    payload.candidates.map((candidate) => [candidate.candidate_id, candidate])
  );
  const plan = collectPlanView(row).result;
  const selectedQuotes = plan.legs.map((leg) => {
    const quote = byId.get(leg.candidate_id);
    if (!quote || quote.asset_key !== leg.asset_key)
      throw new CustomApiCompliantException(
        409,
        'Plan quotes changed. Refresh this plan.',
        'HOLDINGS_CHANGED'
      );
    return quote;
  });
  const candidates: CollectingQuotedTdhCandidate[] = payload.candidates
    .filter((candidate) => eligible.has(candidate.asset_key))
    .slice(0, 1999)
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      total_cost_wei: (
        BigInt(candidate.unit_price_wei) + BigInt(candidate.group_cost_wei)
      ).toString(),
      valid_until: candidate.valid_until,
      acquisitions: [
        { asset_key: candidate.asset_key, quantity: '1', recipient }
      ]
    }));
  const quantities = new Map<string, bigint>();
  for (const leg of plan.legs)
    quantities.set(
      leg.asset_key,
      (quantities.get(leg.asset_key) ?? BigInt(0)) + BigInt(leg.quantity)
    );
  // A mixed basket must not be relabeled as if its ineligible artworks were
  // projected. Eligible individual alternatives remain available above.
  if (plan.legs.length && plan.legs.every((leg) => eligible.has(leg.asset_key)))
    candidates.push({
      candidate_id: plan.plan_id,
      total_cost_wei: plan.total_cost_wei,
      valid_until: selectedQuotes.reduce(
        (earliest, quote) =>
          quote.valid_until < earliest ? quote.valid_until : earliest,
        '9999-01-01T00:00:00.000Z'
      ),
      acquisitions: Array.from(quantities, ([asset_key, quantity]) => ({
        asset_key,
        quantity: quantity.toString(),
        recipient
      }))
    });
  return candidates;
}

async function candidatesFor(
  key: string,
  payload: PlanData,
  deadline: number
): Promise<CollectingCandidate[]> {
  const catalog = await collectingService.getCatalog();
  const asset = catalog.assets.find((item) => item.asset_key === key);
  if (!asset) return [];
  const marketAsset = {
    contract: asset.contract,
    tokenId: asset.token_id,
    standard:
      asset.family === 'memes' ? ('ERC1155' as const) : ('ERC721' as const)
  };
  const provider = marketplaceProvider();
  // Discovery performs a contract lookup and one listing read. Do not start
  // another bounded transport stage unless this request can await its timeout.
  requireScanBudget(deadline, 2);
  const listings = await provider.discoverOrders(marketAsset, 'LISTING', 1);
  const result: CollectingCandidate[] = [];
  const wallets = new Set(
    payload.analysis.account.wallets.map((wallet) => wallet.toLowerCase())
  );
  for (const listing of listings.slice(0, 1)) {
    if (
      listing.currency !== MARKET_ZERO_ADDRESS ||
      wallets.has(listing.maker.toLowerCase())
    )
      continue;
    requireScanBudget(deadline, 1);
    const order = await provider.getOrder(listing.identity);
    requireScanBudget(deadline, 0);
    if (order.components.orderType % 2 === 0 && listing.quantity !== '1')
      continue;
    const unit = describeMarketOrder(order, marketAsset, 'LISTING', '1');
    if (BigInt(unit.totalWei) === BigInt(0)) continue;
    const identity = `1:${listing.identity.protocolAddress}:${listing.identity.orderHash}`;
    result.push({
      candidate_id: identity,
      order_id: listing.identity.orderHash,
      asset_key: key,
      quantity_available: listing.quantity,
      unit_price_wei: unit.totalWei,
      execution_group: identity,
      group_cost_wei: payload.gas_reserve_per_order_wei,
      inventory_key: `${listing.maker.toLowerCase()}:${key}`,
      inventory_quantity: listing.quantity,
      valid_until: new Date(Number(listing.endTime) * 1000).toISOString()
    });
  }
  return result;
}

function requireScanBudget(deadline: number, remainingReads: number) {
  if (Date.now() + remainingReads * OPENSEA_REQUEST_TIMEOUT_MS > deadline)
    throw new CustomApiCompliantException(
      503,
      'The listing scan exceeded its request budget. Rebuild the plan to retry failed assets.',
      'PLAN_SCAN_TIMEOUT'
    );
}

function lostScanLease(): never {
  throw new CustomApiCompliantException(
    409,
    'Another request took over this scan. Retry to load its latest progress.',
    'PLAN_SCAN_RETRY'
  );
}

export async function advanceCollectPlan(id: string, profileId: string) {
  const row = await rowFor(id, profileId);
  if (row.state !== 'SCANNING') return collectPlanView(row);
  const lease = randomUUID(),
    now = Date.now();
  const acquired = await dbSupplier().execute(
    "UPDATE collect_plans SET lease_token=:lease,lease_until=:until WHERE id=:id AND profile_id=:profileId AND state='SCANNING' AND lease_until<:now",
    { lease, until: now + 60000, id, profileId, now }
  );
  if (!dbSupplier().getAffectedRows(acquired)) return collectPlanView(row);
  try {
    const leased = await rowFor(id, profileId);
    if (leased.lease_token !== lease || leased.state !== 'SCANNING')
      return collectPlanView(leased);
    const payload = data(leased);
    const current = await collectingService.analyze({
      ...payload.goal,
      recipient: payload.analysis.recipient ?? undefined
    });
    if (
      collectingStateHash(current) !== collectingStateHash(payload.analysis)
    ) {
      await dbSupplier().execute(
        "UPDATE collect_plans SET state='STALE',lease_token=NULL,lease_until=0 WHERE id=:id AND lease_token=:lease",
        { id, lease }
      );
      return readCollectPlan(id, profileId);
    }
    payload.analysis = current;
    const keys = payload.asset_keys.slice(
      payload.cursor,
      payload.cursor + BATCH_SIZE
    );
    const deadline = Date.now() + SCAN_BUDGET_MS;
    for (let index = 0; index < keys.length; index += 2) {
      const renewalTime = Date.now();
      const renewed = await dbSupplier().execute(
        'UPDATE collect_plans SET lease_until=:until WHERE id=:id AND lease_token=:lease AND lease_until>:now',
        { until: renewalTime + 60000, id, lease, now: renewalTime }
      );
      if (!dbSupplier().getAffectedRows(renewed)) lostScanLease();
      const batch = await Promise.allSettled(
        keys
          .slice(index, index + 2)
          .map((key) => candidatesFor(key, payload, deadline))
      );
      for (const item of batch) {
        if (item.status === 'rejected') payload.failed++;
        else if (item.value.length === 0) payload.unavailable++;
        else
          payload.candidates.push(
            ...item.value.slice(0, MAX_CANDIDATES - payload.candidates.length)
          );
      }
    }
    payload.cursor += keys.length;
    const state =
      payload.cursor >= payload.asset_keys.length ||
      payload.candidates.length >= MAX_CANDIDATES
        ? 'READY'
        : 'SCANNING';
    // Expiry permits takeover; the token is the commit fence. A late batch may
    // preserve its checkpoint only while no newer worker has acquired the row.
    const persisted = await dbSupplier().execute(
      'UPDATE collect_plans SET payload_json=:payload,state=:state,updated_at=:now,lease_token=NULL,lease_until=0 WHERE id=:id AND lease_token=:lease',
      { payload: JSON.stringify(payload), state, now: Date.now(), id, lease }
    );
    if (!dbSupplier().getAffectedRows(persisted)) lostScanLease();
    return readCollectPlan(id, profileId);
  } catch (error) {
    await dbSupplier().execute(
      'UPDATE collect_plans SET lease_token=NULL,lease_until=0 WHERE id=:id AND lease_token=:lease',
      { id, lease }
    );
    throw error;
  }
}
