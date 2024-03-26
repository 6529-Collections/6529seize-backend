import { MEMES_CONTRACT, NFTS_TABLE } from '../constants';
import { NFTSubscription } from '../entities/ISubscription.ts';
import { Logger } from '../logging';
import { sqlExecutor } from '../sql-executor';
import {
  fetchAllAutoSubscriptions,
  fetchAllNftSubscriptions,
  persistSubscriptions
} from './db.subscriptions';

const logger = Logger.get('SUBSCRIPTIONS');

export async function updateSubscriptions(reset?: boolean) {
  const currentAutoSubscriptions = await fetchAllAutoSubscriptions();
  logger.info(`[FOUND ${currentAutoSubscriptions.length} AUTO SUBSCRIPTIONS]`);

  const maxMemeId =
    (
      await sqlExecutor.execute(
        `SELECT MAX(id) as max_id FROM ${NFTS_TABLE} WHERE contract = :contract`,
        { contract: MEMES_CONTRACT }
      )
    )[0]?.max_id ?? 0;

  logger.info(`[MAX CURRENT MEME ${maxMemeId}]`);

  const newMeme = maxMemeId + 1;
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );
  logger.info(
    `[NEW MEME ID ${newMeme}] : [SUBSCRIPTIONS ${newMemeSubscriptions.length}]`
  );

  if (newMemeSubscriptions.length > 0) {
    logger.info(`[SUBSCRIPTIONS FOR NEW MEME ALREADY EXIST]`);
  } else {
    logger.info(`[POPULATING AUTOMATIC SUBSCRIPTIONS FOR NEW MEME]`);
    const newSubscriptions: NFTSubscription[] = currentAutoSubscriptions.map(
      (s) => {
        const sub: NFTSubscription = {
          consolidation_key: s.consolidation_key,
          contract: MEMES_CONTRACT,
          token_id: newMeme
        };
        return sub;
      }
    );
    await persistSubscriptions(newSubscriptions);
    logger.info(`[CREATED ${newSubscriptions.length} NEW SUBSCRIPTIONS]`);
  }
}
