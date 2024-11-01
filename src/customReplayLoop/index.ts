import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTFinalSubscription } from '../entities/ISubscription';
import { getDataSource } from '../db';
import { IsNull } from 'typeorm';
import { fetchAirdropAddressForConsolidationKey } from '../delegationsLoop/db.delegations';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    { logger, entities: [NFTFinalSubscription] }
  );
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  const finalSubsRepo = getDataSource().getRepository(NFTFinalSubscription);
  const finalSubscriptionsWithMissingAirdrops = await finalSubsRepo.find({
    where: [{ airdrop_address: IsNull() }, { airdrop_address: '' }]
  });
  logger.info(
    `[CUSTOM REPLAY] Found ${finalSubscriptionsWithMissingAirdrops.length} final subscriptions with missing airdrops`
  );

  for (const sub of finalSubscriptionsWithMissingAirdrops) {
    const airdropAddress = await fetchAirdropAddressForConsolidationKey(
      sub.consolidation_key
    );
    logger.info(
      `[CUSTOM REPLAY] Found airdrop address ${airdropAddress} for consolidation key ${sub.consolidation_key}`
    );
  }
}
