// import * as dbMigrationsLoop from './dbMigrationsLoop';
// import * as claimsBuilder from './claimsBuilder';
import * as claimsMediaArweaveUploader from './claimsMediaArweaveUploader';
import { Logger } from './logging';
// import * as nftsLoop from './nftsLoop';
// import { NFT_MODE } from './nftsLoop/nfts';
const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await dbMigrationsLoop.handler(
  //   undefined as any,
  //   undefined as any,
  //   undefined as any
  // );

  // await nftsLoop.handler(
  //   {
  //     mode: NFT_MODE.DISCOVER
  //   },
  //   undefined as any,
  //   undefined as any
  // );

  // await claimsBuilder.handler(
  //   {
  //     Records: [
  //       {
  //         body: JSON.stringify({
  //           drop_id: '22d78cad-6592-430c-bf16-2337cf511c4b'
  //         })
  //       }
  //     ]
  //   },
  //   undefined as any,
  //   undefined as any
  // );

  await claimsMediaArweaveUploader.handler(
    {
      Records: [
        {
          body: JSON.stringify({
            meme_id: 459
          })
        }
      ]
    },
    undefined as any,
    undefined as any
  );

  // await transactionsLoop.handler(
  //   undefined as any,
  //   undefined as any,
  //   undefined as any
  // );

  process.exit(0);
}

start();
