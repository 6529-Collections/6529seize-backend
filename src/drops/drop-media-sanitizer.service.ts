import { createReadStream } from 'node:fs';
import { stat, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  withResizeSourceFile,
  UnprocessableResizeInput
} from '@/media/resize-input';
import {
  assertDecodedWorkBudget,
  inspectResizeInput,
  isUnprocessableResizeInput
} from '@/mediaResizerLoop/resize-resource-safety';
import { sanitizePngFile } from '@/media/png-preview';
import {
  LOSSLESS_STRIP_MAX_SOURCE_BYTES as DEFAULT_LOSSLESS_STRIP_MAX_SOURCE_BYTES,
  PIXEL_CHECK_LIMITS,
  stripMetadataWithPixelCheck
} from '@/media/metadata-strip/pixel-verified-metadata-strip';
import { releaseBuffer } from '@/media/metadata-strip/release-buffer';
import {
  prepareUploadImagePreviews,
  previewObjectKey,
  STANDARD_PREVIEW_HEIGHTS,
  UploadImagePreview
} from '@/media/upload-image-previews';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import Sharp, { Metadata } from 'sharp';
import { describeImage, MediaLayoutHints } from './media-placeholder';
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
  DropMediaUploadPurpose,
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
/** Told why a lossless strip could not be verified before re-encoding. */
type LosslessFallbackReporter = (format: string, reason: string) => void;
const SANITIZER_CLAIM_STALE_MS = Time.minutes(20).toMillis();
/**
 * Lossless rewriting holds the source and its output in memory, sized for
 * this Lambda's 2 GiB (see the metadata-strip default); larger sources keep
 * the file-based re-encoding path and its decode budget.
 */
export const LOSSLESS_STRIP_MAX_SOURCE_BYTES =
  DEFAULT_LOSSLESS_STRIP_MAX_SOURCE_BYTES;

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
    approximateReceiveCount,
    retryFailed = false
  }: {
    mediaUploadId: string;
    approximateReceiveCount: number;
    retryFailed?: boolean;
  }): Promise<void> {
    let upload = await this.dropMediaUploadsDb.findById(mediaUploadId);
    if (!upload) {
      throw new PermanentMediaSanitizationError(
        `Drop media upload ${mediaUploadId} not found`
      );
    }
    if (upload.status === DropMediaUploadStatus.READY) {
      await this.deleteIngestObject(upload);
      return;
    }
    if (upload.status === DropMediaUploadStatus.FAILED) {
      if (!retryFailed) return;
      const reset = await this.dropMediaUploadsDb.transitionStatus({
        id: upload.id,
        fromStatuses: [DropMediaUploadStatus.FAILED],
        toStatus: DropMediaUploadStatus.PROCESSING,
        patch: { error_reason: null, completed_at: null }
      });
      if (!reset) return;
      upload = { ...upload, status: DropMediaUploadStatus.PROCESSING };
    }
    if (!(await this.claimUploadForSanitizing(upload))) {
      return;
    }

    try {
      const hints = await this.sanitizeAndPublish(upload);
      const markedReady = await this.dropMediaUploadsDb.transitionStatus({
        id: upload.id,
        fromStatuses: [DropMediaUploadStatus.SANITIZING],
        toStatus: DropMediaUploadStatus.READY,
        patch: {
          error_reason: null,
          completed_at: Time.currentMillis(),
          ...(hints
            ? {
                width: hints.width,
                height: hints.height,
                thumbhash: hints.thumbhash
              }
            : {})
        }
      });
      if (!markedReady) {
        return;
      }
      await this.deleteIngestObject(upload);
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

  /**
   * Strip image metadata, losslessly when the result verifies and otherwise
   * by re-encoding, applying strict conversion limits to AVIF inputs.
   */
  async sanitizeBuffer({
    input,
    declaredMimeType
  }: {
    input: Buffer;
    declaredMimeType: string;
  }): Promise<{ buffer: Buffer; contentType: string }> {
    if (declaredMimeType.toLowerCase() === 'image/avif') {
      return {
        buffer: await withAvifImage(input, (image) =>
          image.rotate().webp({ quality: 95 }).toBuffer()
        ),
        contentType: 'image/webp'
      };
    }
    const { image, format, contentType } = await inspectImageFormat(
      input,
      declaredMimeType
    );
    const lossless = await stripMetadataWithPixelCheck(input, format);
    if (lossless.kind === 'lossless') {
      return { buffer: lossless.buffer, contentType };
    }
    this.reportLosslessFallback('in-memory image')(format, lossless.reason);
    const output = formatSharpOutput(image, format);
    return {
      buffer: await output.toBuffer(),
      contentType
    };
  }

  private reportLosslessFallback(subject: string): LosslessFallbackReporter {
    return (format, reason) =>
      this.logger.warn(
        `Lossless metadata strip of ${format} ${subject} did not verify; re-encoding instead: ${reason}`
      );
  }

  private async sanitizeAndPublish(
    upload: DropMediaUploadEntity
  ): Promise<MediaLayoutHints | null> {
    this.logger.info(`Validating drop media upload ${upload.id}`);
    const rawObject = await this.ingestS3().send(
      new GetObjectCommand({
        Bucket: upload.ingest_bucket,
        Key: upload.ingest_key
      })
    );
    if (!(rawObject.Body instanceof Readable)) {
      throw new TypeError(
        `Ingest object body is not a Node stream for ${upload.id}`
      );
    }
    const source = rawObject.Body;
    const contentLength = rawObject.ContentLength;
    if (!Number.isSafeInteger(contentLength) || contentLength! < 0) {
      source.destroy();
      throw new Error('Image ingest source length is unavailable');
    }
    const stripMetadata = shouldStripImageMetadata(
      upload,
      rawObject.Metadata?.[DROP_MEDIA_SANITIZE_UPLOAD_METADATA_KEY]
    );
    let hints: MediaLayoutHints | null = null;
    await withResizeSourceFile(source, contentLength, async (path) => {
      const published = await preparePublishedImageFile(
        path,
        upload.declared_mime_type,
        stripMetadata,
        this.reportLosslessFallback(`drop media upload ${upload.id}`)
      );
      if ((await stat(published.path)).size > DROP_MEDIA_MAX_IMAGE_BYTES)
        throw new UnprocessableResizeInput('OUTPUT_TOO_LARGE');
      const previews = await prepareUploadImagePreviews(
        published.path,
        published.contentType
      );
      await this.publishImageAndPreviews(
        upload,
        published.path,
        published.contentType,
        stripMetadata,
        previews
      );
      hints = await this.describePublishedImage(upload.id, published.path);
    });
    return hints;
  }

  /**
   * Layout hints are a best-effort extra (waves R11-2): an image that cannot
   * be described still publishes, and clients render it as before.
   */
  private async describePublishedImage(
    uploadId: string,
    path: string
  ): Promise<MediaLayoutHints | null> {
    try {
      return await describeImage(path);
    } catch (error) {
      this.logger.warn(
        `Could not compute layout hints for drop media upload ${uploadId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private async deleteIngestObject(
    upload: DropMediaUploadEntity
  ): Promise<void> {
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

  private async putImageFile(
    key: string,
    path: string,
    contentType: string,
    metadata?: Record<string, string>,
    cacheControl = DROP_MEDIA_CACHE_CONTROL
  ): Promise<void> {
    const contentLength = (await stat(path)).size;
    const body = createReadStream(path);
    // S3 can reject before attaching a reader; cleanup must not emit an
    // unhandled source error after the owning directory has been removed.
    body.on('error', () => undefined);
    try {
      await this.publicS3().send(
        new PutObjectCommand({
          Bucket: this.getPublicBucket(),
          Key: key,
          Body: body,
          ContentLength: contentLength,
          ContentType: contentType,
          CacheControl: cacheControl,
          Metadata: metadata
        })
      );
    } finally {
      body.destroy();
    }
  }

  private async publishImageAndPreviews(
    upload: DropMediaUploadEntity,
    body: string,
    contentType: string,
    stripMetadata: boolean,
    previews: UploadImagePreview[]
  ): Promise<void> {
    const metadata = {
      [DROP_MEDIA_FORMAT_VALIDATED_METADATA_KEY]: 'true',
      ...(stripMetadata
        ? {
            [DROP_MEDIA_SANITIZED_METADATA_KEY]:
              DROP_MEDIA_SANITIZED_METADATA_VALUE
          }
        : {})
    };
    await this.putImageFile(upload.public_key, body, contentType, metadata);
    for (const preview of previews)
      await this.putImageFile(
        previewObjectKey(upload.public_key, preview.option),
        preview.path,
        preview.contentType,
        undefined,
        'public, max-age=86400'
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
    const isPermanentInputError =
      error instanceof PermanentMediaSanitizationError ||
      isUnprocessableResizeInput(error);
    if (isPermanentInputError || approximateReceiveCount >= 3) {
      const errorReason = imageProcessingErrorReason(error);
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

/**
 * AVIF always converts (and so loses metadata). Otherwise a decision entry
 * keeps the artist's original bytes; chat and older uploads follow the policy
 * the API recorded on the ingest object at upload start, where a missing
 * policy (older queued uploads) keeps stripping.
 */
export function shouldStripImageMetadata(
  upload: Pick<DropMediaUploadEntity, 'declared_mime_type' | 'purpose'>,
  ingestPolicy: string | undefined
): boolean {
  if (upload.declared_mime_type.toLowerCase() === 'image/avif') return true;
  if (upload.purpose === DropMediaUploadPurpose.DECISION_ENTRY) return false;
  return ingestPolicy !== 'false';
}

/** Verify the container format, without re-encoding or stripping original bytes. */
async function inspectImageFormat(
  input: Buffer | string,
  declaredMimeType: string
) {
  assertImageContainerSignature(await imageHeader(input));
  const image = Sharp(input, {
    animated: declaredMimeType.toLowerCase() === 'image/gif',
    failOn: 'none',
    limitInputPixels: 1_000_000_000
  }).rotate();
  const metadata = await image.metadata().catch((error: unknown) => {
    if (
      error instanceof Error &&
      /Input (?:buffer|file) (?:contains unsupported image format|has corrupt header)|Input image exceeds pixel limit/.test(
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
  return { image, format, contentType, metadata };
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

/** Read only the bounded container header; large sources stay on disk. */
async function imageHeader(input: Buffer | string): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input.subarray(0, 4096);
  const file = await open(input, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/**
 * Strip losslessly into the output file when the result verifies; false means
 * the caller re-encodes. Rewriting a container needs random access, so the
 * source is read into memory, which is why it is size-bounded. Both buffers
 * are freed before returning: the PNG preview worker that follows shares a
 * parent-plus-child RSS limit with this process.
 */
async function stripFileLosslessly(
  input: string,
  output: string,
  format: AllowedSharpFormat,
  reportFallback: LosslessFallbackReporter
): Promise<boolean> {
  if ((await stat(input)).size > LOSSLESS_STRIP_MAX_SOURCE_BYTES) {
    reportFallback(format, 'source is larger than the lossless strip limit');
    return false;
  }
  const source = await readFile(input);
  try {
    const result = await stripMetadataWithPixelCheck(source, format, {
      maxSourceBytes: LOSSLESS_STRIP_MAX_SOURCE_BYTES
    });
    if (result.kind === 'unverified') {
      reportFallback(format, result.reason);
      return false;
    }
    try {
      await writeFile(output, result.buffer);
    } finally {
      releaseBuffer(result.buffer);
    }
    return true;
  } finally {
    releaseBuffer(source);
  }
}

/** Preserve original bytes when requested; previews never buffer in Node. */
async function preparePublishedImageFile(
  input: string,
  declaredMimeType: string,
  stripMetadata: boolean,
  reportFallback: LosslessFallbackReporter
): Promise<{ path: string; contentType: string }> {
  const output = join(dirname(input), 'sanitized');
  if (declaredMimeType.toLowerCase() === 'image/avif') {
    await withAvifImage(input, async (image) => {
      await image.rotate().webp({ quality: 95 }).toFile(output);
    });
    return { path: output, contentType: 'image/webp' };
  }
  // Verify the declared PNG signature before invoking its isolated native parser.
  if (declaredMimeType.toLowerCase() === 'image/png') {
    const header = await imageHeader(input);
    if (!header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      throw new PermanentMediaSanitizationError(
        'Declared PNG does not match the uploaded image. Export a complete PNG and try again.'
      );
    if (!stripMetadata) return { path: input, contentType: 'image/png' };
    if (await stripFileLosslessly(input, output, 'png', reportFallback)) {
      return { path: output, contentType: 'image/png' };
    }
    return { path: await sanitizePngFile(input), contentType: 'image/png' };
  }
  const { image, format, contentType, metadata } = await inspectImageFormat(
    input,
    declaredMimeType
  );
  await assertImageUploadFits(input, metadata, stripMetadata);
  if (!stripMetadata) return { path: input, contentType };
  if (await stripFileLosslessly(input, output, format, reportFallback)) {
    return { path: output, contentType };
  }
  // Original re-encoding cannot use preview shrink or still-frame fallback.
  assertDecodedWorkBudget(metadata, format === 'gif');
  await formatSharpOutput(image, format)
    .timeout({ seconds: 30 })
    .toFile(output);
  return { path: output, contentType };
}

/** Reject known budget failures from metadata before stripping or decoding. */
async function assertImageUploadFits(
  input: string,
  metadata: Metadata,
  stripMetadata: boolean
): Promise<void> {
  try {
    // The larger mandatory preview is the stricter JPEG shrink target.
    await inspectResizeInput(input, metadata.format === 'gif', {
      width: null,
      height: Math.max(...STANDARD_PREVIEW_HEIGHTS)
    });
    if (
      stripMetadata &&
      ((await stat(input)).size > LOSSLESS_STRIP_MAX_SOURCE_BYTES ||
        (metadata.width ?? 0) * (metadata.height ?? 0) >
          PIXEL_CHECK_LIMITS.maxPixels)
    ) {
      assertDecodedWorkBudget(metadata, metadata.format === 'gif');
    }
  } catch (error) {
    if (
      error instanceof UnprocessableResizeInput &&
      error.code === 'DECODED_IMAGE_TOO_LARGE'
    ) {
      throw new PermanentMediaSanitizationError(
        `This image is too large to process (${metadata.width} x ${metadata.pageHeight ?? metadata.height} pixels). Reduce its dimensions or animation frame count and upload again.`
      );
    }
    throw error;
  }
}

/** Decode a bounded still AVIF and publish an oriented, metadata-free WebP. */
async function withAvifImage<T>(
  input: Buffer | string,
  useImage: (image: SharpInstance) => Promise<T>
): Promise<T> {
  const bytes = Buffer.isBuffer(input)
    ? input.length
    : (await stat(input)).size;
  if (bytes > DROP_MEDIA_MAX_IMAGE_BYTES) {
    throw new PermanentMediaSanitizationError(
      'Image uploads must be 256 MiB or smaller.'
    );
  }
  const header = await imageHeader(input);
  if (hasAvifSequenceBrand(header)) {
    throw new PermanentMediaSanitizationError(
      'Animated AVIF is not supported. Export a still AVIF image or use GIF.'
    );
  }
  if (header.length < 16 || header.toString('ascii', 4, 8) !== 'ftyp') {
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
    return await useImage(image);
  } catch (error) {
    // File I/O is operational; it must not classify a valid image as invalid.
    if (
      error instanceof PermanentMediaSanitizationError ||
      (error instanceof Error && 'code' in error)
    )
      throw error;
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

function imageProcessingErrorReason(error: unknown): string {
  if (error instanceof UnprocessableResizeInput) {
    if (error.code === 'SOURCE_TOO_LARGE')
      return 'Image uploads must be 256 MiB or smaller.';
    if (error.code === 'DECODED_IMAGE_TOO_LARGE')
      return 'This image is too large to process. Reduce its dimensions or animation frame count and upload again.';
    return 'This image cannot produce a usable preview. Reduce its dimensions or export a complete supported image and upload again.';
  }
  if (isUnprocessableResizeInput(error))
    return 'This image could not be decoded. Upload a complete supported image.';
  if (error instanceof Error && error.message.startsWith('PNG_PREVIEW_'))
    return 'Preview processing is temporarily unavailable. Please try uploading again later.';
  return error instanceof Error ? error.message : String(error);
}
