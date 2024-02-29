import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import Sharp from 'sharp';
import { Logger } from '../logging';
import { wrapLambdaHandler } from '../sentry.context';

const logger = Logger.get('MEDIA_RESIZER_LOOP');

const PathPattern = /(.*\/)?(.*)\/(.*)/;

const { BUCKET, FILE_SERVER_URL, BUCKET_REGION } = process.env;
const WHITELIST = process.env.WHITELIST
  ? Object.freeze(process.env.WHITELIST.split(' '))
  : null;

const s3Client = new S3Client({
  region: BUCKET_REGION
});

export const handler = wrapLambdaHandler(async (event: any) => {
  let path = event.queryStringParameters?.path;
  if (!path) {
    return notFound();
  }
  logger.info(`[${path}] Request for resizing`);
  if (path[0] === '/') {
    path = path.slice(1);
  }

  const parts = PathPattern.exec(path) ?? [];
  if (parts.length < 3) {
    return notFound();
  }
  const dir = parts[1] || '';
  const resizeOption = parts[2]; // e.g. "150x150_max"
  const sizeAndAction = resizeOption.split('_');
  const filename = parts[3];

  const key = dir + filename;

  const sizes = sizeAndAction[0].split('x');
  const action = sizeAndAction.length > 1 ? sizeAndAction[1] : null;

  if (WHITELIST && !WHITELIST.includes(resizeOption)) {
    logger.info(`[${path}] Resize option ${resizeOption} not in whitelist`);
    return notFound();
  }

  if (action && action !== 'max' && action !== 'min') {
    logger.info(`[${path}] Unknown resize action ${action}`);
    return notFound();
  }

  try {
    const params = {
      Bucket: BUCKET,
      Key: key
    };
    const originImage = await s3Client.send(new GetObjectCommand(params));
    if (!originImage?.Body) {
      logger.info(`[${path}] S3 origin file not found`);
      return notFound();
    }

    const width = sizes[0] === 'AUTO' ? null : parseInt(sizes[0]);
    const height = sizes[1] === 'AUTO' ? null : parseInt(sizes[1]);
    let fit: 'cover' | 'inside' | 'outside';
    switch (action) {
      case 'max':
        fit = 'inside';
        break;
      case 'min':
        fit = 'outside';
        break;
      default:
        fit = 'cover';
        break;
    }
    const sharp = Sharp({
      failOn: 'none',
      animated: originImage.ContentType === 'image/gif'
    })
      .resize(width, height, { withoutEnlargement: true, fit })
      .rotate();
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: BUCKET,
        Key: path,
        Body: (originImage.Body as any).pipe(sharp),
        ContentType: originImage.ContentType,
        CacheControl: 'public, max-age=86400'
      }
    });
    await upload.done();
    const filesFileServerUrl = `${FILE_SERVER_URL}/${path}`;
    logger.info(
      `[${path}] Resized successfully. Redirecting to ${filesFileServerUrl}`
    );
    return {
      statusCode: 301,
      headers: { Location: filesFileServerUrl }
    };
  } catch (e: any) {
    logger.error(
      `[${path}] Resizing failed (Config: Region: ${BUCKET_REGION}, Bucket ${BUCKET}) ${
        e.message ?? e
      }`
    );
    throw e;
  }
});

function notFound() {
  return {
    statusCode: 404
  };
}
