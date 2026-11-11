import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import {
  NextGenAllowlist,
  NextGenAllowlistBurn,
  NextGenAllowlistCollection,
  NextGenBlock,
  NextGenCollection,
  NextGenCollectionBurn,
  NextGenLog,
  NextGenToken,
  NextGenTokenScore,
  NextGenTokenTrait
} from '../entities/INextGen';
import { findNextGenTransactions } from '../nextgen/nextgen';
import { Transaction } from '../entities/ITransaction';
import { doInDbContext } from '../secrets';
import { NextgenLoopHealth } from '@/nextgenContractLoop/loop-health';

const logger = Logger.get('NEXTGEN_CONTRACT_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const health = new NextgenLoopHealth();
      await health.start();
      await findNextGenTransactions(health);
    },
    {
      entities: [
        NextGenAllowlist,
        NextGenAllowlistBurn,
        NextGenAllowlistCollection,
        NextGenCollection,
        NextGenCollectionBurn,
        NextGenBlock,
        NextGenLog,
        NextGenToken,
        NextGenTokenTrait,
        NextGenTokenScore,
        Transaction
      ],
      logger
    }
  );
});
