import type { SQSHandler } from 'aws-lambda';
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
import {
  ForgeDelivery,
  consumeForgeDelivery
} from '@/drop-forge/drop-forge.wake';
import {
  scheduleLaunchGroups,
  launchWatchdog,
  removeLaunchWatchdog,
  continueLaunch
} from '@/drop-forge/drop-forge.dispatch';
import { Logger } from '@/logging';
import { readForgeSettings } from '@/drop-forge/drop-forge.settings';
import { processForgeFunding } from '@/drop-forge/drop-forge.funding';
import { doInDbContext } from '@/secrets';
import { wrapLambdaHandler } from '@/sentry.context';
import { recordPostMintPreview } from '@/drop-forge/drop-forge.preview';

const logger = Logger.get('DROP_FORGE_LAUNCH_HANDLER');
export async function runLaunchDelivery(
  delivery: ForgeDelivery
): Promise<void> {
  if (delivery.id.startsWith('funding:')) {
    await processForgeFunding(getDropForgeConfig(), delivery);
    return;
  }
  if (!recoveryEnabled())
    throw new Error(
      'Launch execution and recovery are disabled; queued work retained'
    );
  const record = await dropForgeRepository.find(delivery.id, {});
  if (!record || record.revision < delivery.revision)
    throw new Error('Launch request has not committed');
  const config = getDropForgeConfig();
  const chain = new EthereumLaunchChain(config);
  const now = Math.floor(Date.now() / 1000);
  // Install every future group before attempting opening work. Earlier action
  // failures cannot prevent the later phase deliveries from being triggered.
  if (automationEnabled() && ['ARMED', 'RUNNING'].includes(record.state))
    await scheduleLaunchGroups(record, now);
  const watchdog = await launchWatchdog(
    { id: record.id, revision: record.revision },
    now
  );
  try {
    if (automationEnabled())
      await recordPostMintPreview(
        record.id,
        config,
        dropForgeRepository,
        chain,
        now
      );
    const worker = new DropForgeWorker(
      config,
      dropForgeRepository,
      chain,
      new KmsTransactionSigner(config.keyId, config.signer),
      automationEnabled()
    );
    let reportsDelivered = await reportLaunchEvents(
      config,
      dropForgeRepository,
      record.id
    );
    for (let cycle = 0; cycle < 3; cycle++) {
      await worker.tick(record.id);
      reportsDelivered =
        (await reportLaunchEvents(config, dropForgeRepository, record.id)) &&
        reportsDelivered;
      if (!reportsDelivered) break;
    }
    const updated = await dropForgeRepository.find(record.id, {});
    if (!updated) throw new Error('Launch ledger disappeared');
    if (!reportsDelivered)
      throw new Error(
        'Drop Forge wave delivery deferred; check reporting permissions'
      );
    await continueLaunch(
      updated,
      Math.floor(Date.now() / 1000),
      automationEnabled(),
      await readForgeSettings(config)
    );
  } finally {
    // A hard timeout cannot reach finally, leaving the recovery wake intact.
    await removeLaunchWatchdog(record.id, watchdog);
  }
}
const launchHandler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await consumeForgeDelivery(record, false, (delivery) =>
      doInDbContext(() => runLaunchDelivery(delivery), { logger })
    );
  }
};
export const handler = wrapLambdaHandler(launchHandler);
