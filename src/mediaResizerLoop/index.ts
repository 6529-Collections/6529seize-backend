import { reportUnsupportedResizeOnce } from '@/mediaResizerLoop/unsupported-resize-report';
import { withMediaDependencySmoke } from '@/media/media-dependency-smoke';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import Sharp from 'sharp';
import {
  classifyResizeDecoderError,
  INPUT_PIXEL_BACKSTOP,
  isUnprocessableResizeInput,
  UnprocessableResizeInput,
  withResizeInputFile
} from '@/mediaResizerLoop/resize-resource-safety';
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

const liveHandler = wrapLambdaHandler(async (event: any) => {
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

  let sourceRevision: string | undefined;
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

    sourceRevision =
      originImage.VersionId && originImage.VersionId !== 'null'
        ? originImage.VersionId
        : originImage.ETag;

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
    const animated = originImage.ContentType === 'image/gif';
    await withResizeInputFile(
      originImage.Body as Readable,
      originImage.ContentLength,
      animated,
      async (inputPath, resizeAnimated) => {
        const sharp = Sharp(inputPath, {
          failOn: 'none',
          animated: resizeAnimated,
          limitInputPixels: INPUT_PIXEL_BACKSTOP
        })
          .resize(width, height, {
            withoutEnlargement: true,
            fit,
            fastShrinkOnLoad: true
          })
          .rotate();
        let decoderError: unknown;
        // Sharp can emit a native error without setting Readable.errored.
        sharp.once('error', (error) => {
          decoderError = error;
        });
        try {
          const upload = new Upload({
            client: s3Client,
            queueSize: 1,
            params: {
              Bucket: BUCKET,
              Key: path,
              Body: sharp,
              ContentType: originImage.ContentType,
              CacheControl: 'public, max-age=86400'
            }
          });
          await upload.done();
        } catch (error) {
          // Classify decoder failures only: an S3 upload error is not bad input.
          throw decoderError === error
            ? classifyResizeDecoderError(error)
            : error;
        } finally {
          sharp.destroy();
        }
      },
      { width, height }
    );
    const filesFileServerUrl = `${FILE_SERVER_URL}/${path}`;
    logger.info(
      `[${path}] Resized successfully. Redirecting to ${filesFileServerUrl}`
    );
    return {
      statusCode: 302,
      headers: {
        Location: filesFileServerUrl,
        'Cache-Control': 'no-store, private'
      }
    };
  } catch (e: any) {
    return handleResizeFailure(e, path, key, sourceRevision);
  }
});

async function handleResizeFailure(
  error: unknown,
  path: string,
  sourceKey: string,
  sourceRevision: string | undefined
) {
  if (
    error instanceof UnprocessableResizeInput &&
    error.code === 'UNSUPPORTED_CODEC'
  ) {
    await reportUnsupportedResizeOnce(
      s3Client,
      BUCKET,
      sourceKey,
      sourceRevision
    );
  }
  if (isUnprocessableResizeInput(error)) return unprocessableInput(error);
  logger.error(
    `[${path}] Resizing failed (Config: Region: ${BUCKET_REGION}, Bucket ${BUCKET}) ${
      error instanceof Error ? error.message : error
    }`
  );
  throw error;
}

function unprocessableInput(error: unknown) {
  const code =
    error instanceof UnprocessableResizeInput ? error.code : 'INVALID_IMAGE';
  logger.warn(`Image resize rejected: ${code}`);
  return {
    statusCode: 422,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300'
    },
    body: JSON.stringify({ error: 'Image cannot be resized', code })
  };
}

function notFound() {
  return {
    statusCode: 404
  };
}

export const handler = withMediaDependencySmoke(liveHandler);
