import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CloudFrontClient,
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';
import { Logger } from '../logging';
import { Time } from '../time';
import { NEXTGEN_CF_BASE_PATH } from '../nextgen/nextgen_constants';

const logger = Logger.get('NEXTGEN_MEDIA_UPLOADER');
const GENERATOR_BASE_PATH = 'https://nextgen-generator.seize.io/';
const BUCKET = 'media-proxy.nextgen-generator.seize.io';
const AWS_REGION = 'us-east-1';
const CLOUDFRONT_DISTRIBUTION = 'E1YUOAX1CF71P7';

let s3: S3Client;
let cloudfront: CloudFrontClient;

async function setup() {
  s3 = new S3Client({ region: AWS_REGION });
  cloudfront = new CloudFrontClient({ region: AWS_REGION });
}

export const handler = async (event: any) => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  setup();
  const record = event.Records[0].Sns;
  const snsMessage = record.Message;
  const messageAttributes = record.MessageAttributes;
  const requestUri = messageAttributes.RequestURI;
  const missingPath = requestUri.Value;
  logger.info(`[SNS MESSAGE] : ${snsMessage} : ${missingPath}`);
  await uploadMissingNextgenMedia(missingPath);
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function uploadMissingNextgenMedia(path: string) {
  logger.info(`[UPLOADING MISSING NEXTGEN MEDIA] : [PATH ${path}]`);
  if (!path.includes('/metadata/')) {
    logger.info(`[NOT A METADATA PATH] : [SKIPPING] : [PATH ${path}]`);
    return;
  }

  const metadataPath = path.startsWith('/') ? path.slice(1) : path;
  const imagePath = metadataPath.replace('/metadata/', '/png/');
  const htmlPath = metadataPath.replace('/metadata/', '/html/');

  const generatorMetadataPath = `${GENERATOR_BASE_PATH}${metadataPath}`;
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
    metadata.animation_url = `${NEXTGEN_CF_BASE_PATH}/${htmlPath}`;
  }
  metadata.generator_url = generatorMetadataPath;

  const imageGeneratorPath = `${GENERATOR_BASE_PATH}${imagePath}`;
  const genImageResponse = await fetch(imageGeneratorPath);
  if (genImageResponse.status !== 200) {
    logger.info(
      `[GENERATOR IMAGE ERROR RESPONSE] : [STATUS ${genImageResponse.status}] : [IMAGE PATH ${imagePath}]`
    );
    return;
  }
  const imageBlob = await genImageResponse.arrayBuffer();
  logger.info(`[IMAGE ${imagePath} DOWNLOADED]`);

  const htmlGeneratorPath = `${GENERATOR_BASE_PATH}${htmlPath}`;
  const genHtmlResponse = await fetch(htmlGeneratorPath);
  if (genHtmlResponse.status !== 200) {
    logger.info(
      `[GENERATOR HTML ERROR RESPONSE] : [STATUS ${genHtmlResponse.status}] : [HTML PATH ${htmlPath}]`
    );
    return;
  }
  const htmlBlob = await genHtmlResponse.arrayBuffer();

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: metadataPath,
      Body: Buffer.from(JSON.stringify(metadata)),
      ContentType: `application/json`
    })
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: imagePath,
      Body: Buffer.from(imageBlob),
      ContentType: `image/png`
    })
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: htmlPath,
      Body: Buffer.from(htmlBlob),
      ContentType: `text/html`
    })
  );

  await invalidatePath(path);
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
