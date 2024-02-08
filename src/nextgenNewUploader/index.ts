import {
  ListObjectsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { Logger } from '../logging';
import {
  CLOUDFRONT_DISTRIBUTION,
  GENERATOR_BASE_PATH,
  NEXTGEN_BUCKET,
  NEXTGEN_BUCKET_AWS_REGION,
  NEXTGEN_CF_BASE_PATH
} from '../nextgen/nextgen_constants';
import { Time } from '../time';
import {
  getGenDetailsFromUri,
  getImageBlobFromGenerator,
  s3UploadNextgenImage
} from '../nextgen/nextgen_generator';
import { loadEnv } from '../secrets';
import {
  CloudFrontClient,
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';
import { objectExists } from '../helpers/s3_helpers';
import { sendDiscordUpdate } from '../notifier-discord';

const logger = Logger.get('NEW_NEXTGEN_UPLOADER');

let s3: S3Client;
let cloudfront: CloudFrontClient;

const BATCH_SIZE = 15;

const START_INDEX = 10000000000;
const END_INDEX = 10000000999;

async function setup() {
  s3 = new S3Client({ region: NEXTGEN_BUCKET_AWS_REGION });
  cloudfront = new CloudFrontClient({ region: NEXTGEN_BUCKET_AWS_REGION });
}

export const handler = async (event: any) => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  await loadEnv([]);
  setup();

  const pngPath = 'mainnet/png/';
  const currentImageCount = await getCurrentImageCountFromS3(pngPath);

  if (currentImageCount) {
    logger.info(`[CURRENT IMAGE COUNT] : [COUNT ${currentImageCount}]`);

    const allExisting = await listS3Objects(pngPath);
    const nextBatch = await getNextBatch(allExisting);
    if (nextBatch.length) {
      await uploadBatch(nextBatch);
    } else {
      logger.info(`[NO MISSING IMAGES]`);
    }
  }
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function getNextBatch(allExisting: number[]): Promise<number[]> {
  const nextBatch = [];
  for (let i = START_INDEX; i <= END_INDEX; i++) {
    if (!allExisting.includes(i)) {
      nextBatch.push(i);
    }
    if (nextBatch.length >= BATCH_SIZE) {
      break;
    }
  }
  return nextBatch;
}

async function listS3Objects(path: string): Promise<number[]> {
  const command = new ListObjectsCommand({
    Bucket: NEXTGEN_BUCKET,
    Prefix: path
  });
  const contents: number[] = [];
  try {
    const response = await s3.send(command);
    response.Contents?.forEach((object) => {
      if (object.Key) {
        contents.push(parseInt(object.Key?.replace(path, '')));
      }
    });
  } catch (error) {
    logger.error(`[S3 LIST ERROR] : [PATH ${path}] : [ERROR ${error}]`);
  }
  return contents;
}

async function uploadBatch(batch: number[]) {
  logger.info(`[UPLOADING BATCH] : [BATCH ${JSON.stringify(batch)}]`);
  const promises = [];
  for (let i = 0; i < batch.length; i++) {
    const nextPath = `/mainnet/metadata/${batch[i]}`;
    promises.push(uploadMissingNextgenMedia(nextPath));
  }
  await Promise.all(promises);
}

async function getCurrentImageCountFromS3(path: string): Promise<number> {
  const command = new ListObjectsCommand({
    Bucket: NEXTGEN_BUCKET,
    Prefix: path
  });
  try {
    const response = await s3.send(command);
    return response.Contents?.length || 0;
  } catch (error) {
    logger.error(`[S3 LIST ERROR] : [PATH ${path}] : [ERROR ${error}]`);
  }
  return 0;
}

async function uploadMissingNextgenMedia(path: string) {
  const metadataPath = path.startsWith('/') ? path.slice(1) : path;
  const imagePath = metadataPath.replace('/metadata/', '/png/');
  const htmlPath = metadataPath.replace('/metadata/', '/html/');

  const metadataExists = await objectExists(s3, NEXTGEN_BUCKET, metadataPath);
  const imageExists = await objectExists(s3, NEXTGEN_BUCKET, imagePath);
  const htmlExists = await objectExists(s3, NEXTGEN_BUCKET, htmlPath);

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
    logger.info(`[IMAGE BLOB ERROR] : [EXITING]`);
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

  await invalidatePath(path);

  const discordMessage = `New Token Generated\n${NEXTGEN_CF_BASE_PATH}/${imagePath}`;
  await sendDiscordUpdate(
    process.env.NEXTGEN_GENERATOR_DISCORD_WEBHOOK as string,
    discordMessage,
    'NEXTGEN_GENERATOR'
  );
}

async function invalidatePath(path: string) {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const pathParts = path.split('/', 3);
  const invalidationPath = `/${pathParts[1]}/*`;
  logger.info(`[INVALIDATING PATH] : [PATH ${invalidationPath}]`);
  try {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: CLOUDFRONT_DISTRIBUTION,
        InvalidationBatch: {
          CallerReference: Date.now().toString(),
          Paths: {
            Quantity: 1,
            Items: [invalidationPath]
          }
        }
      })
    );
  } catch (e) {
    logger.info(
      `[INVALIDATE ERROR] : [PATH ${invalidationPath}] : [ERROR ${e}]`
    );
  }
}
