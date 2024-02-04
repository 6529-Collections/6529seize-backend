import { ListObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '../logging';
import {
  NEXTGEN_BUCKET,
  NEXTGEN_BUCKET_AWS_REGION
} from '../nextgen/nextgen_constants';
import { Time } from '../time';
import {
  getImageBlobFromGenerator,
  s3UploadNextgenImage,
  triggerGeneratorPath
} from '../nextgen/nextgen_generator';

const logger = Logger.get('NEXTGEN_IMAGES_LOOP');

let s3: S3Client;

async function setup() {
  s3 = new S3Client({ region: NEXTGEN_BUCKET_AWS_REGION });
}

const PRELOAD_COUNT = 5;

export const handler = async (event: any) => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  setup();
  const resolutions = ['4k', '8k', '16k'];
  for (let resolution of resolutions) {
    const foundAndProcessed = await findMissingImages(resolution);
    if (foundAndProcessed) {
      logger.info(
        `[FOUND AND PROCESSED MISSING IMAGES FOR ${foundAndProcessed} @ ${resolution}]`
      );
      break;
    }
  }
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function listS3Objects(path: string) {
  const command = new ListObjectsCommand({
    Bucket: NEXTGEN_BUCKET,
    Prefix: path
  });
  const contents: string[] = [];
  try {
    const response = await s3.send(command);
    response.Contents?.forEach((object) => {
      if (object.Key) {
        contents.push(object.Key?.replace(path, ''));
      }
    });
  } catch (error) {
    console.error('Error:', error);
  }
  return contents;
}

function findFirstMissingImage(original: string[], contents4k: string[]) {
  const missingImages = original.find((image) => !contents4k.includes(image));
  return missingImages;
}

async function findMissingImages(resolution: string, count = PRELOAD_COUNT) {
  const originalPath = 'testnet/png/';
  const resolutionPath = `testnet/png${resolution}/`;

  const contentOriginal = await listS3Objects(originalPath);
  const contentsResolution = await listS3Objects(resolutionPath);

  const missingImages = contentOriginal
    .filter((image) => !contentsResolution.includes(image))
    .slice(0, count);

  if (missingImages.length > 0) {
    missingImages.forEach((image) => {
      const generatorPath = `${originalPath}${image}/${resolution}`;
      logger.info(`[TRIGGERING CACHE FOR ${generatorPath}]`);
      triggerGeneratorPath(generatorPath);
      logger.info(`[CACHE TRIGGERED FOR ${image}]`);
    });

    const firstImage = missingImages[0];
    const firstGeneratorPath = `${originalPath}${firstImage}/${resolution}`;
    logger.error(
      `[PROCESSING FIRST MISSING IMAGE ${firstImage}] : [GENERATOR_PATH ${firstGeneratorPath}] : [DOWNLOADING...]`
    );
    try {
      const imageBlob = await getImageBlobFromGenerator(firstGeneratorPath);
      if (imageBlob) {
        const uploadPath = `${resolutionPath}${firstImage}`;
        await s3UploadNextgenImage(s3, imageBlob, uploadPath);
        logger.info(`[IMAGE UPLOADED TO S3 ${uploadPath}]`);
      } else {
        logger.error(
          `[IMAGE DOWNLOAD FAILED] : [GENERATOR_PATH ${firstGeneratorPath}] : [EXITING]`
        );
      }
    } catch (error) {
      logger.error(
        `[ERROR PROCESSING FIRST MISSING IMAGE] : [GENERATOR_PATH ${firstGeneratorPath}] : ${error}`
      );
    }

    return firstImage;
  }
  return false;
}
