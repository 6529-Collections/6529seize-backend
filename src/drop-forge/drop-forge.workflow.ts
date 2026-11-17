import {
  fetchDistributionPhases,
  fetchPhaseResults,
  validateDistribution
} from '@/api/subscriptions/api.subscriptions.allowlist';
import {
  canonicalMemePhaseName,
  MEME_EMMA_PHASES
} from '@/drop-forge/drop-forge.emma-phases';
import { createHash } from 'node:crypto';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import {
  dropForgePreparationRepository,
  PhasePreparationResult
} from '@/drop-forge/drop-forge.preparation.repository';
import {
  prepareDistributionPhase,
  finalizeDistribution
} from '@/drop-forge/drop-forge.preparation';
import {
  LaunchSafetyError,
  DistributionRow
} from '@/drop-forge/drop-forge.types';
import { DISTRIBUTION_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { DbPoolName } from '@/db-query.options';
import { encryptPreparationAuth } from '@/drop-forge/drop-forge.preparation-auth';

export interface ProcessResult {
  continue: boolean;
  inputs?: Record<
    string,
    { name: string; rows: Awaited<ReturnType<typeof fetchPhaseResults>> }
  >;
  lists: Record<string, PhasePreparationResult>;
  distribution_hash?: string;
}
export function decodeProcessResult(
  job: DropForgeJobEntity
): ProcessResult | null {
  if (!job.result) return null;
  const result =
    typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
  return result as ProcessResult;
}
export function phaseIds(job: DropForgeJobEntity): string[] {
  return typeof job.phase_ids === 'string'
    ? JSON.parse(job.phase_ids)
    : (job.phase_ids ?? []);
}
export async function distributionHash(
  contract: string,
  claim: number,
  ctx: RequestContext
): Promise<string> {
  const timer = 'DropForgeWorkflow->distributionHash';
  ctx.timer?.start(timer);
  try {
    const rows = await sqlExecutor.execute<DistributionRow>(
      `SELECT phase, wallet, count, count_airdrop, count_allowlist FROM ${DISTRIBUTION_TABLE} WHERE contract = :contract AND card_id = :claim ORDER BY phase, wallet`,
      { contract: contract.toLowerCase(), claim },
      { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
    );
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } finally {
    ctx.timer?.stop(timer);
  }
}
export async function createProcess(
  job: DropForgeJobEntity,
  ctx: RequestContext,
  authorization: string
): Promise<DropForgeJobEntity> {
  return dropForgePreparationRepository.run(
    job.contract,
    job.claim_id,
    async (_, txCtx) => {
      const existing = await dropForgeJobsRepository.latest(
        job.contract,
        job.claim_id,
        undefined,
        txCtx
      );
      if (
        existing &&
        ['PENDING', 'COMPLETED', 'AWAITING_AUTH'].includes(existing.status)
      ) {
        if (
          existing.plan_id !== job.plan_id ||
          JSON.stringify(phaseIds(existing)) !== JSON.stringify(job.phase_ids)
        )
          throw new LaunchSafetyError(
            'A different processing operation exists; reset the distribution before changing its inputs'
          );
        if (
          existing.status === 'COMPLETED' &&
          decodeProcessResult(existing)?.distribution_hash !==
            (await distributionHash(job.contract, job.claim_id, txCtx))
        )
          throw new LaunchSafetyError(
            'Distribution changed after processing; reset and process again'
          );
        if (existing.status === 'AWAITING_AUTH')
          return dropForgeJobsRepository.resumeAuthentication(
            existing,
            encryptPreparationAuth(existing, authorization),
            txCtx
          );
        return existing;
      }
      job.encrypted_auth = encryptPreparationAuth(job, authorization);
      return dropForgeJobsRepository.create(job, txCtx);
    },
    ctx,
    true,
    false,
    'BACKGROUND'
  );
}
export async function processStep(
  job: DropForgeJobEntity,
  auth: string,
  ctx: RequestContext
): Promise<ProcessResult> {
  const ids = [...phaseIds(job), 'public'];
  const plan = job.plan_id;
  if (!plan || ids.length !== 4)
    throw new LaunchSafetyError(
      'Processing requires the three ordered EMMA phase IDs'
    );
  const step = Number(job.step);
  const result: ProcessResult = decodeProcessResult(job) ?? {
    continue: true,
    lists: {}
  };
  if (step === 0 && !result.inputs) {
    const [valid, phases] = await Promise.all([
      validateDistribution(auth, plan, undefined, 'background'),
      fetchDistributionPhases(auth, plan, 'background')
    ]);
    if (!valid.valid)
      throw new LaunchSafetyError(
        valid.statusText ?? 'EMMA phases are not ready'
      );
    const selected = MEME_EMMA_PHASES.map((expected, index) => {
      const matches = phases.filter(
        ({ name }) => canonicalMemePhaseName(name) === expected
      );
      if (matches.length === 0)
        throw new LaunchSafetyError(`Missing ${expected} in this EMMA plan`);
      if (matches.length > 1)
        throw new LaunchSafetyError(
          `Multiple phases match ${expected}. Rename the duplicates in EMMA`
        );
      if (matches[0].id !== ids[index])
        throw new LaunchSafetyError(
          `${expected} no longer matches the selected phase. Refresh the EMMA plan and try again`
        );
      return matches[0];
    });
    const captured = await Promise.all(
      selected.map(async ({ id, name }) => {
        const rows = await fetchPhaseResults(auth, plan, id, 'background');
        return [id, { name, rows }] as const;
      })
    );
    result.inputs = Object.fromEntries(captured);
    if (Buffer.byteLength(JSON.stringify(result.inputs)) > 16 * 1024 * 1024)
      throw new LaunchSafetyError(
        'EMMA input snapshot exceeds the 16 MiB processing limit'
      );
  }
  if (step > 0 && !result.inputs)
    throw new LaunchSafetyError(
      'Processing snapshot is missing; restart the operation'
    );
  if (step < ids.length) {
    const prepared = await prepareDistributionPhase(
      job.contract,
      job.claim_id,
      plan,
      ids[step],
      auth,
      ctx,
      ids[step] === 'public'
        ? { name: 'Public', rows: [] }
        : result.inputs?.[ids[step]]
    );
    const expected = step === 3 ? 'Public' : MEME_EMMA_PHASES[step];
    if ((canonicalMemePhaseName(prepared.phase) ?? prepared.phase) !== expected)
      throw new LaunchSafetyError(
        `Expected ${expected}; EMMA phases must be processed in Phase 0, Phase 1, Phase 2 order`
      );
    return {
      ...result,
      continue: true,
      lists: { ...result.lists, [ids[step]]: prepared }
    };
  }
  if (step !== ids.length || Object.keys(result.lists).length !== ids.length)
    throw new LaunchSafetyError('Processing checkpoints are incomplete');
  await finalizeDistribution(job.contract, job.claim_id, ctx);
  return {
    ...result,
    continue: false,
    distribution_hash: await distributionHash(job.contract, job.claim_id, ctx)
  };
}
export async function assertCompletedProcessUnchanged(
  contract: string,
  claim: number,
  ctx: RequestContext
): Promise<void> {
  const job = await dropForgeJobsRepository.latest(
    contract,
    claim,
    undefined,
    ctx
  );
  if (
    job?.status === 'COMPLETED' &&
    decodeProcessResult(job)?.distribution_hash !==
      (await distributionHash(contract, claim, ctx))
  )
    throw new LaunchSafetyError(
      'Distribution changed after processing; reset and finalize again before launching'
    );
}
