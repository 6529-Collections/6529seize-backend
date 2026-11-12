import {
  DISTRIBUTION_TABLE,
  DROP_FORGE_READINESS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';

interface ReadinessAllocation {
  phase: string;
  wallet: string;
  total: number;
}

const primary = { forcePool: DbPoolName.WRITE };

export function readinessMerkleRoots(contract: string, claim: number) {
  return sqlExecutor.execute<{ phase: string; merkle_root: string }>(
    `SELECT phase, merkle_root FROM ${MINTING_MERKLE_ROOTS_TABLE}
     WHERE contract = :contract AND card_id = :claim`,
    { contract: contract.toLowerCase(), claim },
    primary
  );
}

export async function readinessAllocations(contract: string, claim: number) {
  const params = { contract: contract.toLowerCase(), claim };
  return Promise.all([
    sqlExecutor.execute<ReadinessAllocation>(
      `SELECT phase, LOWER(wallet) AS wallet, SUM(count_airdrop) AS total
       FROM ${DISTRIBUTION_TABLE}
       WHERE contract = :contract AND card_id = :claim AND count_airdrop > 0
       GROUP BY phase, LOWER(wallet)`,
      params,
      primary
    ),
    sqlExecutor.execute<ReadinessAllocation>(
      `SELECT 'Public' AS phase, LOWER(airdrop_address) AS wallet, COUNT(*) AS total
       FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
       WHERE contract = :contract AND token_id = :claim
         AND (phase IS NULL OR phase = 'Public')
       GROUP BY LOWER(airdrop_address)`,
      params,
      primary
    )
  ]);
}

export async function recordReadinessCheck(
  id: string,
  post: (ctx: RequestContext) => Promise<{
    drop_id: string;
    pending_push_notification_ids: number[];
  } | null>
): Promise<number[]> {
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    await sqlExecutor.execute(
      `INSERT INTO ${DROP_FORGE_READINESS_TABLE} (id) VALUES (:id)
       ON DUPLICATE KEY UPDATE id = :id`,
      { id },
      options
    );
    const row = await sqlExecutor.oneOrNull<{ checked_at: number }>(
      `SELECT checked_at FROM ${DROP_FORGE_READINESS_TABLE} WHERE id = :id FOR UPDATE`,
      { id },
      options
    );
    if (Number(row?.checked_at) > 0) return [];
    const report = await post({ connection });
    await sqlExecutor.execute(
      `UPDATE ${DROP_FORGE_READINESS_TABLE}
       SET checked_at = :checkedAt, drop_id = :dropId WHERE id = :id`,
      { id, checkedAt: Date.now(), dropId: report?.drop_id ?? null },
      options
    );
    return report?.pending_push_notification_ids ?? [];
  });
}
