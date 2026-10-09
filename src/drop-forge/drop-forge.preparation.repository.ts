import {
  DROP_FORGE_LAUNCHES_TABLE,
  DROP_FORGE_PREPARATIONS_TABLE
} from '@/constants';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';

export interface PhasePreparationResult {
  phase: string;
  airdrops: Array<{ wallet: string; amount: number }>;
  airdrops_unconsolidated: Array<{ wallet: string; amount: number }>;
  allowlists: Array<{ wallet: string; amount: number }>;
}
export type PreparationResults = Record<string, PhasePreparationResult>;

export class DropForgePreparationRepository {
  async run<T>(
    contract: string,
    claim: number,
    fn: (results: PreparationResults, ctx: RequestContext) => Promise<T>,
    ctx: RequestContext
  ): Promise<T> {
    if (!ctx.connection)
      return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        this.run(contract, claim, fn, { ...ctx, connection })
      );
    const timer = 'DropForgePreparationRepository->run';
    ctx.timer?.start(timer);
    try {
      const id = `${contract.toLowerCase()}:${claim}`;
      await sqlExecutor.execute(
        `INSERT IGNORE INTO ${DROP_FORGE_PREPARATIONS_TABLE} (id,results) VALUES (:id, '{}')`,
        { id },
        { wrappedConnection: ctx.connection }
      );
      const stored = await sqlExecutor.oneOrNull<{
        results: string | PreparationResults;
      }>(
        `SELECT results FROM ${DROP_FORGE_PREPARATIONS_TABLE} WHERE id = :id FOR UPDATE`,
        { id },
        { wrappedConnection: ctx.connection }
      );
      if (!stored) throw new Error('Preparation lock missing');
      const launched = await sqlExecutor.execute(
        `SELECT id FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE LOWER(JSON_UNQUOTE(JSON_EXTRACT(data,'$.contract'))) = :contract AND JSON_EXTRACT(data,'$.claim_id') = :claim AND state <> 'DRAFT' LIMIT 1`,
        { contract: contract.toLowerCase(), claim },
        { wrappedConnection: ctx.connection }
      );
      if (launched.length)
        throw new LaunchSafetyError(
          'Distribution is frozen for an armed or terminal launch'
        );
      const results =
        typeof stored.results === 'string'
          ? (JSON.parse(stored.results) as PreparationResults)
          : stored.results;
      const result = await fn(results, ctx);
      await sqlExecutor.execute(
        `UPDATE ${DROP_FORGE_PREPARATIONS_TABLE} SET results = :results WHERE id = :id`,
        { id, results: JSON.stringify(results) },
        { wrappedConnection: ctx.connection }
      );
      return result;
    } finally {
      ctx.timer?.stop(timer);
    }
  }
}
export const dropForgePreparationRepository =
  new DropForgePreparationRepository();
export async function resetDistributionPreparation(
  contract: string,
  claim: number,
  reset: (ctx: RequestContext) => Promise<void>,
  ctx: RequestContext = {}
): Promise<void> {
  await dropForgePreparationRepository.run(
    contract,
    claim,
    async (results, txCtx) => {
      await reset(txCtx);
      for (const key of Object.keys(results)) delete results[key];
    },
    ctx
  );
}
