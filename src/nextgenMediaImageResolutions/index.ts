import { S3Client } from '@aws-sdk/client-s3';
import { Logger } from '../logging';
import {
  NEXTGEN_BUCKET_AWS_REGION,
  NEXTGEN_CF_BASE_PATH
} from '../nextgen/nextgen_constants';
import { Time } from '../time';
import {
  getImageBlobFromGenerator,
  getNextBatch,
  listS3Objects,
  s3UploadNextgenImage
} from '../nextgen/nextgen_generator';
import { sepolia } from '@wagmi/chains';
import { loadEnv } from '../secrets';
import { sendDiscordUpdate } from '../notifier-discord';

const logger = Logger.get('NEXTGEN_IMAGES_LOOP');

let s3: S3Client;

async function setup() {
  s3 = new S3Client({ region: NEXTGEN_BUCKET_AWS_REGION });
}

enum Resolution {
  'thumbnail' = 'thumbnail',
  '0.5k' = '0.5k',
  '1k' = '1k',
  '2k' = '2k',
  '4k' = '4k',
  '8k' = '8k',
  '16k' = '16k'
}

const START_INDEX = 10000000000;
const END_INDEX = 10000000999;

const BATCH_SIZE = 60;

export const handler = async () => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  await loadEnv([]);
  setup();

  const resolutions = [Resolution['thumbnail'], Resolution['0.5k']];

  for (let resolution of resolutions) {
    const path =
      resolution == Resolution['thumbnail'] ? 'thumbnail' : `png${resolution}`;
    const isFinished = await findMissingImages(resolution, path);
    if (!isFinished) {
      logger.info(`[RESOLUTION ${resolution.toUpperCase()}] : [NOT FINISHED]`);
      break;
    }
    logger.info(`[RESOLUTION ${resolution.toUpperCase()}] : [FINISHED]`);
  }
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

function getNetworkPath() {
  if (process.env.NEXTGEN_CHAIN_ID === sepolia.id.toString()) {
    return `testnet`;
  }
  return `mainnet`;
}

async function findMissingImages(resolution: Resolution, path: string) {
  const networkPath = getNetworkPath();

  const resolutionPath = `${networkPath}/${path}/`;

  const allExisting = await listS3Objects(s3, resolutionPath);

  logger.info(
    `[RESOLUTION ${resolution.toUpperCase()}] : [RESOLUTON_PATH ${resolutionPath}] : [CURRENT IMAGE COUNT ${
      allExisting.length
    }]`
  );

  const nextBatch = await getNextBatch(
    allExisting,
    START_INDEX,
    END_INDEX,
    BATCH_SIZE
  );

  if (nextBatch.length) {
    await uploadBatch(networkPath, nextBatch, resolutionPath, resolution);
    return false;
  } else {
    logger.info(`[NO MISSING IMAGES]`);
    return true;
  }
}

async function uploadBatch(
  networkPath: string,
  batch: number[],
  path: string,
  resolution: Resolution
) {
  logger.info(
    `[UPLOADING BATCH] : [RESOLUTION: ${resolution.toUpperCase()}] : [BATCH ${JSON.stringify(
      batch
    )}]`
  );
  await Promise.all(
    batch.map((item) =>
      uploadMissingNextgenImage(networkPath, item, resolution, path)
    )
  );
}

async function uploadMissingNextgenImage(
  networkPath: string,
  tokenId: number,
  resolution: Resolution,
  path: string
) {
  const generatorPath = `/${networkPath}/png/${tokenId}/${resolution}`;
  const s3Path = `${path}${tokenId}`;

  logger.info(
    `[TOKEN_ID ${tokenId}] : [RESOLUTION ${resolution.toUpperCase()}] : [GENERATOR PATH ${generatorPath}] : [S3 PATH ${s3Path}]`
  );

  const imageBlob = await getImageBlobFromGenerator(generatorPath);
  if (!imageBlob) {
    logger.info(`[IMAGE BLOB ERROR] : [EXITING]`);
    return;
  }

  await s3UploadNextgenImage(s3, imageBlob, s3Path);

  const discordMessage = `New Resolution (${resolution.toUpperCase()}) for Token #${tokenId} Generated\n${NEXTGEN_CF_BASE_PATH}/${s3Path}`;
  await sendDiscordUpdate(
    process.env.NEXTGEN_GENERATOR_DISCORD_WEBHOOK as string,
    discordMessage,
    'NEXTGEN_GENERATOR'
  );
}
