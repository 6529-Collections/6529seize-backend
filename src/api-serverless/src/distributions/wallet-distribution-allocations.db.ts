import {
  DISTRIBUTION_NORMALIZED_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { ApiWalletDistributionAllocationPhaseEnum } from '@/api/generated/models/ApiWalletDistributionAllocation';
import { AllowlistNormalizedEntry } from '@/entities/IDistribution';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

type NumericDatabaseValue = number | string | null;

export interface WalletPhaseAllocationRow {
  readonly phase: string;
  readonly spots_airdrop: number;
  readonly spots_allowlist: number;
}

export interface WalletDistributionAllocationData {
  readonly hasDistribution: boolean;
  readonly phaseAllocations: WalletPhaseAllocationRow[];
  readonly publicAirdropCount: number;
}

interface DistributionExistsRow {
  readonly has_distribution: number | boolean;
}

interface WalletNormalizedDistributionRow {
  readonly allowlist: AllowlistNormalizedEntry[] | string | null;
}

interface PublicSubscriptionRow {
  readonly subscribed_count: NumericDatabaseValue;
}

const MANUAL_PHASE_BY_ALIAS = new Map<string, string>([
  ['p0', ApiWalletDistributionAllocationPhaseEnum.Phase0],
  ['phase0', ApiWalletDistributionAllocationPhaseEnum.Phase0],
  ['p1', ApiWalletDistributionAllocationPhaseEnum.Phase1],
  ['phase1', ApiWalletDistributionAllocationPhaseEnum.Phase1],
  ['p2', ApiWalletDistributionAllocationPhaseEnum.Phase2],
  ['phase2', ApiWalletDistributionAllocationPhaseEnum.Phase2]
]);

function normalizePhase(phase: string): string | null {
  const alias = phase.trim().toLowerCase().replace(/\s+/g, '');
  return MANUAL_PHASE_BY_ALIAS.get(alias) ?? null;
}

function aggregatePhaseAllocations(
  rows: AllowlistNormalizedEntry[]
): WalletPhaseAllocationRow[] {
  const allocations = new Map<string, WalletPhaseAllocationRow>();
  for (const row of rows) {
    const phase = normalizePhase(row.phase);
    if (!phase) {
      continue;
    }
    const current = allocations.get(phase);
    allocations.set(phase, {
      phase,
      spots_airdrop:
        (current?.spots_airdrop ?? 0) + Number(row.spots_airdrop ?? 0),
      spots_allowlist:
        (current?.spots_allowlist ?? 0) + Number(row.spots_allowlist ?? 0)
    });
  }
  return Array.from(allocations.values());
}

function isAllowlistEntry(value: unknown): value is AllowlistNormalizedEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<AllowlistNormalizedEntry>;
  return (
    typeof entry.phase === 'string' &&
    typeof entry.spots === 'number' &&
    typeof entry.spots_airdrop === 'number' &&
    typeof entry.spots_allowlist === 'number'
  );
}

function toAllowlistEntries(value: unknown): AllowlistNormalizedEntry[] {
  return Array.isArray(value) ? value.filter(isAllowlistEntry) : [];
}

function parseAllowlist(
  value: WalletNormalizedDistributionRow['allowlist']
): AllowlistNormalizedEntry[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return toAllowlistEntries(value);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return toAllowlistEntries(parsed);
  } catch {
    return [];
  }
}

export class WalletDistributionAllocationsDb extends LazyDbAccessCompatibleService {
  public async findByWallet(
    contract: string,
    cardId: number,
    wallet: string,
    ctx: RequestContext
  ): Promise<WalletDistributionAllocationData> {
    const timerName = `${this.constructor.name}->findByWallet`;
    try {
      ctx.timer?.start(timerName);
      const normalizedContract = contract.toLowerCase();
      const normalizedWallet = wallet.toLowerCase();
      const queryOptions = ctx.connection
        ? { wrappedConnection: ctx.connection }
        : undefined;
      const hasDistributionRow = await this.db.oneOrNull<DistributionExistsRow>(
        `SELECT EXISTS(
           SELECT 1
           FROM ${DISTRIBUTION_NORMALIZED_TABLE}
           WHERE LOWER(contract) = :contract
             AND card_id = :cardId
         ) AS has_distribution`,
        { contract: normalizedContract, cardId },
        queryOptions
      );
      const hasDistribution = Boolean(
        Number(hasDistributionRow?.has_distribution ?? 0)
      );

      if (!hasDistribution) {
        return {
          hasDistribution: false,
          phaseAllocations: [],
          publicAirdropCount: 0
        };
      }

      const [walletDistributionRow, publicSubscriptions] = await Promise.all([
        this.db.oneOrNull<WalletNormalizedDistributionRow>(
          `SELECT allowlist
           FROM ${DISTRIBUTION_NORMALIZED_TABLE}
           WHERE LOWER(contract) = :contract
             AND card_id = :cardId
             AND LOWER(wallet) = :wallet
           LIMIT 1`,
          {
            contract: normalizedContract,
            cardId,
            wallet: normalizedWallet
          },
          queryOptions
        ),
        this.db.execute<PublicSubscriptionRow>(
          `SELECT subscribed_count
           FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
           WHERE LOWER(contract) = :contract
             AND token_id = :cardId
             AND LOWER(airdrop_address) = :wallet
             AND phase = :publicPhase`,
          {
            contract: normalizedContract,
            cardId,
            wallet: normalizedWallet,
            publicPhase: 'Public'
          },
          queryOptions
        )
      ]);

      return {
        hasDistribution: true,
        phaseAllocations: aggregatePhaseAllocations(
          parseAllowlist(walletDistributionRow?.allowlist ?? null)
        ),
        // Finalization caps subscribed_count to the allocated edition
        // quantity; distribution export uses it as amount and redemption is
        // bounded by it.
        publicAirdropCount: publicSubscriptions.reduce(
          (total, row) => total + Number(row.subscribed_count ?? 0),
          0
        )
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const walletDistributionAllocationsDb =
  new WalletDistributionAllocationsDb(dbSupplier);
