import type { SQSHandler } from 'aws-lambda';
import { getDropForgeReportingConfig } from '@/drop-forge/drop-forge.config';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import {
  prepareDistributionPhase,
  finalizeDistribution
} from '@/drop-forge/drop-forge.preparation';
import {
  processStep,
  decodeProcessResult
} from '@/drop-forge/drop-forge.workflow';
import {
  decryptPreparationAuth,
  withPreparationAuth
} from '@/drop-forge/drop-forge.preparation-auth';
import { reportPreparationJob } from '@/drop-forge/drop-forge.notifier';
import { evictRedisCacheForPathWithTimeout } from '@/redis';
import {
  wakeDropForge,
  ForgeDelivery,
  consumeForgeDelivery
} from '@/drop-forge/drop-forge.wake';
import {
  launchWatchdog,
  removeLaunchWatchdog
} from '@/drop-forge/drop-forge.dispatch';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { RequestContext } from '@/request.context';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import { wrapLambdaHandler } from '@/sentry.context';
const logger = Logger.get('MEMES_DISTRIBUTION_HANDLER');
async function processPreparationJob(
  job: DropForgeJobEntity,
  ctx: RequestContext
): Promise<object> {
  if (job.kind === 'FINALIZE') {
    await finalizeDistribution(job.contract, job.claim_id, ctx);
    return { normalized: true };
  }
  const needsAuth =
    job.kind === 'PROCESS_ALL'
      ? !decodeProcessResult(job)?.inputs
      : job.phase_id !== 'public';
  const auth = needsAuth ? decryptPreparationAuth(job) : '';
  if (job.kind === 'PROCESS_ALL')
    return withPreparationAuth(() => processStep(job, auth, ctx));
  if (!job.plan_id || !job.phase_id)
    throw new LaunchSafetyError('Phase identifiers are missing');
  const planId = job.plan_id;
  const phaseId = job.phase_id;
  return withPreparationAuth(() =>
    prepareDistributionPhase(
      job.contract,
      job.claim_id,
      planId,
      phaseId,
      auth,
      ctx
    )
  );
}
export async function runPreparationJob(
  delivery: ForgeDelivery
): Promise<void> {
  if (process.env.DROP_FORGE_PREPARATION_ENABLED !== 'true')
    throw new Error(
      'Distribution processing is disabled; queued work retained'
    );
  const current = await dropForgeJobsRepository.find(delivery.id, {});
  if (Number(current.dispatch_revision) < delivery.revision)
    throw new Error('Distribution request has not committed');
  if (delivery.step !== undefined && Number(current.step) > delivery.step)
    return;
  const reporting = getDropForgeReportingConfig();
  const watchdog =
    current.status === 'PENDING'
      ? await launchWatchdog(
          { ...delivery, step: Number(current.step) },
          Math.floor(Date.now() / 1000),
          true
        )
      : null;
  try {
    await dropForgeJobsRepository.processOne(
      processPreparationJob,
      {},
      delivery.id
    );
    const updated = await dropForgeJobsRepository.find(delivery.id, {});
    if (updated.status === 'PENDING')
      await wakeDropForge(
        { id: updated.id, revision: Number(updated.dispatch_revision) },
        true
      );
    if (updated.kind === 'PROCESS_ALL' && updated.status === 'COMPLETED') {
      await evictRedisCacheForPathWithTimeout({
        path: `/api/distributions/${updated.contract}/${updated.claim_id}/overview`
      });
    }
    if (!(await reportPreparationJob(reporting, delivery.id)))
      throw new Error('Preparation report delivery deferred');
  } finally {
    if (watchdog) await removeLaunchWatchdog(current.id, watchdog);
  }
}
const preparationHandler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await consumeForgeDelivery(record, true, (delivery) =>
      doInDbContext(() => runPreparationJob(delivery), { logger })
    );
  }
};
export const handler = wrapLambdaHandler(preparationHandler);
