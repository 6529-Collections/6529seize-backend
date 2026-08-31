import {
  HeadObjectCommand,
  type HeadObjectCommandOutput
} from '@aws-sdk/client-s3';
import { CLOUDFRONT_LINK } from '@/constants';
import { env } from '@/env';
import { BadRequestException } from '@/exceptions';
import { getS3 } from '@/s3.client';
import { MAX_MAIN_STAGE_MEDIA_BYTES } from '@/minting-claims/media-limits';

export const MAIN_STAGE_MEDIA_LIMIT_MIB =
  MAX_MAIN_STAGE_MEDIA_BYTES / (1024 * 1024);

type HeadObjectSender = {
  send(
    command: HeadObjectCommand
  ): Promise<Pick<HeadObjectCommandOutput, 'ContentLength'>>;
};

export async function validateMainStageMediaSize(
  mediaUrl: string,
  dependencies: {
    s3?: HeadObjectSender;
    bucket?: string;
  } = {}
): Promise<void> {
  const parsedUrl = new URL(mediaUrl);
  if (parsedUrl.origin !== CLOUDFRONT_LINK) {
    return;
  }

  let key: string;
  try {
    key = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
  } catch {
    throw new BadRequestException('Invalid Main Stage media URL');
  }
  if (!key) {
    throw new BadRequestException('Invalid Main Stage media URL');
  }

  let contentLength: number | undefined;
  try {
    const response = await (dependencies.s3 ?? getS3()).send(
      new HeadObjectCommand({
        Bucket: dependencies.bucket ?? env.getStringOrThrow('S3_BUCKET'),
        Key: key
      })
    );
    contentLength = response.ContentLength;
  } catch {
    throw new BadRequestException(
      'Main Stage media could not be verified. Complete the upload before submitting.'
    );
  }

  if (
    typeof contentLength !== 'number' ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0
  ) {
    throw new BadRequestException(
      'Main Stage media size could not be verified'
    );
  }
  if (contentLength > MAX_MAIN_STAGE_MEDIA_BYTES) {
    throw new BadRequestException(
      `Main Stage media must not exceed ${MAIN_STAGE_MEDIA_LIMIT_MIB} MiB`
    );
  }
}
