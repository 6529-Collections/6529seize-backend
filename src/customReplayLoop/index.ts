import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTFinalSubscription } from '../entities/ISubscription';
import { sqlExecutor } from '../sql-executor';
import { SUBSCRIPTIONS_NFTS_FINAL_TABLE } from '../constants';
import { fetchAirdropAddressForConsolidationKey } from '../delegationsLoop/db.delegations';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([NFTFinalSubscription]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);

  const missingAirdrops: NFTFinalSubscription[] = await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} WHERE airdrop_address IS NULL OR airdrop_address = ''`
  );

  logger.info(`[MISSING AIRDROPS ${missingAirdrops.length}]`);

  for (const missingAirdrop of missingAirdrops) {
    const airdropAddress = await fetchAirdropAddressForConsolidationKey(
      missingAirdrop.consolidation_key
    );
    await sqlExecutor.execute(
      `UPDATE ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} SET airdrop_address = :airdropAddress WHERE id = :id `,
      {
        airdropAddress: airdropAddress.airdrop_address,
        id: missingAirdrop.id
      }
    );
  }
}
