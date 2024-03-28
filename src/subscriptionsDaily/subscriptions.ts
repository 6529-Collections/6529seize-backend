import { MEMES_CONTRACT } from '../constants';
import {
  NFTSubscription,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { Logger } from '../logging';
import { getMaxMemeId } from '../nftsLoop/db.nfts';
import {
  fetchAllAutoSubscriptions,
  fetchAllNftSubscriptions,
  persistSubscriptionLogs,
  persistSubscriptions
} from './db.subscriptions';

const logger = Logger.get('SUBSCRIPTIONS');

export async function updateSubscriptions(reset?: boolean) {
  const currentAutoSubscriptions = await fetchAllAutoSubscriptions();
  logger.info(`[FOUND ${currentAutoSubscriptions.length} AUTO SUBSCRIPTIONS]`);

  const maxMemeId = await getMaxMemeId();

  logger.info(`[MAX CURRENT MEME ${maxMemeId}]`);

  for (let i = 1; i <= 3; i++) {
    await createForMemeId(maxMemeId + i, currentAutoSubscriptions);
  }
}

async function createForMemeId(
  newMeme: number,
  currentAutoSubscriptions: SubscriptionMode[]
) {
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );
  logger.info(
    `[NEW MEME ID ${newMeme}] : [SUBSCRIPTIONS ${newMemeSubscriptions.length}]`
  );

  if (newMemeSubscriptions.length > 0) {
    logger.info(`[SUBSCRIPTIONS FOR NEW MEME ALREADY EXIST...SKIPPING]`);
  } else {
    logger.info(`[POPULATING AUTOMATIC SUBSCRIPTIONS FOR NEW MEME]`);

    const newSubscriptions: NFTSubscription[] = [];
    const newSubscriptionLogs: SubscriptionLog[] = [];

    currentAutoSubscriptions.forEach((s) => {
      const sub: NFTSubscription = {
        consolidation_key: s.consolidation_key,
        contract: MEMES_CONTRACT,
        token_id: newMeme
      };
      newSubscriptions.push(sub);
      newSubscriptionLogs.push({
        consolidation_key: s.consolidation_key,
        log: `Auto-Subscribed to Meme #${newMeme}`
      });
    });
    await persistSubscriptions(newSubscriptions);
    await persistSubscriptionLogs(newSubscriptionLogs);
    logger.info(
      `[NEW MEME ID ${newMeme}] : [CREATED ${newSubscriptions.length} AUTO SUBSCRIPTIONS]`
    );
  }
}
