import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTFinalSubscription } from '../entities/ISubscription';
import { getDataSource } from '../db';
import { IsNull } from 'typeorm';
import { fetchAirdropAddressForConsolidationKey } from '../delegationsLoop/db.delegations';
import { areEqualAddresses } from '../helpers';

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
    where: {
      token_id: 292
    }
  });
  logger.info(
    `[CUSTOM REPLAY] Found ${finalSubscriptionsWithMissingAirdrops.length} final subscriptions with missing airdrops`
  );

  const updatedSubs = [];

  for (const sub of finalSubscriptionsWithMissingAirdrops) {
    const airdropAddress = await fetchAirdropAddressForConsolidationKey(
      sub.consolidation_key
    );
    if (
      !areEqualAddresses(airdropAddress.airdrop_address, sub.airdrop_address)
    ) {
      logger.info(
        `[CUSTOM REPLAY] [${sub.id}] Found updated airdrop address ${airdropAddress.airdrop_address} for consolidation key ${sub.consolidation_key}`
      );
      await finalSubsRepo.update(sub.id!, {
        airdrop_address: airdropAddress.airdrop_address
      });
      logger.info(
        `[CUSTOM REPLAY] [${sub.id}] Updated airdrop address to ${airdropAddress.airdrop_address}`
      );
      updatedSubs.push(sub.id!);
    }
  }
  logger.info(
    `[CUSTOM REPLAY] Updated final subscriptions: ${updatedSubs.join(', ')}`
  );
}
