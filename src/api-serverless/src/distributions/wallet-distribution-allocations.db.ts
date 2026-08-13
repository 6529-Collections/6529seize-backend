import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

type NumericDatabaseValue = number | string | null;

interface WalletPhaseAllocationDatabaseRow {
  readonly phase: string;
  readonly spots_airdrop: NumericDatabaseValue;
  readonly spots_allowlist: NumericDatabaseValue;
}

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

interface PublicSubscriptionRow {
  readonly subscribed_count: NumericDatabaseValue;
}

const MANUAL_PHASE_ALIASES = [
  { phase: 'Phase 0', short: 'p0', compact: 'phase0' },
  { phase: 'Phase 1', short: 'p1', compact: 'phase1' },
  { phase: 'Phase 2', short: 'p2', compact: 'phase2' }
] as const;

const MANUAL_PHASE_BY_ALIAS = new Map<string, string>(
  MANUAL_PHASE_ALIASES.flatMap(({ phase, short, compact }) => [
    [short, phase],
    [compact, phase]
  ])
);

function normalizePhase(phase: string): string | null {
  const alias = phase.trim().toLowerCase().replace(/\s+/g, '');
  return MANUAL_PHASE_BY_ALIAS.get(alias) ?? null;
}

function aggregatePhaseAllocations(
  rows: WalletPhaseAllocationDatabaseRow[]
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

      const [phaseAllocations, publicSubscriptions] = await Promise.all([
        this.db.execute<WalletPhaseAllocationDatabaseRow>(
          `SELECT phase,
                  COALESCE(SUM(count_airdrop), 0) AS spots_airdrop,
                  COALESCE(SUM(count_allowlist), 0) AS spots_allowlist
           FROM ${DISTRIBUTION_TABLE}
           WHERE LOWER(contract) = :contract
             AND card_id = :cardId
             AND LOWER(wallet) = :wallet
           GROUP BY phase`,
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
        phaseAllocations: aggregatePhaseAllocations(phaseAllocations),
        // Finalized subscribed_count is the allocated edition quantity used by
        // distribution exports and bounded by redeemed_count during minting.
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
