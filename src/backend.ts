import * as dbMigrationsLoop from './dbMigrationsLoop';
import { Logger } from './logging';
import * as nftsLoop from './nftsLoop';
import { NFT_MODE } from './nftsLoop/nfts';
import * as artCurationNftWatchLoop from './artCurationNftWatchLoop';
import * as delegationsLoop from './delegationsLoop';
import * as nftOwnersLoop from './nftOwnersLoop';
import * as ownersBalancesLoop from './ownersBalancesLoop';
import * as transactionsLoop from './transactionsLoop';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await dbMigrationsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  await nftsLoop.handler(
    {
      mode: NFT_MODE.DISCOVER
    },
    undefined as any,
    undefined as any
  );

  await nftsLoop.handler(
    {
      mode: NFT_MODE.REFRESH
    },
    undefined as any,
    undefined as any
  );

  await artCurationNftWatchLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  // await delegationsLoop.handler(
  //   undefined as any,
  //   undefined as any,
  //   undefined as any
  // );

  await nftOwnersLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  await ownersBalancesLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  await transactionsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  process.exit(0);
}

start();
