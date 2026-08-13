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

interface PublicAirdropCountRow {
  readonly spots_airdrop: NumericDatabaseValue;
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

      const [phaseAllocations, publicAirdropRow] = await Promise.all([
        this.db.execute<WalletPhaseAllocationDatabaseRow>(
          `SELECT canonical_phase AS phase,
                  COALESCE(SUM(count_airdrop), 0) AS spots_airdrop,
                  COALESCE(SUM(count_allowlist), 0) AS spots_allowlist
           FROM (
             SELECT CASE
                      WHEN LOWER(REPLACE(phase, ' ', '')) IN (:phase0Short, :phase0Compact) THEN :phase0
                      WHEN LOWER(REPLACE(phase, ' ', '')) IN (:phase1Short, :phase1Compact) THEN :phase1
                      WHEN LOWER(REPLACE(phase, ' ', '')) IN (:phase2Short, :phase2Compact) THEN :phase2
                    END AS canonical_phase,
                    count_airdrop,
                    count_allowlist
             FROM ${DISTRIBUTION_TABLE}
             WHERE LOWER(contract) = :contract
               AND card_id = :cardId
               AND LOWER(wallet) = :wallet
               AND LOWER(REPLACE(phase, ' ', '')) IN (
                 :phase0Short,
                 :phase0Compact,
                 :phase1Short,
                 :phase1Compact,
                 :phase2Short,
                 :phase2Compact
               )
           ) canonical_allocations
           GROUP BY canonical_phase
           ORDER BY CASE canonical_phase
             WHEN :phase0 THEN 0
             WHEN :phase1 THEN 1
             WHEN :phase2 THEN 2
             ELSE 3
           END`,
          {
            contract: normalizedContract,
            cardId,
            wallet: normalizedWallet,
            phase0: 'Phase 0',
            phase0Short: 'p0',
            phase0Compact: 'phase0',
            phase1: 'Phase 1',
            phase1Short: 'p1',
            phase1Compact: 'phase1',
            phase2: 'Phase 2',
            phase2Short: 'p2',
            phase2Compact: 'phase2'
          },
          queryOptions
        ),
        this.db.oneOrNull<PublicAirdropCountRow>(
          `SELECT COUNT(*) AS spots_airdrop
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
        phaseAllocations: phaseAllocations.map((allocation) => ({
          phase: allocation.phase,
          spots_airdrop: Number(allocation.spots_airdrop ?? 0),
          spots_allowlist: Number(allocation.spots_allowlist ?? 0)
        })),
        publicAirdropCount: Number(publicAirdropRow?.spots_airdrop ?? 0)
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const walletDistributionAllocationsDb =
  new WalletDistributionAllocationsDb(dbSupplier);
