import type { Handler } from 'aws-lambda';
import { getDropForgeReportingConfig } from '@/drop-forge/drop-forge.config';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import {
  prepareDistributionPhase,
  finalizeDistribution
} from '@/drop-forge/drop-forge.preparation';
import { processStep } from '@/drop-forge/drop-forge.workflow';
import { reportPreparationJob } from '@/drop-forge/drop-forge.notifier';
import { evictRedisCacheForPathWithTimeout } from '@/redis';
import { wakeDropForge } from '@/drop-forge/drop-forge.wake';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import { wrapLambdaHandler } from '@/sentry.context';
const logger = Logger.get('DROP_FORGE_PREPARATION_LOOP');
export async function runPreparationTick(): Promise<void> {
  if (process.env.DROP_FORGE_PREPARATION_ENABLED !== 'true') return;
  const reporting = getDropForgeReportingConfig();
  let continuing = false;
  let completed: { contract: string; claim: number } | null = null;
  await dropForgeJobsRepository.processOne(async (job, ctx) => {
    if (job.kind === 'FINALIZE') {
      await finalizeDistribution(job.contract, job.claim_id, ctx);
      return { normalized: true };
    }
    const auth = process.env.DROP_FORGE_EMMA_AUTH_TOKEN?.trim();
    if (!auth)
      throw new LaunchSafetyError('EMMA service authentication is required');
    if (job.kind === 'PROCESS_ALL') {
      const result = await processStep(job, auth, ctx);
      continuing = result.continue;
      if (!continuing)
        completed = { contract: job.contract, claim: job.claim_id };
      return result;
    }
    if (!job.plan_id || !job.phase_id)
      throw new LaunchSafetyError('Phase identifiers are missing');
    return prepareDistributionPhase(
      job.contract,
      job.claim_id,
      job.plan_id,
      job.phase_id,
      auth,
      ctx
    );
  }, {});
  if (completed) {
    const scope = completed as { contract: string; claim: number };
    await Promise.allSettled([
      evictRedisCacheForPathWithTimeout({
        path: `/api/distributions/${scope.contract}/${scope.claim}/overview`
      })
    ]);
  }
  if (continuing) await wakeDropForge(true);
  if (!(await reportPreparationJob(reporting)))
    throw new Error('Preparation report delivery deferred');
}
const preparationHandler: Handler = async () =>
  doInDbContext(runPreparationTick, { logger });
export const handler = wrapLambdaHandler(preparationHandler);
