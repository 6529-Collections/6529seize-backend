import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '../logging';
import {
  GENERATOR_BASE_PATH,
  NEXTGEN_BUCKET,
  NEXTGEN_BUCKET_AWS_REGION,
  NEXTGEN_CF_BASE_PATH
} from '../nextgen/nextgen_constants';
import {
  getGenDetailsFromUri,
  getImageBlobFromGenerator,
  getNextBatch,
  invalidatePath,
  listS3Objects,
  s3UploadNextgenImage
} from '../nextgen/nextgen_generator';
import { doInDbContext } from '../secrets';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { s3ObjectExists } from '../helpers/s3_helpers';
import { sendDiscordUpdate } from '../notifier-discord';

const logger = Logger.get('NEW_NEXTGEN_UPLOADER');

let s3: S3Client;
let cloudfront: CloudFrontClient;

const START_INDEX = 10000000000;
const END_INDEX = 10000000999;

const BATCH_SIZE = 15;

const CURRENT_PATH = 'mainnet/png/';

async function setup() {
  s3 = new S3Client({ region: NEXTGEN_BUCKET_AWS_REGION });
  cloudfront = new CloudFrontClient({ region: NEXTGEN_BUCKET_AWS_REGION });
}

export const handler = async () => {
  await doInDbContext(
    async () => {
      setup();

      const allExisting = await listS3Objects(s3, CURRENT_PATH);

      logger.info(`[CURRENT IMAGE COUNT ${allExisting.length}]`);

      const nextBatch = await getNextBatch(
        allExisting,
        START_INDEX,
        END_INDEX,
        BATCH_SIZE
      );
      if (nextBatch.length) {
        await uploadBatch(nextBatch);
      } else {
        logger.info(`[NO MISSING IMAGES]`);
      }
    },
    { logger }
  );
};

async function uploadBatch(batch: number[]) {
  logger.info(`[UPLOADING BATCH] : [BATCH ${JSON.stringify(batch)}]`);
  await Promise.all(batch.map((item) => uploadMissingNextgenMedia(item)));
}

async function uploadMissingNextgenMedia(item: number) {
  const path = `/mainnet/metadata/${item}`;
  const metadataPath = path.startsWith('/') ? path.slice(1) : path;
  const imagePath = metadataPath.replace('/metadata/', '/png/');
  const htmlPath = metadataPath.replace('/metadata/', '/html/');

  const txId = item.toString();
  const metadataExists = await s3ObjectExists(
    NEXTGEN_BUCKET,
    metadataPath,
    txId
  );
  const imageExists = await s3ObjectExists(NEXTGEN_BUCKET, imagePath, txId);
  const htmlExists = await s3ObjectExists(NEXTGEN_BUCKET, htmlPath, txId);

  if (metadataExists && imageExists && htmlExists) {
    logger.info(
      `[ALL NEXTGEN MEDIA EXIST] : [METADATA ${metadataPath}] : [IMAGE ${imagePath}] : [HTML ${htmlPath}]`
    );
    return;
  }

  logger.info(
    `[UPLOADING MISSING NEXTGEN MEDIA] : [PATH ${path}]: [METADATA EXISTS ${metadataExists}] : [IMAGE EXISTS ${imageExists}] : [HTML EXISTS ${htmlExists}]`
  );

  if (!path.includes('/metadata/')) {
    logger.info(`[NOT A METADATA PATH] : [SKIPPING] : [PATH ${path}]`);
    return;
  }

  const genDetails = getGenDetailsFromUri(path);

  const generatorMetadataPath = `${GENERATOR_BASE_PATH}/${metadataPath}`;
  const genMetaResponse = await fetch(generatorMetadataPath);
  if (genMetaResponse.status !== 200) {
    logger.info(
      `[GENERATOR METADATA ERROR RESPONSE] : [STATUS ${genMetaResponse.status}] : [METADATA PATH ${metadataPath}]`
    );
    return;
  }

  const metadata: any = await genMetaResponse.json();

  if (metadata.innerError) {
    logger.info(
      `[GENERATOR METADATA RESPONSE ERROR] : [EXITING] : [${JSON.stringify(
        metadata
      )}]`
    );
    return;
  }

  if (!metadata.attributes || metadata.attributes.length === 0) {
    logger.info(
      `[GENERATOR METADATA RESPONSE ERROR] : [EXITING] : [MISSING ATTRIBUTES] : [${JSON.stringify(
        metadata
      )}]`
    );
    return;
  }

  if (metadata.image) {
    metadata.image = `${NEXTGEN_CF_BASE_PATH}/${imagePath}`;
  }
  if (metadata.animation_url) {
    if (genDetails.collection == 1) {
      logger.info('[SKIPPING METADATA ANIMATION URL] : [COLLECTION 1]');
      delete metadata.animation_url;
    } else {
      metadata.animation_url = `${NEXTGEN_CF_BASE_PATH}/${htmlPath}`;
    }
  }

  const htmlGeneratorPath = `${GENERATOR_BASE_PATH}/${htmlPath}`;
  metadata.generator = {
    metadata: generatorMetadataPath,
    html: htmlGeneratorPath,
    image: `${GENERATOR_BASE_PATH}/${imagePath}`
  };

  const imageBlob = await getImageBlobFromGenerator(imagePath);
  if (!imageBlob) {
    logger.error(`[IMAGE BLOB ERROR] : [EXITING]`);
    return;
  }

  const genHtmlResponse = await fetch(htmlGeneratorPath);
  if (genHtmlResponse.status !== 200) {
    logger.info(
      `[GENERATOR HTML ERROR RESPONSE] : [STATUS ${genHtmlResponse.status}] : [HTML PATH ${htmlPath}]`
    );
    return;
  }
  const htmlBlob = await genHtmlResponse.arrayBuffer();

  await s3UploadNextgenImage(s3, imageBlob, imagePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: NEXTGEN_BUCKET,
      Key: htmlPath,
      Body: Buffer.from(htmlBlob),
      ContentType: `text/html`
    })
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: NEXTGEN_BUCKET,
      Key: metadataPath,
      Body: Buffer.from(JSON.stringify(metadata)),
      ContentType: `application/json`
    })
  );

  await invalidatePath(cloudfront, path);

  const discordMessage = `New Token Generated\n${NEXTGEN_CF_BASE_PATH}/${imagePath}`;
  await sendDiscordUpdate(
    process.env.NEXTGEN_GENERATOR_DISCORD_WEBHOOK as string,
    discordMessage,
    'NEXTGEN_GENERATOR'
  );
}
