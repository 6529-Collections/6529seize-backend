import {
  ApiWalletDistributionAllocation,
  ApiWalletDistributionAllocationPhaseEnum
} from '@/api/generated/models/ApiWalletDistributionAllocation';
import { ApiWalletDistributionAllocations } from '@/api/generated/models/ApiWalletDistributionAllocations';
import { RequestContext } from '@/request.context';
import {
  walletDistributionAllocationsDb,
  WalletPhaseAllocationRow
} from './wallet-distribution-allocations.db';

const PHASE_ORDER = [
  ApiWalletDistributionAllocationPhaseEnum.Phase0,
  ApiWalletDistributionAllocationPhaseEnum.Phase1,
  ApiWalletDistributionAllocationPhaseEnum.Phase2,
  ApiWalletDistributionAllocationPhaseEnum.Public
] as const;

const SUPPORTED_MANUAL_PHASES = new Set<string>(PHASE_ORDER.slice(0, 3));

function mapPhaseAllocation(
  row: WalletPhaseAllocationRow
): ApiWalletDistributionAllocation | null {
  if (!SUPPORTED_MANUAL_PHASES.has(row.phase)) {
    return null;
  }
  const allocation: ApiWalletDistributionAllocation = {
    phase: row.phase as ApiWalletDistributionAllocationPhaseEnum,
    spots_airdrop: Number(row.spots_airdrop ?? 0),
    spots_allowlist: Number(row.spots_allowlist ?? 0)
  };
  return allocation.spots_airdrop > 0 || allocation.spots_allowlist > 0
    ? allocation
    : null;
}

export async function getWalletDistributionAllocations(
  contract: string,
  cardId: number,
  wallet: string,
  ctx: RequestContext
): Promise<ApiWalletDistributionAllocations> {
  const data = await walletDistributionAllocationsDb.findByWallet(
    contract,
    cardId,
    wallet,
    ctx
  );

  if (!data.hasDistribution) {
    return { has_distribution: false, allocations: [] };
  }

  const allocations = data.phaseAllocations
    .map(mapPhaseAllocation)
    .filter(
      (allocation): allocation is ApiWalletDistributionAllocation =>
        allocation !== null
    );

  if (data.publicAirdropCount > 0) {
    allocations.push({
      phase: ApiWalletDistributionAllocationPhaseEnum.Public,
      spots_airdrop: data.publicAirdropCount,
      spots_allowlist: 0
    });
  }

  allocations.sort(
    (left, right) =>
      PHASE_ORDER.indexOf(left.phase) - PHASE_ORDER.indexOf(right.phase)
  );

  return { has_distribution: true, allocations };
}
