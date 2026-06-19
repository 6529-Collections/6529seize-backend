import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import Sharp from 'sharp';
import { getS3 } from '@/s3.client';
import {
  DROP_MEDIA_CACHE_CONTROL,
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
const SANITIZER_CLAIM_STALE_MS = Time.minutes(15).toMillis();

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

  async sanitizeBuffer({
    input,
    declaredMimeType
  }: {
    input: Buffer;
    declaredMimeType: string;
  }): Promise<{ buffer: Buffer; contentType: string }> {
    const animated = declaredMimeType.toLowerCase() === 'image/gif';
    const image = Sharp(input, {
      animated,
      failOn: 'none',
      limitInputPixels: 1_000_000_000
    }).rotate();
    const metadata = await image.metadata();
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

    const output = formatSharpOutput(image, format);
    return {
      buffer: await output.toBuffer(),
      contentType
    };
  }

  private async sanitizeAndPublish(
    upload: DropMediaUploadEntity
  ): Promise<void> {
    this.logger.info(`Sanitizing drop media upload ${upload.id}`);
    const rawObject = await this.ingestS3().send(
      new GetObjectCommand({
        Bucket: upload.ingest_bucket,
        Key: upload.ingest_key
      })
    );
    if (!rawObject.Body) {
      throw new Error(`Ingest object body missing for ${upload.id}`);
    }

    const rawBuffer = Buffer.from(
      await (rawObject.Body as any).transformToByteArray()
    );
    const sanitized = await this.sanitizeBuffer({
      input: rawBuffer,
      declaredMimeType: upload.declared_mime_type
    });

    await this.publicS3().send(
      new PutObjectCommand({
        Bucket: this.getPublicBucket(),
        Key: upload.public_key,
        Body: sanitized.buffer,
        ContentType: sanitized.contentType,
        CacheControl: DROP_MEDIA_CACHE_CONTROL,
        Metadata: {
          [DROP_MEDIA_SANITIZED_METADATA_KEY]:
            DROP_MEDIA_SANITIZED_METADATA_VALUE
        }
      })
    );
    await this.ingestS3().send(
      new DeleteObjectCommand({
        Bucket: upload.ingest_bucket,
        Key: upload.ingest_key
      })
    );
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
    if (
      error instanceof PermanentMediaSanitizationError ||
      approximateReceiveCount >= 3
    ) {
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
      this.logger.error(
        `Drop media upload ${upload.id} failed permanently: ${errorReason}`
      );
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
  image: Sharp.Sharp,
  format: AllowedSharpFormat
): Sharp.Sharp {
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
