import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getS3 } from '../../../s3.client';
import { randomUUID } from 'crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Time } from '../../../time';
import { ApiCreateMediaUrlResponse } from '../generated/models/ApiCreateMediaUrlResponse';
import { ApiCompleteMultipartUploadResponse } from '../generated/models/ApiCompleteMultipartUploadResponse';
import { ApiDropMediaStatus } from '../generated/models/ApiDropMediaStatus';
import { ApiStartMultipartMediaUploadResponse } from '../generated/models/ApiStartMultipartMediaUploadResponse';
import { getFileExtension, slugifyBaseName } from './sanitize-file-name';
import { CLOUDFRONT_LINK } from '@/constants';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { Logger } from '@/logging';
import { MAX_DIRECT_MULTIPART_MEDIA_BYTES } from '@/api/media/media-upload-limits';
import {
  MediaUploadBudget,
  mediaUploadBudgetService
} from '@/api/media/media-upload-budget.service';
import { MediaUploadBudgetSource } from '@/entities/IMediaUploadBudget';
import {
  createDropMediaIngestKey,
  DROP_MEDIA_SANITIZE_UPLOAD_METADATA_KEY,
  getDropMediaIngestS3,
  getDropMediaIngestS3Bucket,
  getPublishedDropMediaMimeType,
  isDropMediaSanitizationEnabled,
  isImageMimeType
} from '@/drops/drop-media-upload.config';
import {
  DropMediaUploadsDb,
  dropMediaUploadsDb as defaultDropMediaUploadsDb
} from '@/drops/drop-media-uploads.db';
import {
  DropMediaUploadEntity,
  DropMediaUploadPurpose,
  DropMediaUploadSource,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';
import { enqueueDropMediaSanitization } from '@/drops/drop-media-sanitizer-queue';
import { storeDeviceVideoPoster } from './device-video-poster';
import { IMMUTABLE_MEDIA_CACHE_CONTROL } from '@/media/media-cache-control';

type MediaUploadSource =
  | DropMediaUploadSource.DROP
  | DropMediaUploadSource.WAVE;

type SanitizerQueue = (input: { mediaUploadId: string }) => Promise<void>;

/** A reserved public key and the id of its upload record (also its folder). */
interface ReservedMediaKey {
  readonly key: string;
  readonly uploadId: string;
}

/** The distribution photo a multipart upload belongs to (admin routes). */
export interface DistributionPhotoScope {
  readonly contract: string;
  readonly cardId: number;
}

export const SINGLE_PUT_UPLOAD_URL_EXPIRY = Time.minutes(15);

export class UploadMediaService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly getS3: () => S3Client,
    private readonly getIngestS3: () => S3Client = getDropMediaIngestS3,
    private readonly dropMediaUploadsDb: DropMediaUploadsDb = defaultDropMediaUploadsDb,
    private readonly enqueueSanitization: SanitizerQueue = enqueueDropMediaSanitization,
    private readonly uploadBudget: MediaUploadBudget = mediaUploadBudgetService
  ) {}

  public async createSingedDropMediaUploadUrl({
    content_type,
    file_name,
    author_id,
    purpose = DropMediaUploadPurpose.CHAT
  }: {
    content_type: string;
    file_name: string;
    author_id: string;
    purpose?: DropMediaUploadPurpose;
  }): Promise<{ upload_url: string; media_url: string; content_type: string }> {
    this.assertSinglePutImageUploadAllowed(content_type);
    const { key, uploadId } = this.createDropMediaKey({ file_name, purpose });
    return await this.withBudgetedUpload(
      {
        id: uploadId,
        profileId: author_id,
        source: MediaUploadBudgetSource.DROP,
        pendingObjectKey: key
      },
      async () => {
        const result = await this.createSignedMediaUrl({ key, content_type });
        await this.recordPublicUploadOwner({
          id: uploadId,
          key,
          contentType: content_type,
          authorId: author_id,
          s3UploadId: `single-put:${randomUUID()}`,
          purpose,
          ready: true
        });
        return result;
      }
    );
  }

  public async createSingedWaveMediaUploadUrl({
    content_type,
    file_name,
    author_id
  }: {
    author_id: string;
    file_name: string;
    content_type: string;
  }): Promise<ApiCreateMediaUrlResponse> {
    this.assertSinglePutImageUploadAllowed(content_type);
    const { key, uploadId } = this.createWaveMediaKey({ file_name, author_id });
    return await this.withBudgetedUpload(
      {
        id: uploadId,
        profileId: author_id,
        source: MediaUploadBudgetSource.WAVE,
        pendingObjectKey: key
      },
      () => this.createSignedMediaUrl({ key, content_type })
    );
  }

  /**
   * Counts the upload against its author's rolling upload budget (429 once
   * it is used up) before anything is created, and gives the reservation
   * back if preparing the upload fails.
   */
  private async withBudgetedUpload<T>(
    reservation: {
      id: string;
      profileId: string;
      source: MediaUploadBudgetSource;
      pendingObjectKey?: string;
    },
    prepare: () => Promise<T>
  ): Promise<T> {
    await this.uploadBudget.reserve({
      ...reservation,
      readObjectSize: (key) => this.readPublicObjectSize(key)
    });
    try {
      return await prepare();
    } catch (error) {
      await this.uploadBudget.release(reservation.id, reservation.profileId);
      throw error;
    }
  }

  /** The stored size of a public object; null when it does not exist. */
  private async readPublicObjectSize(key: string): Promise<number | null> {
    try {
      const head = await this.getS3().send(
        new HeadObjectCommand({ Bucket: this.getS3Bucket(), Key: key })
      );
      return typeof head.ContentLength === 'number' ? head.ContentLength : null;
    } catch (error) {
      // Without list permission S3 answers a missing key with 403.
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return null;
      throw error;
    }
  }

  /** Wave pictures are always chat media: stripped, with a neutral name. */
  async getWaveMediaMultipartUploadKeyAndUploadId({
    content_type,
    file_name,
    author_id
  }: {
    content_type: string;
    file_name: string;
    author_id: string;
  }): Promise<ApiStartMultipartMediaUploadResponse> {
    return await this.createMultipartUpload({
      ...this.createWaveMediaKey({ file_name, author_id }),
      content_type,
      author_id,
      source: DropMediaUploadSource.WAVE,
      purpose: DropMediaUploadPurpose.CHAT
    });
  }

  /** Reserve a unique public key using the converted format for AVIF uploads. */
  async getDropMediaMultipartUploadKeyAndUploadId({
    content_type,
    file_name,
    author_id,
    purpose = DropMediaUploadPurpose.CHAT
  }: {
    author_id: string;
    file_name: string;
    content_type: string;
    purpose?: DropMediaUploadPurpose;
  }): Promise<ApiStartMultipartMediaUploadResponse> {
    const reserved = this.createDropMediaKey({
      file_name:
        content_type === 'image/avif'
          ? file_name.replace(/\.[^.]+$/, '.webp')
          : file_name,
      purpose
    });

    return await this.createMultipartUpload({
      ...reserved,
      content_type,
      author_id,
      source: DropMediaUploadSource.DROP,
      purpose
    });
  }

  async getSignedUrlForPartOfMultipartUpload({
    upload_id,
    key,
    part_no,
    authenticatedProfileId,
    distributionPhoto
  }: {
    upload_id: string;
    key: string;
    part_no: number;
    authenticatedProfileId?: string;
    distributionPhoto?: DistributionPhotoScope;
  }): Promise<string> {
    const upload = await this.findTrackedDropMediaUpload({ key, upload_id });
    this.assertDropMediaUploadOwner({
      upload,
      key,
      authenticatedProfileId,
      distributionPhoto
    });
    this.assertImageUploadIsTracked(key, upload);
    const bucket = upload?.ingest_bucket ?? this.getS3Bucket();
    const objectKey = upload?.ingest_key ?? key;
    const s3 =
      upload && this.isPrivateImageUpload(upload)
        ? this.getIngestS3()
        : this.getS3();
    const command = new UploadPartCommand({
      Bucket: bucket,
      Key: objectKey,
      PartNumber: part_no,
      UploadId: upload_id
    });

    return await getSignedUrl(s3, command, {
      expiresIn: Time.hours(1).toSeconds()
    });
  }

  async completeMultipartUpload({
    key,
    upload_id,
    parts,
    authenticatedProfileId,
    distributionPhoto,
    video_poster_base64
  }: {
    upload_id: string;
    key: string;
    parts: { etag: string; part_no: number }[];
    authenticatedProfileId?: string;
    distributionPhoto?: DistributionPhotoScope;
    video_poster_base64?: string;
  }): Promise<ApiCompleteMultipartUploadResponse> {
    const upload = await this.findTrackedDropMediaUpload({ key, upload_id });
    this.assertDropMediaUploadOwner({
      upload,
      key,
      authenticatedProfileId,
      distributionPhoto
    });
    this.assertImageUploadIsTracked(key, upload);
    if (upload && this.isPrivateImageUpload(upload)) {
      return await this.completeSanitizedImageMultipartUpload({
        upload,
        parts
      });
    }

    if (upload?.status === DropMediaUploadStatus.READY) {
      return {
        media_url: upload.public_url,
        media_status: ApiDropMediaStatus.Ready
      };
    }
    if (upload?.status === DropMediaUploadStatus.FAILED) {
      throw new BadRequestException('Media upload has failed');
    }

    await storeDeviceVideoPoster({
      s3: this.getS3(),
      bucket: this.getS3Bucket(),
      key,
      uploadId: upload_id,
      base64: video_poster_base64
    });

    const completeCmd = new CompleteMultipartUploadCommand({
      Bucket: this.getS3Bucket(),
      Key: key,
      UploadId: upload_id,
      MultipartUpload: {
        Parts: parts.map((part) => ({
          ETag: part.etag.replace(/(^")|("$)/g, ''),
          PartNumber: part.part_no
        }))
      }
    });

    const completeResp = await this.getS3().send(completeCmd);
    const size = await this.assertCompletedMediaWithinLimit({ key, upload });
    if (upload) {
      // Tracked uploads are the budgeted ones (their id is the entry's id).
      await this.uploadBudget.recordSize(upload.id, upload.profile_id, size);
      await this.dropMediaUploadsDb.updateUpload({
        id: upload.id,
        patch: {
          status: DropMediaUploadStatus.READY,
          completed_at: Time.currentMillis()
        }
      });
    }
    return {
      media_url: `${CLOUDFRONT_LINK}/${completeResp.Key}`,
      media_status: ApiDropMediaStatus.Ready
    };
  }

  /**
   * Media published straight from a multipart upload has no later processing
   * step that checks its size: read the completed object's size from S3 and
   * refuse it above the documented transport limit. A refused object is
   * removed (best effort) and its upload record marked failed, so it cannot
   * be attached to a drop.
   */
  private async assertCompletedMediaWithinLimit({
    key,
    upload
  }: {
    key: string;
    upload: DropMediaUploadEntity | null;
  }): Promise<number> {
    const bucket = this.getS3Bucket();
    const head = await this.getS3().send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    const size = head.ContentLength;
    if (typeof size !== 'number') {
      throw new Error(`Could not read the size of completed media ${key}`);
    }
    if (size <= MAX_DIRECT_MULTIPART_MEDIA_BYTES) {
      return size;
    }
    try {
      await this.getS3().send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key })
      );
    } catch (error) {
      this.logger.warn(
        `Could not remove oversized media ${key}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const limitMib = MAX_DIRECT_MULTIPART_MEDIA_BYTES / (1024 * 1024);
    if (upload) {
      await this.dropMediaUploadsDb.updateUpload({
        id: upload.id,
        patch: {
          status: DropMediaUploadStatus.FAILED,
          error_reason: `Media is larger than ${limitMib} MiB`,
          completed_at: Time.currentMillis()
        }
      });
    }
    throw new CustomApiCompliantException(
      413,
      `Media files can be at most ${limitMib} MiB`,
      'MEDIA_TOO_LARGE',
      { max_bytes: MAX_DIRECT_MULTIPART_MEDIA_BYTES }
    );
  }

  public async createSignedDistributionPhotoUploadUrl({
    content_type,
    file_name,
    contract,
    card_id
  }: {
    content_type: string;
    file_name: string;
    contract: string;
    card_id: number;
  }): Promise<{ upload_url: string; media_url: string; content_type: string }> {
    const key = this.createDistributionPhotoKey({
      file_name,
      contract,
      card_id
    });
    return await this.createSignedMediaUrl({ key, content_type });
  }

  async getDistributionPhotoMultipartUploadKeyAndUploadId({
    content_type,
    file_name,
    contract,
    card_id
  }: {
    content_type: string;
    file_name: string;
    contract: string;
    card_id: number;
  }): Promise<{ key: string; upload_id: string }> {
    const key = this.createDistributionPhotoKey({
      file_name,
      contract,
      card_id
    });
    const uploadId = await this.createMultipartUploadId({
      key,
      content_type,
      bucket: this.getS3Bucket(),
      s3: this.getS3(),
      cacheControl: IMMUTABLE_MEDIA_CACHE_CONTROL
    });
    return {
      key,
      upload_id: uploadId
    };
  }

  private createDistributionPhotoKey({
    file_name,
    contract,
    card_id
  }: {
    file_name: string;
    contract: string;
    card_id: number;
  }): string {
    const fileExtension = getFileExtension(file_name);
    return `${this.distributionPhotoKeyPrefix({ contract, cardId: card_id })}${randomUUID()}${fileExtension}`;
  }

  /** Every key issued for one card's distribution photos starts with this. */
  private distributionPhotoKeyPrefix({
    contract,
    cardId
  }: DistributionPhotoScope): string {
    return `distribution/${process.env.NODE_ENV}/${contract.toLowerCase()}/${cardId}-`;
  }

  /** The author prefix stays: untracked wave keys are owner-checked by it. */
  private createWaveMediaKey({
    file_name,
    author_id
  }: {
    file_name: string;
    author_id: string;
  }): ReservedMediaKey {
    const uploadId = randomUUID();
    return {
      key: `waves/author_${author_id}/${neutralMediaFileName(uploadId, file_name)}`,
      uploadId
    };
  }

  /**
   * Chat media gets a neutral name (`<uploadId>.<ext>`) so the public URL
   * never reveals the uploader's file name; decision entries keep a slug of
   * the artist's file name. The folder is the upload record's id, which lets
   * drop creation find the record from the media URL.
   */
  private createDropMediaKey({
    file_name,
    purpose
  }: {
    file_name: string;
    purpose: DropMediaUploadPurpose;
  }): ReservedMediaKey {
    const uploadId = randomUUID();
    if (purpose !== DropMediaUploadPurpose.DECISION_ENTRY) {
      return {
        key: `drops/${uploadId}/${neutralMediaFileName(uploadId, file_name)}`,
        uploadId
      };
    }
    const fileExtension = getFileExtension(file_name);
    const baseName = fileExtension
      ? file_name.substring(0, file_name.length - fileExtension.length)
      : file_name;
    const slug = slugifyBaseName(baseName);
    const sanitizedFileName = slug
      ? `${slug}${fileExtension}`
      : `${uploadId}${fileExtension}`;
    return { key: `drops/${uploadId}/${sanitizedFileName}`, uploadId };
  }

  private async createMultipartUpload(
    upload: ReservedMediaKey & {
      content_type: string;
      author_id: string;
      source: MediaUploadSource;
      purpose: DropMediaUploadPurpose;
    }
  ): Promise<ApiStartMultipartMediaUploadResponse> {
    return await this.withBudgetedUpload(
      {
        id: upload.uploadId,
        profileId: upload.author_id,
        source:
          upload.source === DropMediaUploadSource.WAVE
            ? MediaUploadBudgetSource.WAVE
            : MediaUploadBudgetSource.DROP
      },
      () => this.startMultipartUpload(upload)
    );
  }

  private async startMultipartUpload({
    key,
    uploadId: mediaUploadId,
    content_type,
    author_id,
    source,
    purpose
  }: ReservedMediaKey & {
    content_type: string;
    author_id: string;
    source: MediaUploadSource;
    purpose: DropMediaUploadPurpose;
  }): Promise<ApiStartMultipartMediaUploadResponse> {
    if (!isImageMimeType(content_type)) {
      const uploadId = await this.createMultipartUploadId({
        key,
        content_type,
        bucket: this.getS3Bucket(),
        s3: this.getS3(),
        cacheControl: IMMUTABLE_MEDIA_CACHE_CONTROL
      });
      if (source === DropMediaUploadSource.DROP) {
        await this.recordPublicUploadOwner({
          id: mediaUploadId,
          key,
          contentType: content_type,
          authorId: author_id,
          s3UploadId: uploadId,
          purpose
        });
      }
      return {
        key,
        upload_id: uploadId
      };
    }

    const ingestBucket = getDropMediaIngestS3Bucket();
    const ingestKey = createDropMediaIngestKey({
      source,
      publicKey: key
    });
    const uploadId = await this.createMultipartUploadId({
      key: ingestKey,
      content_type,
      bucket: ingestBucket,
      s3: this.getIngestS3(),
      metadata: {
        // Decision entries are never stripped, even by a sanitizer that
        // predates the purpose column.
        [DROP_MEDIA_SANITIZE_UPLOAD_METADATA_KEY]: String(
          isDropMediaSanitizationEnabled() &&
            purpose !== DropMediaUploadPurpose.DECISION_ENTRY
        )
      }
    });
    const now = Time.currentMillis();
    await this.dropMediaUploadsDb.createUpload({
      id: mediaUploadId,
      profile_id: author_id,
      source,
      public_key: key,
      public_url: `${CLOUDFRONT_LINK}/${key}`,
      ingest_bucket: ingestBucket,
      ingest_key: ingestKey,
      s3_upload_id: uploadId,
      declared_mime_type: content_type,
      status: DropMediaUploadStatus.UPLOADING,
      error_reason: null,
      drop_id: null,
      wave_id: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      purpose
    } satisfies DropMediaUploadEntity);

    return {
      key,
      upload_id: uploadId,
      media_upload_id: mediaUploadId,
      media_status: ApiDropMediaStatus.Uploading
    };
  }

  /** Random public object paths carry no profile ID; ownership stays private. */
  private async recordPublicUploadOwner({
    id,
    key,
    contentType,
    authorId,
    s3UploadId,
    purpose,
    ready = false
  }: {
    id: string;
    key: string;
    contentType: string;
    authorId: string;
    s3UploadId: string;
    purpose: DropMediaUploadPurpose;
    ready?: boolean;
  }): Promise<void> {
    const now = Time.currentMillis();
    await this.dropMediaUploadsDb.createUpload({
      id,
      profile_id: authorId,
      source: DropMediaUploadSource.DROP,
      public_key: key,
      public_url: `${CLOUDFRONT_LINK}/${key}`,
      ingest_bucket: this.getS3Bucket(),
      ingest_key: key,
      s3_upload_id: s3UploadId,
      declared_mime_type: contentType,
      status: ready
        ? DropMediaUploadStatus.READY
        : DropMediaUploadStatus.UPLOADING,
      error_reason: null,
      drop_id: null,
      wave_id: null,
      created_at: now,
      updated_at: now,
      completed_at: ready ? now : null,
      purpose
    });
  }

  private isPrivateImageUpload(upload: DropMediaUploadEntity): boolean {
    return (
      !upload.declared_mime_type || isImageMimeType(upload.declared_mime_type)
    );
  }

  /** Complete private ingest once and report the eventual public media type. */
  private async completeSanitizedImageMultipartUpload({
    upload,
    parts
  }: {
    upload: DropMediaUploadEntity;
    parts: { etag: string; part_no: number }[];
  }): Promise<ApiCompleteMultipartUploadResponse> {
    if (upload.status === DropMediaUploadStatus.READY) {
      return {
        media_url: upload.public_url,
        mime_type: getPublishedDropMediaMimeType(upload.declared_mime_type),
        media_upload_id: upload.id,
        media_status: ApiDropMediaStatus.Ready
      };
    }
    if (upload.status === DropMediaUploadStatus.FAILED) {
      throw new BadRequestException('Media upload has failed');
    }

    if (upload.status === DropMediaUploadStatus.UPLOADING) {
      const claimedForCompletion =
        await this.dropMediaUploadsDb.transitionStatus({
          id: upload.id,
          fromStatuses: [DropMediaUploadStatus.UPLOADING],
          toStatus: DropMediaUploadStatus.COMPLETING
        });
      if (!claimedForCompletion) {
        return this.processingResponse(upload);
      }

      const completeCmd = new CompleteMultipartUploadCommand({
        Bucket: upload.ingest_bucket,
        Key: upload.ingest_key,
        UploadId: upload.s3_upload_id,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            ETag: part.etag.replace(/(^")|("$)/g, ''),
            PartNumber: part.part_no
          }))
        }
      });

      try {
        await this.getIngestS3().send(completeCmd);
      } catch (error) {
        await this.dropMediaUploadsDb.transitionStatus({
          id: upload.id,
          fromStatuses: [DropMediaUploadStatus.COMPLETING],
          toStatus: DropMediaUploadStatus.FAILED,
          patch: {
            error_reason:
              error instanceof Error ? error.message : String(error),
            completed_at: Time.currentMillis()
          }
        });
        throw error;
      }
      const markedProcessing = await this.dropMediaUploadsDb.transitionStatus({
        id: upload.id,
        fromStatuses: [DropMediaUploadStatus.COMPLETING],
        toStatus: DropMediaUploadStatus.PROCESSING
      });
      if (!markedProcessing) {
        throw new Error(
          `Drop media upload ${upload.id} is not in uploading state`
        );
      }
      await this.recordIngestUploadSize(upload);
    } else if (
      upload.status === DropMediaUploadStatus.COMPLETING ||
      upload.status === DropMediaUploadStatus.SANITIZING
    ) {
      return {
        media_url: upload.public_url,
        mime_type: getPublishedDropMediaMimeType(upload.declared_mime_type),
        media_upload_id: upload.id,
        media_status: ApiDropMediaStatus.Processing
      };
    } else if (upload.status !== DropMediaUploadStatus.PROCESSING) {
      throw new Error(
        `Drop media upload ${upload.id} is ${upload.status}, not processing`
      );
    }

    await this.enqueueSanitizationOnce(upload);

    return {
      media_url: upload.public_url,
      mime_type: getPublishedDropMediaMimeType(upload.declared_mime_type),
      media_upload_id: upload.id,
      media_status: ApiDropMediaStatus.Processing
    };
  }

  /** Counts a completed private image upload's bytes; never fails completion. */
  private async recordIngestUploadSize(
    upload: DropMediaUploadEntity
  ): Promise<void> {
    try {
      const head = await this.getIngestS3().send(
        new HeadObjectCommand({
          Bucket: upload.ingest_bucket,
          Key: upload.ingest_key
        })
      );
      if (typeof head.ContentLength === 'number') {
        await this.uploadBudget.recordSize(
          upload.id,
          upload.profile_id,
          head.ContentLength
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not read the size of media upload ${upload.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * One sanitizer message per upload: the completion call that claims the
   * upload's enqueue marker sends it; repeated completion calls find the
   * marker and send nothing. A failed send gives the claim back so the
   * client's retry sends it.
   */
  private async enqueueSanitizationOnce(
    upload: DropMediaUploadEntity
  ): Promise<void> {
    const claimedAt = Time.currentMillis();
    const claimed = await this.dropMediaUploadsDb.claimSanitizerEnqueue({
      id: upload.id,
      claimedAt
    });
    if (!claimed) {
      return;
    }
    try {
      await this.enqueueSanitization({ mediaUploadId: upload.id });
    } catch {
      try {
        await this.dropMediaUploadsDb.releaseSanitizerEnqueue({
          id: upload.id,
          claimedAt
        });
      } catch (releaseError) {
        this.logger.error(
          `Could not release the sanitizer enqueue claim of media upload ${upload.id}`,
          releaseError
        );
      }
      throw new Error(
        `Failed to enqueue sanitization for media upload ${upload.id}`
      );
    }
  }

  /** Keep concurrent completion responses consistent with the published format. */
  private processingResponse(
    upload: DropMediaUploadEntity
  ): ApiCompleteMultipartUploadResponse {
    return {
      media_url: upload.public_url,
      mime_type: getPublishedDropMediaMimeType(upload.declared_mime_type),
      media_upload_id: upload.id,
      media_status: ApiDropMediaStatus.Processing
    };
  }

  private async createSignedMediaUrl({
    key,
    content_type
  }: {
    key: string;
    content_type: string;
  }) {
    const bucket = this.getS3Bucket();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: content_type
    });
    // The signature covers Content-Type, so the PUT must send exactly the
    // returned `content_type`. S3 checks expiry when the request starts, so
    // a slow upload that began in time still completes.
    const signedUrl = await getSignedUrl(this.getS3(), command, {
      expiresIn: SINGLE_PUT_UPLOAD_URL_EXPIRY.toSeconds(),
      signableHeaders: new Set(['content-type'])
    });
    return {
      upload_url: signedUrl,
      content_type,
      media_url: `${CLOUDFRONT_LINK}/${key}`
    };
  }

  /**
   * Object metadata such as Cache-Control is fixed when a multipart upload is
   * created, so the client's part uploads and completion stay unchanged. Public
   * media keys contain a fresh random id per upload; the private ingest copy
   * gets none because the sanitizer sets it when publishing.
   */
  private async createMultipartUploadId({
    key,
    content_type,
    bucket,
    s3,
    cacheControl,
    metadata
  }: {
    key: string;
    content_type: string;
    bucket: string;
    s3: S3Client;
    cacheControl?: string;
    metadata?: Record<string, string>;
  }): Promise<string> {
    const createCmd = new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: content_type,
      ...(metadata ? { Metadata: metadata } : {}),
      ...(cacheControl ? { CacheControl: cacheControl } : {})
    });

    const createResp = await s3.send(createCmd);
    const uploadId = createResp.UploadId;
    if (!uploadId) {
      throw new Error(
        `Didn't find upload with for key ${key} (content type: ${content_type})`
      );
    }
    return uploadId;
  }

  private async findTrackedDropMediaUpload({
    key,
    upload_id
  }: {
    key: string;
    upload_id: string;
  }): Promise<DropMediaUploadEntity | null> {
    if (!this.isPotentialTrackedDropMediaKey(key)) {
      return null;
    }
    return await this.dropMediaUploadsDb.findByPublicKeyAndS3UploadId({
      publicKey: key,
      s3UploadId: upload_id
    });
  }

  private isPotentialTrackedDropMediaKey(key: string): boolean {
    return key.startsWith('drops/') || key.startsWith('waves/');
  }

  /**
   * A multipart part URL or completion acts only on a key the server issued
   * to this caller: a tracked upload of this profile, an untracked drop or
   * wave key under this profile's author prefix, or (admin distribution
   * routes) a key under this card's distribution prefix. Anything else is
   * refused here, before any S3 call.
   */
  private assertDropMediaUploadOwner({
    upload,
    key,
    authenticatedProfileId,
    distributionPhoto
  }: {
    upload: DropMediaUploadEntity | null;
    key: string;
    authenticatedProfileId: string | undefined;
    distributionPhoto?: DistributionPhotoScope;
  }): void {
    if (!upload) {
      this.assertUntrackedDropMediaKeyOwner({
        key,
        authenticatedProfileId,
        distributionPhoto
      });
      return;
    }
    if (
      !authenticatedProfileId ||
      upload.profile_id !== authenticatedProfileId
    ) {
      throw new ForbiddenException('Cannot write this media upload');
    }
  }

  private assertUntrackedDropMediaKeyOwner({
    key,
    authenticatedProfileId,
    distributionPhoto
  }: {
    key: string;
    authenticatedProfileId: string | undefined;
    distributionPhoto?: DistributionPhotoScope;
  }): void {
    if (!this.isPotentialTrackedDropMediaKey(key)) {
      if (
        distributionPhoto &&
        key.startsWith(this.distributionPhotoKeyPrefix(distributionPhoto))
      ) {
        return;
      }
      throw new ForbiddenException('Cannot write this media upload');
    }
    if (!authenticatedProfileId) {
      throw new ForbiddenException('Cannot write this media upload');
    }
    const expectedDropPrefix = `drops/author_${authenticatedProfileId}/`;
    const expectedWavePrefix = `waves/author_${authenticatedProfileId}/`;
    if (
      !key.startsWith(expectedDropPrefix) &&
      !key.startsWith(expectedWavePrefix)
    ) {
      throw new ForbiddenException('Cannot write this media upload');
    }
  }

  private assertSinglePutImageUploadAllowed(contentType: string): void {
    if (isImageMimeType(contentType)) {
      throw new BadRequestException(
        'Image uploads must use multipart upload so the file format can be validated'
      );
    }
  }

  /** Old public image sessions cannot bypass the private publication gate. */
  private assertImageUploadIsTracked(
    key: string,
    upload: DropMediaUploadEntity | null
  ): void {
    if (upload) return;
    const isPublicImage =
      key.startsWith('waves/') ||
      (key.startsWith('drops/') &&
        /\.(?:jpe?g|png|webp|gif|avif|heic|heif)$/i.test(key));
    if (isPublicImage) {
      throw new BadRequestException(
        'Restart this image upload using a new multipart upload so the file format can be validated'
      );
    }
  }

  private getS3Bucket(): string {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_BUCKET is not configured');
    }
    return bucket;
  }
}

/** `<uploadId>.<ext>`: keeps the (lower-cased) extension, drops the name. */
function neutralMediaFileName(uploadId: string, fileName: string): string {
  return `${uploadId}${getFileExtension(fileName).toLowerCase()}`;
}

export const uploadMediaService = new UploadMediaService(getS3);
