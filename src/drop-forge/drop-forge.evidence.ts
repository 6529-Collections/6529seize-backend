import { DROP_FORGE_EVIDENCE_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
export async function evidenceForClaim(
  config: DropForgeConfig,
  claim: number,
  ctx: RequestContext
): Promise<Array<{ hash: string; action?: string }>> {
  const timer = 'DropForgeEvidence->hashes';
  ctx.timer?.start(timer);
  try {
    const rows = await sqlExecutor.execute<{
      hash: string;
      action: string | null;
    }>(
      `SELECT hash, action FROM ${DROP_FORGE_EVIDENCE_TABLE} WHERE contract = :contract AND claim_id = :claim AND chain_id = :chain`,
      { contract: config.creator.toLowerCase(), claim, chain: config.chainId },
      { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
    );
    return rows.map((row) => ({
      hash: row.hash,
      ...(row.action ? { action: row.action } : {})
    }));
  } finally {
    ctx.timer?.stop(timer);
  }
}
export async function storeEvidence(
  config: DropForgeConfig,
  claim: number,
  hash: string,
  action: string | undefined,
  ctx: RequestContext
): Promise<void> {
  const timer = 'DropForgeEvidence->store';
  ctx.timer?.start(timer);
  try {
    await sqlExecutor.execute(
      `INSERT IGNORE INTO ${DROP_FORGE_EVIDENCE_TABLE} (id,contract,claim_id,chain_id,hash,action) VALUES (:id,:contract,:claim,:chain,:hash,:action) ON DUPLICATE KEY UPDATE action = COALESCE(action, VALUES(action))`,
      {
        id: `${config.chainId}:${hash.toLowerCase()}`,
        contract: config.creator.toLowerCase(),
        claim,
        chain: config.chainId,
        hash,
        action: action ?? null
      },
      { wrappedConnection: ctx.connection }
    );
    const existing = await sqlExecutor.oneOrNull<{
      contract: string;
      claim_id: number;
      action: string | null;
    }>(
      `SELECT contract, claim_id, action FROM ${DROP_FORGE_EVIDENCE_TABLE} WHERE id = :id`,
      { id: `${config.chainId}:${hash.toLowerCase()}` },
      { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
    );
    if (
      !existing ||
      existing.contract.toLowerCase() !== config.creator.toLowerCase() ||
      Number(existing.claim_id) !== claim ||
      (existing.action && action && existing.action !== action)
    )
      throw new LaunchSafetyError(
        'Transaction evidence is already assigned to another claim or action'
      );
  } finally {
    ctx.timer?.stop(timer);
  }
}
