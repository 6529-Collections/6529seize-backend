import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { Transaction } from '../entities/ITransaction';
import { repairDuplicatedMeme68Transfer } from './repair-duplicated-meme-68-transfer';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    {
      logger,
      entities: [Transaction, NFTOwner, ConsolidatedNFTOwner],
      skipRedis: true
    }
  );
});

async function replay() {
  const apply = process.env.CUSTOM_REPLAY_APPLY === 'true';
  logger.info(`[CUSTOM REPLAY MODE] [${apply ? 'APPLY' : 'DRY RUN'}]`);
  const result = await repairDuplicatedMeme68Transfer(apply);
  logger.info(`[CUSTOM REPLAY COMPLETE] [RESULT ${result}]`);
}
