import { S3Client } from '@aws-sdk/client-s3';
import { Logger } from '../logging';
import {
  GENERATOR_BASE_PATH,
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
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { sendDiscordUpdate } from '../notifier-discord';

const logger = Logger.get('NEXTGEN_IMAGES_LOOP');

let s3: S3Client;
let cloudfront: CloudFrontClient;

async function setup() {
  s3 = new S3Client({ region: NEXTGEN_BUCKET_AWS_REGION });
  cloudfront = new CloudFrontClient({ region: NEXTGEN_BUCKET_AWS_REGION });
}

const START_INDEX = 10000000000;
const END_INDEX = 10000000999;

const BATCH_SIZE = 15;

export const handler = async () => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  await loadEnv([]);
  setup();
  const resolutions = ['2k'];
  for (let resolution of resolutions) {
    await findMissingImages(resolution);
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

async function findMissingImages(resolution: string) {
  const networkPath = getNetworkPath();
  const resolutionPath = `${networkPath}/png${resolution}/`;

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
    await uploadBatch(nextBatch, resolutionPath, resolution);
  } else {
    logger.info(`[NO MISSING IMAGES]`);
  }
}

async function uploadBatch(batch: number[], path: string, resolution: string) {
  logger.info(
    `[UPLOADING BATCH] : [RESOLUTION: ${resolution.toUpperCase()}] : [BATCH ${JSON.stringify(
      batch
    )}]`
  );
  await Promise.all(
    batch.map((item) => uploadMissingNextgenImage(item, resolution))
  );
}

async function uploadMissingNextgenImage(tokenId: number, resolution: string) {
  const generatorPath = `${GENERATOR_BASE_PATH}/mainnet/png/${tokenId}/${resolution}`;
  const s3Path = `mainnet/png${resolution}/${tokenId}`;

  logger.info(
    `[TOKEN_ID ${tokenId}] : [RESOLUTION ${resolution.toUpperCase()}] : [GENERATOR PATH ${generatorPath}] : [S3 PATH ${s3Path}]`
  );

  const imageBlob = await getImageBlobFromGenerator(generatorPath);
  if (!imageBlob) {
    logger.info(`[IMAGE BLOB ERROR] : [EXITING]`);
    return;
  }

  await s3UploadNextgenImage(s3, imageBlob, s3Path);

  const discordMessage = `New Resolution (${resolution}) for Token #${tokenId} Generated\n${NEXTGEN_CF_BASE_PATH}/${s3Path}`;
  await sendDiscordUpdate(
    process.env.NEXTGEN_GENERATOR_DISCORD_WEBHOOK as string,
    discordMessage,
    'NEXTGEN_GENERATOR'
  );
}
