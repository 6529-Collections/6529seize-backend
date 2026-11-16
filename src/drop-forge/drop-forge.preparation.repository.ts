import { findDropForgePolicy } from '@/drop-forge/drop-forge.policy';
import { readForgeSettings } from '@/drop-forge/drop-forge.settings';
import {
  DROP_FORGE_LAUNCHES_TABLE,
  DROP_FORGE_JOBS_TABLE,
  DROP_FORGE_PREPARATIONS_TABLE,
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  MEMES_CONTRACT,
  MINTING_MERKLE_ROOTS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { BadRequestException } from '@/exceptions';
import {
  dropForgeJobsRepository,
  resetJobError
} from '@/drop-forge/drop-forge.jobs.repository';
import { DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES } from '@/airdrop-phases';
import {
  DropForgeJobEntity,
  DropForgePreparationMode
} from '@/entities/IDropForgeLaunch';
import { DbPoolName } from '@/db-query.options';
import { launchId } from '@/drop-forge/drop-forge.repository';

export interface PhasePreparationResult {
  source_hash?: string;
  phase: string;
  airdrops: Array<{ wallet: string; amount: number }>;
  airdrops_unconsolidated: Array<{ wallet: string; amount: number }>;
  allowlists: Array<{ wallet: string; amount: number }>;
}
export type PreparationResults = Record<string, PhasePreparationResult>;

type PreparationStart = Exclude<DropForgePreparationMode, 'UNSTARTED'>;

export class DropForgePreparationRepository {
  async readMode(
    contract: string,
    claim: number,
    ctx: RequestContext = {}
  ): Promise<DropForgePreparationMode> {
    const normalized = contract.toLowerCase();
    const row = await sqlExecutor.oneOrNull<{ mode: DropForgePreparationMode }>(
      `SELECT COALESCE(
        (SELECT mode FROM ${DROP_FORGE_PREPARATIONS_TABLE} WHERE id = :id),
        CASE
          WHEN EXISTS (
            SELECT 1 FROM ${DROP_FORGE_JOBS_TABLE}
            WHERE contract = :contract AND claim_id = :claim
              AND (error IS NULL OR error <> :resetJobError)
          ) THEN 'BACKGROUND'
          WHEN EXISTS (
            SELECT 1 FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
            WHERE contract = :contract AND token_id = :claim AND phase IS NOT NULL
          ) OR EXISTS (
            SELECT 1 FROM ${DISTRIBUTION_TABLE}
            WHERE contract = :contract AND card_id = :claim AND phase NOT IN (:airdropPhases)
          ) OR EXISTS (
            SELECT 1 FROM ${MINTING_MERKLE_ROOTS_TABLE}
            WHERE contract = :contract AND card_id = :claim
          ) OR EXISTS (
            SELECT 1 FROM ${DISTRIBUTION_NORMALIZED_TABLE}
            WHERE contract = :contract AND card_id = :claim
          ) THEN 'MANUAL'
          ELSE 'UNSTARTED'
        END
      ) AS mode`,
      {
        id: `${normalized}:${claim}`,
        contract: normalized,
        claim,
        airdropPhases: [...DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES],
        resetJobError
      },
      { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
    );
    return row?.mode ?? 'UNSTARTED';
  }

  private async start(
    contract: string,
    claim: number,
    mode: PreparationStart,
    ctx: RequestContext
  ): Promise<void> {
    const current = await this.readMode(contract, claim, ctx);
    if (current !== mode && current !== 'UNSTARTED')
      throw new BadRequestException(
        current === 'MANUAL'
          ? 'This distribution is using manual preparation. Reset Subscriptions before starting background preparation.'
          : 'This distribution is using background preparation. Reset Subscriptions before starting manual preparation.'
      );
    const policy = findDropForgePolicy();
    if (
      current === 'UNSTARTED' &&
      mode === 'MANUAL' &&
      policy &&
      [MEMES_CONTRACT.toLowerCase(), policy.creator.toLowerCase()].includes(
        contract.toLowerCase()
      ) &&
      (await readForgeSettings(policy, ctx)).preparation_enabled
    )
      throw new BadRequestException(
        'EMMA preparation is On. Refresh this plan and use Process and Finalize.'
      );
    await sqlExecutor.execute(
      `UPDATE ${DROP_FORGE_PREPARATIONS_TABLE} SET mode = :mode WHERE id = :id AND (mode IS NULL OR mode = 'UNSTARTED')`,
      { id: `${contract.toLowerCase()}:${claim}`, mode },
      { wrappedConnection: ctx.connection }
    );
  }

  async findResult(
    contract: string,
    claim: number,
    key: string,
    ctx: RequestContext
  ): Promise<PhasePreparationResult | null> {
    const timer = 'DropForgePreparationRepository->findResult';
    ctx.timer?.start(timer);
    try {
      const row = await sqlExecutor.oneOrNull<{
        results: string | PreparationResults;
      }>(
        `SELECT results FROM ${DROP_FORGE_PREPARATIONS_TABLE} WHERE id = :id`,
        { id: `${contract.toLowerCase()}:${claim}` },
        // This pre-lock cache probe must not establish an outer job's snapshot
        // before network work and acquisition of the preparation lock.
        { forcePool: DbPoolName.WRITE }
      );
      if (!row) return null;
      const results =
        typeof row.results === 'string'
          ? (JSON.parse(row.results) as PreparationResults)
          : row.results;
      return results[key] ?? null;
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async run<T>(
    contract: string,
    claim: number,
    fn: (results: PreparationResults, ctx: RequestContext) => Promise<T>,
    ctx: RequestContext,
    allowPending = false,
    allowArmedRead = false,
    startMode?: PreparationStart
  ): Promise<T> {
    if (!ctx.connection)
      return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        this.run(
          contract,
          claim,
          fn,
          { ...ctx, connection },
          allowPending,
          allowArmedRead,
          startMode
        )
      );
    const timer = 'DropForgePreparationRepository->run';
    ctx.timer?.start(timer);
    try {
      const id = `${contract.toLowerCase()}:${claim}`;
      await sqlExecutor.execute(
        `INSERT INTO ${DROP_FORGE_PREPARATIONS_TABLE} (id,results) VALUES (:id, '{}') ON DUPLICATE KEY UPDATE id = :id`,
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
      // Locking reads observe a concurrently committed ARM even when an outer
      // job transaction already established a repeatable-read snapshot.
      const launches = await sqlExecutor.execute<{ state: string }>(
        `SELECT state FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE id IN (:ids) FOR UPDATE`,
        {
          ids: [
            launchId(1, contract, claim),
            launchId(11155111, contract, claim)
          ]
        },
        { wrappedConnection: ctx.connection }
      );
      if (
        !allowArmedRead &&
        launches.some((launch) => launch.state !== 'DRAFT')
      )
        throw new LaunchSafetyError(
          'Distribution is frozen for an armed or terminal launch'
        );
      if (!allowPending) {
        const pending = await sqlExecutor.execute<{ id: string }>(
          `SELECT id FROM ${DROP_FORGE_JOBS_TABLE} WHERE contract = :contract AND claim_id = :claim AND kind = 'PROCESS_ALL' AND status IN ('PENDING', 'AWAITING_AUTH') FOR SHARE NOWAIT`,
          { contract: contract.toLowerCase(), claim },
          { wrappedConnection: ctx.connection }
        );
        const ownJob = (ctx as RequestContext & { dropForgeJobId?: string })
          .dropForgeJobId;
        if (pending.some((job) => job.id !== ownJob))
          throw new LaunchSafetyError(
            'Distribution processing is in progress; wait for completion before changing inputs'
          );
      }
      const results =
        typeof stored.results === 'string'
          ? (JSON.parse(stored.results) as PreparationResults)
          : stored.results;
      if (startMode) await this.start(contract, claim, startMode, ctx);
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
  const policy = findDropForgePolicy();
  const canResetPaused =
    policy !== null &&
    !(await readForgeSettings(policy, ctx)).preparation_enabled;
  await dropForgePreparationRepository.run(
    contract,
    claim,
    async (results, txCtx) => {
      // The worker takes the job lock before the preparation lock. Fail fast
      // if it is finishing a step; an idle job can be reset atomically.
      let pending: { id: string }[];
      try {
        pending = await sqlExecutor.execute<{ id: string }>(
          `SELECT id FROM ${DROP_FORGE_JOBS_TABLE} WHERE contract = :contract AND claim_id = :claim AND status IN ('PENDING', 'AWAITING_AUTH') FOR UPDATE NOWAIT`,
          { contract: contract.toLowerCase(), claim },
          { wrappedConnection: txCtx.connection }
        );
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          (('errno' in error && error.errno === 3572) ||
            ('code' in error && error.code === 'ER_LOCK_NOWAIT'))
        )
          throw new LaunchSafetyError(
            'Distribution processing is finishing a step; retry the reset shortly'
          );
        throw error;
      }
      if (!canResetPaused && pending.length)
        throw new LaunchSafetyError(
          'Distribution processing is in progress; wait for completion before resetting'
        );
      await reset(txCtx);
      for (const key of Object.keys(results)) delete results[key];
      await sqlExecutor.execute(
        `UPDATE ${DROP_FORGE_JOBS_TABLE} SET status = 'FAILED', error = :resetJobError, encrypted_auth = NULL, drop_id = NULL WHERE contract = :contract AND claim_id = :claim AND status <> 'FAILED'`,
        { contract: contract.toLowerCase(), claim, resetJobError },
        { wrappedConnection: txCtx.connection }
      );
      await sqlExecutor.execute(
        `UPDATE ${DROP_FORGE_PREPARATIONS_TABLE} SET mode = 'UNSTARTED' WHERE id = :id`,
        { id: `${contract.toLowerCase()}:${claim}` },
        { wrappedConnection: txCtx.connection }
      );
      const reports = await sqlExecutor.execute<DropForgeJobEntity>(
        `SELECT * FROM ${DROP_FORGE_JOBS_TABLE} WHERE contract = :contract AND claim_id = :claim AND drop_id IS NULL AND status <> 'PENDING'`,
        { contract: contract.toLowerCase(), claim },
        { wrappedConnection: txCtx.connection }
      );
      await reports.reduce<Promise<void>>(
        (previous, job) =>
          previous.then(() => dropForgeJobsRepository.dispatch(job, txCtx)),
        Promise.resolve()
      );
    },
    ctx,
    true
  );
}
