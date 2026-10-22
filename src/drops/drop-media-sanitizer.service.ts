import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import Sharp from 'sharp';
import { Readable } from 'node:stream';
import { getS3 } from '@/s3.client';
import {
  DROP_MEDIA_CACHE_CONTROL,
  DROP_MEDIA_MAX_IMAGE_BYTES,
  DROP_MEDIA_FORMAT_VALIDATED_METADATA_KEY,
  DROP_MEDIA_SANITIZE_UPLOAD_METADATA_KEY,
  DROP_MEDIA_SANITIZED_METADATA_KEY,
  DROP_MEDIA_SANITIZED_METADATA_VALUE,
  getDropMediaIngestS3
} from '@/drops/drop-media-upload.config';
import {
  dropMediaUploadsDb,
  DropMediaUploadsDb
} from '@/drops/drop-media-uploads.db';
import {
  DropMediaUploadEntity,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';
import { Logger } from '@/logging';
import { Time } from '@/time';
import {
  dropMediaUploadStatusNotifier,
  DropMediaUploadStatusNotifier
} from '@/drops/drop-media-upload-status-notifier';

const ALLOWED_FORMAT_MIME_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
} as const;

type AllowedSharpFormat = keyof typeof ALLOWED_FORMAT_MIME_TYPES;
type SharpInstance = ReturnType<typeof Sharp>;
const SANITIZER_CLAIM_STALE_MS = Time.minutes(20).toMillis();

export class PermanentMediaSanitizationError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

export class DropMediaSanitizerService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly dropMediaUploadsDb: DropMediaUploadsDb,
    private readonly publicS3: () => S3Client = getS3,
    private readonly ingestS3: () => S3Client = getDropMediaIngestS3,
    private readonly notifier: DropMediaUploadStatusNotifier = dropMediaUploadStatusNotifier
  ) {}

  async processUpload({
    mediaUploadId,
    approximateReceiveCount
  }: {
    mediaUploadId: string;
    approximateReceiveCount: number;
  }): Promise<void> {
    const upload = await this.dropMediaUploadsDb.findById(mediaUploadId);
    if (!upload) {
      throw new PermanentMediaSanitizationError(
        `Drop media upload ${mediaUploadId} not found`
      );
    }
    if (upload.status === DropMediaUploadStatus.READY) {
      return;
    }
    if (upload.status === DropMediaUploadStatus.FAILED) {
      return;
    }
    if (!(await this.claimUploadForSanitizing(upload))) {
      return;
    }

    try {
      await this.sanitizeAndPublish(upload);
      const markedReady = await this.dropMediaUploadsDb.transitionStatus({
        id: upload.id,
        fromStatuses: [DropMediaUploadStatus.SANITIZING],
        toStatus: DropMediaUploadStatus.READY,
        patch: {
          error_reason: null,
          completed_at: Time.currentMillis()
        }
      });
      if (!markedReady) {
        return;
      }
      await this.notifier.notifyStatusTransition(upload.id);
    } catch (error) {
      await this.handleProcessingError({
        upload,
        error,
        approximateReceiveCount
      });
    }
  }

  private async claimUploadForSanitizing(
    upload: DropMediaUploadEntity
  ): Promise<boolean> {
    if (upload.status === DropMediaUploadStatus.PROCESSING) {
      return await this.dropMediaUploadsDb.transitionStatus({
        id: upload.id,
        fromStatuses: [DropMediaUploadStatus.PROCESSING],
        toStatus: DropMediaUploadStatus.SANITIZING
      });
    }

    if (upload.status !== DropMediaUploadStatus.SANITIZING) {
      throw new Error(
        `Drop media upload ${upload.id} is ${upload.status}, not processing`
      );
    }

    const staleBefore = Time.currentMillis() - SANITIZER_CLAIM_STALE_MS;
    if (Number(upload.updated_at) >= staleBefore) {
      throw new Error(`Drop media upload ${upload.id} is already sanitizing`);
    }

    return await this.dropMediaUploadsDb.transitionStatus({
      id: upload.id,
      fromStatuses: [DropMediaUploadStatus.SANITIZING],
      toStatus: DropMediaUploadStatus.SANITIZING,
      updatedBefore: staleBefore
    });
  }

  /** Strip image metadata, applying strict conversion limits to AVIF inputs. */
  async sanitizeBuffer({
    input,
    declaredMimeType
  }: {
    input: Buffer;
    declaredMimeType: string;
  }): Promise<{ buffer: Buffer; contentType: string }> {
    if (declaredMimeType.toLowerCase() === 'image/avif') {
      return await sanitizeAvif(input);
    }
    const { image, format, contentType } = await inspectImageFormat(
      input,
      declaredMimeType
    );
    const output = formatSharpOutput(image, format);
    return {
      buffer: await output.toBuffer(),
      contentType
    };
  }

  private async sanitizeAndPublish(
    upload: DropMediaUploadEntity
  ): Promise<void> {
    this.logger.info(`Validating drop media upload ${upload.id}`);
    const rawObject = await this.ingestS3().send(
      new GetObjectCommand({
        Bucket: upload.ingest_bucket,
        Key: upload.ingest_key
      })
    );
    if (!rawObject.Body) {
      throw new Error(`Ingest object body missing for ${upload.id}`);
    }

    const rawBuffer = await readImageSource(
      rawObject.Body,
      rawObject.ContentLength
    );
    // Multipart object metadata is fixed by the API, not by uploaded part bytes.
    // Missing policy belongs to an older in-flight upload: retain sanitization.
    const stripMetadata =
      rawObject.Metadata?.[DROP_MEDIA_SANITIZE_UPLOAD_METADATA_KEY] !==
        'false' || upload.declared_mime_type.toLowerCase() === 'image/avif';
    const imageToPublish = stripMetadata
      ? await this.sanitizeBuffer({
          input: rawBuffer,
          declaredMimeType: upload.declared_mime_type
        })
      : {
          buffer: rawBuffer,
          contentType: (
            await inspectImageFormat(rawBuffer, upload.declared_mime_type)
          ).contentType
        };

    await this.publicS3().send(
      new PutObjectCommand({
        Bucket: this.getPublicBucket(),
        Key: upload.public_key,
        Body: imageToPublish.buffer,
        ContentType: imageToPublish.contentType,
        CacheControl: DROP_MEDIA_CACHE_CONTROL,
        Metadata: {
          [DROP_MEDIA_FORMAT_VALIDATED_METADATA_KEY]: 'true',
          ...(stripMetadata
            ? {
                [DROP_MEDIA_SANITIZED_METADATA_KEY]:
                  DROP_MEDIA_SANITIZED_METADATA_VALUE
              }
            : {})
        }
      })
    );
    try {
      await this.ingestS3().send(
        new DeleteObjectCommand({
          Bucket: upload.ingest_bucket,
          Key: upload.ingest_key
        })
      );
    } catch (error) {
      this.logger.error(
        `Failed to delete ingest object for drop media upload ${upload.id}`,
        error
      );
    }
  }

  private async handleProcessingError({
    upload,
    error,
    approximateReceiveCount
  }: {
    upload: DropMediaUploadEntity;
    error: unknown;
    approximateReceiveCount: number;
  }): Promise<void> {
    const isPermanentInputError =
      error instanceof PermanentMediaSanitizationError;
    if (isPermanentInputError || approximateReceiveCount >= 3) {
      const errorReason =
        error instanceof Error ? error.message : String(error);
      await this.dropMediaUploadsDb.transitionStatus({
        id: upload.id,
        fromStatuses: [
          DropMediaUploadStatus.PROCESSING,
          DropMediaUploadStatus.SANITIZING
        ],
        toStatus: DropMediaUploadStatus.FAILED,
        patch: {
          error_reason: errorReason,
          completed_at: Time.currentMillis()
        }
      });
      await this.notifier.notifyStatusTransition(upload.id);
      if (isPermanentInputError) {
        this.logger.warn(
          `Drop media upload ${upload.id} rejected: ${errorReason}`
        );
      } else {
        this.logger.error(
          `Drop media upload ${upload.id} failed after retries: ${errorReason}`,
          error
        );
      }
      return;
    }
    throw error;
  }

  private getPublicBucket(): string {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_BUCKET is not configured');
    }
    return bucket;
  }
}

/** Verify the container format, without re-encoding or stripping original bytes. */
async function inspectImageFormat(input: Buffer, declaredMimeType: string) {
  assertImageContainerSignature(input);
  const image = Sharp(input, {
    animated: declaredMimeType.toLowerCase() === 'image/gif',
    failOn: 'none',
    limitInputPixels: 1_000_000_000
  }).rotate();
  const metadata = await image.metadata().catch((error: unknown) => {
    if (
      error instanceof Error &&
      /Input buffer (?:contains unsupported image format|has corrupt header)|Input image exceeds pixel limit/.test(
        error.message
      )
    ) {
      throw new PermanentMediaSanitizationError(
        'The image format could not be verified. Upload a complete JPEG, PNG, WebP or GIF image.'
      );
    }
    throw error;
  });
  if (metadata.format === 'heif' && metadata.compression === 'hevc') {
    throw new PermanentMediaSanitizationError(
      'HEIC/HEIF uploads are not supported. Export this image as JPEG or PNG; changing its filename does not convert it.'
    );
  }
  const format = metadata.format;
  if (!isAllowedSharpFormat(format)) {
    throw new PermanentMediaSanitizationError(
      `Unsupported image format ${format ?? 'unknown'}`
    );
  }
  const contentType = ALLOWED_FORMAT_MIME_TYPES[format];
  if (!declaredMimeTypeMatchesDetectedFormat(declaredMimeType, format)) {
    throw new PermanentMediaSanitizationError(
      `Declared MIME type ${declaredMimeType} does not match detected ${contentType}`
    );
  }
  return { image, format, contentType };
}

/** Do not hand unsupported containers (for example SVG) to native parsers. */
function assertImageContainerSignature(input: Buffer): void {
  const isJpeg =
    input.length >= 3 &&
    input[0] === 0xff &&
    input[1] === 0xd8 &&
    input[2] === 0xff;
  const isPng = input
    .subarray(0, 8)
    .equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const isGif = ['GIF87a', 'GIF89a'].includes(input.toString('ascii', 0, 6));
  const isWebp =
    input.toString('ascii', 0, 4) === 'RIFF' &&
    input.toString('ascii', 8, 12) === 'WEBP';
  const isHeif =
    input.length >= 16 &&
    input.toString('ascii', 4, 8) === 'ftyp' &&
    input.readUInt32BE(0) >= 16 &&
    input.readUInt32BE(0) <= Math.min(4096, input.length);
  if (!isJpeg && !isPng && !isGif && !isWebp && !isHeif) {
    throw new PermanentMediaSanitizationError(
      'Unsupported image format. Upload a complete JPEG, PNG, WebP, GIF or supported still AVIF image.'
    );
  }
}

/** Transport truncation stays operational; no public object is written on failure. */
async function readImageSource(
  body: { transformToByteArray(): Promise<Uint8Array> },
  contentLength: number | undefined
): Promise<Buffer> {
  try {
    if (
      contentLength === undefined ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0
    ) {
      throw new Error('Image ingest source length is unavailable');
    }
    if (contentLength > DROP_MEDIA_MAX_IMAGE_BYTES) {
      throw new PermanentMediaSanitizationError(
        'Image uploads must be 500 MB or smaller.'
      );
    }
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength !== contentLength)
      throw new Error('Image ingest source length mismatch');
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } finally {
    if (body instanceof Readable) body.destroy();
  }
}

/** Decode a bounded still AVIF and publish an oriented, metadata-free WebP. */
async function sanitizeAvif(
  input: Buffer
): Promise<{ buffer: Buffer; contentType: string }> {
  if (input.length > DROP_MEDIA_MAX_IMAGE_BYTES) {
    throw new PermanentMediaSanitizationError(
      'AVIF uploads must be 500 MB or smaller.'
    );
  }
  if (hasAvifSequenceBrand(input)) {
    throw new PermanentMediaSanitizationError(
      'Animated AVIF is not supported. Export a still AVIF image or use GIF.'
    );
  }
  if (input.length < 16 || input.toString('ascii', 4, 8) !== 'ftyp') {
    throw new PermanentMediaSanitizationError('The file is not an AVIF image.');
  }
  try {
    const image = Sharp(input, {
      failOn: 'error',
      limitInputPixels: 64_000_000
    }).timeout({ seconds: 60 });
    const metadata = await image.metadata();
    if (metadata.format !== 'heif' || metadata.compression !== 'av1') {
      throw new PermanentMediaSanitizationError(
        'The file is not an AVIF image.'
      );
    }
    if ((metadata.pages ?? 1) !== 1) {
      throw new PermanentMediaSanitizationError(
        'Animated AVIF is not supported. Export a still AVIF image or use GIF.'
      );
    }
    if ((metadata.width ?? 0) > 16383 || (metadata.height ?? 0) > 16383) {
      throw new PermanentMediaSanitizationError(
        'AVIF images must be no more than 16,383 pixels on either side.'
      );
    }
    return {
      // A standard WebP original also works in older supported native viewers.
      buffer: await image.rotate().webp({ quality: 95 }).toBuffer(),
      contentType: 'image/webp'
    };
  } catch (error) {
    if (error instanceof PermanentMediaSanitizationError) {
      throw error;
    }
    throw new PermanentMediaSanitizationError(
      'This AVIF could not be processed. Use a complete still image with no more than 64 million pixels.'
    );
  }
}

/** Reject sequence brands in a bounded ftyp box, skipping minor-version bytes. */
function hasAvifSequenceBrand(input: Buffer): boolean {
  if (input.length < 16 || input.toString('ascii', 4, 8) !== 'ftyp') {
    return false;
  }
  const boxSize = input.readUInt32BE(0);
  // Bound admission to a 4 KiB file-type header (up to 1,020 compatible brands).
  // The decoder still verifies the actual codec and page count below.
  if (boxSize > 4096) {
    throw new PermanentMediaSanitizationError('Invalid AVIF file-type header.');
  }
  const boxEnd = Math.min(boxSize, input.length);
  for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
    if (
      offset !== 12 &&
      input.toString('ascii', offset, offset + 4) === 'avis'
    ) {
      return true;
    }
  }
  return false;
}

function isAllowedSharpFormat(
  format: string | undefined
): format is AllowedSharpFormat {
  return !!format && format in ALLOWED_FORMAT_MIME_TYPES;
}

function declaredMimeTypeMatchesDetectedFormat(
  declaredMimeType: string,
  format: AllowedSharpFormat
): boolean {
  const normalized = declaredMimeType.toLowerCase();
  if (format === 'jpeg') {
    return normalized === 'image/jpeg' || normalized === 'image/jpg';
  }
  return normalized === ALLOWED_FORMAT_MIME_TYPES[format];
}

function formatSharpOutput(
  image: SharpInstance,
  format: AllowedSharpFormat
): SharpInstance {
  switch (format) {
    case 'jpeg':
      return image.jpeg({ quality: 95, mozjpeg: true });
    case 'png':
      return image.png();
    case 'webp':
      return image.webp({ quality: 95 });
    case 'gif':
      return image.gif();
  }
}

export const dropMediaSanitizerService = new DropMediaSanitizerService(
  dropMediaUploadsDb
);
