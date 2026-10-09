import type { Handler } from 'aws-lambda';
import {
  automationEnabled,
  getDropForgeConfig,
  getDropForgeReportingConfig
} from '@/drop-forge/drop-forge.config';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import {
  finalizeDistribution,
  prepareDistributionPhase
} from '@/drop-forge/drop-forge.preparation';
import { dropForgeRepository } from '@/drop-forge/drop-forge.repository';
import {
  reportLaunchEvents,
  reportPreparationJob
} from '@/drop-forge/drop-forge.notifier';
import { DropForgeWorker } from '@/drop-forge/drop-forge.worker';
import { KmsTransactionSigner } from '@/drop-forge/kms-signer';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import { wrapLambdaHandler } from '@/sentry.context';

const logger = Logger.get('DROP_FORGE_LAUNCH_LOOP');
export async function runDropForgeTick(): Promise<void> {
  const preparationEnabled =
    process.env.DROP_FORGE_PREPARATION_ENABLED === 'true';
  if (!automationEnabled() && !preparationEnabled) return;
  // Validate reporting before any new preparation or signing work. Durable
  // outboxes retry independently of transaction reconciliation.
  const reporting = getDropForgeReportingConfig();
  let reportsDelivered = true;
  if (automationEnabled()) {
    const config = getDropForgeConfig();
    reportsDelivered = await reportLaunchEvents(config, dropForgeRepository);
    const worker = new DropForgeWorker(
      config,
      dropForgeRepository,
      new EthereumLaunchChain(config),
      new KmsTransactionSigner(config.keyId, config.signer)
    );
    await worker.tick();
    const delivered = await reportLaunchEvents(config, dropForgeRepository);
    reportsDelivered = delivered && reportsDelivered;
  }
  if (preparationEnabled) {
    await dropForgeJobsRepository.processOne(async (job, ctx) => {
      if (job.kind === 'FINALIZE') {
        await finalizeDistribution(job.contract, job.claim_id, ctx);
        return { normalized: true };
      }
      const auth = process.env.DROP_FORGE_EMMA_AUTH_TOKEN?.trim();
      if (!auth)
        throw new LaunchSafetyError(
          'DROP_FORGE_EMMA_AUTH_TOKEN is required for EMMA preparation'
        );
      if (!job.plan_id || !job.phase_id)
        throw new LaunchSafetyError('Phase job has incomplete identifiers');
      return prepareDistributionPhase(
        job.contract,
        job.claim_id,
        job.plan_id,
        job.phase_id,
        auth,
        ctx
      );
    }, {});
    const delivered = await reportPreparationJob(reporting);
    reportsDelivered = delivered && reportsDelivered;
  }
  // Surface a failed wave outbox to the invocation-error alarm only after
  // reconciling any outstanding transaction. The durable outbox retries later.
  if (!reportsDelivered)
    throw new Error(
      'Drop Forge wave delivery deferred; check reporting permissions'
    );
}
const dropForgeHandler: Handler = async () =>
  doInDbContext(runDropForgeTick, { logger });
export const handler = wrapLambdaHandler(dropForgeHandler);
