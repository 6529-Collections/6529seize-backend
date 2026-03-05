import * as dbMigrationsLoop from './dbMigrationsLoop';
import { Logger } from './logging';
import { NFT_MODE } from './nftsLoop/nfts';
import * as nftsLoop from './nftsLoop';
// import * as s3Uploader from './s3Uploader';
// import {
//   S3UploaderCollectionType,
//   S3UploaderImageVariant,
//   S3UploaderJobType
// } from './s3Uploader/s3-uploader.jobs';
// import { MEMES_CONTRACT } from './constants';

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

  // await s3Uploader.handler(
  //   {
  //     Records: [
  //       {
  //         body: JSON.stringify({
  //           collectionType: S3UploaderCollectionType.NFT,
  //           contract: MEMES_CONTRACT,
  //           tokenId: 465,
  //           jobType: S3UploaderJobType.IMAGE,
  //           variants: [S3UploaderImageVariant.ORIGINAL]
  //         })
  //       }
  //     ]
  //   },
  //   undefined as any,
  //   undefined as any
  // );

  process.exit(0);
}

start();
