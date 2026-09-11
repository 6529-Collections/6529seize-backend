import { collectingService } from '@/collecting/collecting.service';
import { collectingDb } from '@/collecting/collecting.db';
import { CollectingFamily } from '@/collecting/collecting.types';
import { CollectingQuotedTdhCandidate } from '@/collecting/collecting-tdh-ranking';
import { marketplaceProvider } from '@/api/marketplace/marketplace.service';
import { marketChain } from '@/marketplace/market-chain';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';
import { CustomApiCompliantException } from '@/exceptions';
import { collectPlanRankingCandidates } from './collect-plans.service';

export async function discoverCollectListings(
  family: CollectingFamily,
  limit: number,
  cursor?: string
) {
  const catalog = await collectingService.getCatalog();
  const assets = catalog.assets.filter((asset) => asset.family === family);
  if (!assets.length)
    return {
      entries: [],
      next: null,
      source: 'OpenSea',
      observed_at: new Date().toISOString(),
      received_count: 0,
      complete: false
    };
  const byId = new Map(assets.map((asset) => [asset.token_id, asset]));
  const page = await marketplaceProvider().discoverCollectionListings(
    assets[0].contract,
    limit,
    cursor
  );
  const entries = page.listings.flatMap((order) => {
    const asset = byId.get(order.asset.tokenId);
    return asset ? [{ asset, order }] : [];
  });
  return {
    entries,
    next: page.next,
    source: 'OpenSea',
    observed_at: page.coverage.observedAt,
    received_count: page.coverage.receivedCount,
    complete: false
  };
}

export async function collectGasReserve() {
  const fee = await marketChain().rpc.getFeeData();
  if (fee.maxFeePerGas === null)
    throw new CustomApiCompliantException(
      503,
      'A gas estimate is unavailable.'
    );
  return fee.maxFeePerGas * BigInt(450000);
}

async function rankingCandidates(
  family: CollectingFamily,
  profileId: string,
  recipient: string
) {
  const [page, scope, gas] = await Promise.all([
    discoverCollectListings(family, 24),
    collectingDb.readAccountHoldings(profileId),
    collectGasReserve()
  ]);
  const eligible = page.entries.filter(
    ({ asset, order }) =>
      asset.tdh_eligible &&
      order.currency === MARKET_ZERO_ADDRESS &&
      !scope.account.wallets.includes(order.maker.toLowerCase())
  );
  const result: CollectingQuotedTdhCandidate[] = [];
  for (const { asset, order } of eligible) {
    // The provider validated every signed item while discovering this page.
    // A unit quote exists only when partial fulfillment and each fee divide exactly.
    const quantity = order.unitTotalWei === undefined ? order.quantity : '1';
    if (BigInt(quantity) > BigInt(9999)) continue;
    result.push({
      candidate_id: order.identity.orderHash,
      total_cost_wei: (
        BigInt(order.unitTotalWei ?? order.totalWei) + gas
      ).toString(),
      valid_until: new Date(Number(order.endTime) * 1000).toISOString(),
      acquisitions: [{ asset_key: asset.asset_key, quantity, recipient }]
    });
  }
  return result;
}

export async function rankCollectPurchases(input: {
  profile_id: string;
  family: CollectingFamily;
  recipient: string;
  horizon_days: 1 | 30 | 90 | 365;
  plan_id?: string;
}) {
  const candidates = input.plan_id
    ? await collectPlanRankingCandidates(
        input.plan_id,
        input.profile_id,
        input.recipient
      )
    : await rankingCandidates(input.family, input.profile_id, input.recipient);
  const result = await collectingService.rankTdhPurchases(input, candidates);
  const byId = new Map(
    candidates.map((candidate) => [
      candidate.candidate_id,
      candidate.acquisitions
    ])
  );
  return {
    ...result,
    ranked: result.ranked.map((item) => ({
      ...item,
      acquisitions: byId.get(item.candidate_id) ?? []
    })),
    assumptions: [
      'Best cost per additional TDH among the observed candidates; market coverage is incomplete.',
      'Costs include signed listing fees and an estimated gas reserve. Every purchase needs a fresh executable quote.',
      'TDH uses the official rules and a verified snapshot. Future holdings, supply and rules may change.',
      'A gift outside this profile does not add TDH to this profile.'
    ]
  };
}
