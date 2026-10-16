import type { Handler } from 'aws-lambda';
import {
  automationEnabled,
  recoveryEnabled,
  getDropForgeConfig
} from '@/drop-forge/drop-forge.config';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import { dropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { reportLaunchEvents } from '@/drop-forge/drop-forge.notifier';
import { DropForgeWorker } from '@/drop-forge/drop-forge.worker';
import { KmsTransactionSigner } from '@/drop-forge/kms-signer';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import { wrapLambdaHandler } from '@/sentry.context';

const logger = Logger.get('DROP_FORGE_LAUNCH_LOOP');
export async function runDropForgeTick(): Promise<void> {
  if (!recoveryEnabled()) return;
  // Validate reporting before any new preparation or signing work. Durable
  // outboxes retry independently of transaction reconciliation.
  let reportsDelivered = true;
  if (recoveryEnabled()) {
    const config = getDropForgeConfig();
    reportsDelivered = await reportLaunchEvents(config, dropForgeRepository);
    const worker = new DropForgeWorker(
      config,
      dropForgeRepository,
      new EthereumLaunchChain(config),
      new KmsTransactionSigner(config.keyId, config.signer),
      automationEnabled()
    );
    // A reservation report must commit before signing. Drain that boundary in
    // this invocation instead of losing another scheduler interval per intent.
    for (let cycle = 0; cycle < 3; cycle++) {
      await worker.tick();
      const delivered = await reportLaunchEvents(config, dropForgeRepository);
      reportsDelivered = delivered && reportsDelivered;
      if (!delivered) break;
    }
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
