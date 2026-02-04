import { Logger } from './logging';
import * as nftsLoop from './nftsLoop';
import { NFT_MODE } from './nftsLoop/nfts';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await dbMigrationsLoop.handler(
  //   undefined as any,
  //   undefined as any,
  //   undefined as any
  // );

  await nftsLoop.handler(
    {
      mode: NFT_MODE.REFRESH
    },
    undefined as any,
    undefined as any
  );

  process.exit(0);
}

start();
