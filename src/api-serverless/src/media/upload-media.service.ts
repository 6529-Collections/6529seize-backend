import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
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
import {
  getFileExtension,
  sanitizeFileName,
  slugifyBaseName
} from './sanitize-file-name';
import { CLOUDFRONT_LINK } from '@/constants';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import {
  createDropMediaIngestKey,
  getDropMediaIngestS3,
  getDropMediaIngestS3Bucket,
  isDropMediaSanitizationEnabled,
  isImageMimeType
} from '@/drops/drop-media-upload.config';
import {
  DropMediaUploadsDb,
  dropMediaUploadsDb as defaultDropMediaUploadsDb
} from '@/drops/drop-media-uploads.db';
import {
  DropMediaUploadEntity,
  DropMediaUploadSource,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';
import { enqueueDropMediaSanitization } from '@/drops/drop-media-sanitizer-queue';

type MediaUploadSource =
  | DropMediaUploadSource.DROP
  | DropMediaUploadSource.WAVE;

type SanitizerQueue = (input: { mediaUploadId: string }) => Promise<void>;

export class UploadMediaService {
  constructor(
    private readonly getS3: () => S3Client,
    private readonly getIngestS3: () => S3Client = getDropMediaIngestS3,
    private readonly dropMediaUploadsDb: DropMediaUploadsDb = defaultDropMediaUploadsDb,
    private readonly enqueueSanitization: SanitizerQueue = enqueueDropMediaSanitization
  ) {}

  public async createSingedDropMediaUploadUrl({
    content_type,
    file_name,
    author_id
  }: {
    content_type: string;
    file_name: string;
    author_id: string;
  }): Promise<{ upload_url: string; media_url: string; content_type: string }> {
    this.assertSinglePutImageUploadAllowed(content_type);
    const key = this.createDropMediaKey({ file_name, author_id });
    return await this.createSignedMediaUrl({ key, content_type });
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
    const key = this.createWaveMediaKey({ file_name, author_id });
    return await this.createSignedMediaUrl({ key, content_type });
  }

  async getWaveMediaMultipartUploadKeyAndUploadId({
    content_type,
    file_name,
    author_id
  }: {
    content_type: string;
    file_name: string;
    author_id: string;
  }): Promise<ApiStartMultipartMediaUploadResponse> {
    const key = this.createWaveMediaKey({ file_name, author_id });

    return await this.createMultipartUpload({
      key,
      content_type,
      author_id,
      source: DropMediaUploadSource.WAVE
    });
  }

  async getDropMediaMultipartUploadKeyAndUploadId({
    content_type,
    file_name,
    author_id
  }: {
    author_id: string;
    file_name: string;
    content_type: string;
  }): Promise<ApiStartMultipartMediaUploadResponse> {
    const key = this.createDropMediaKey({ file_name, author_id });

    return await this.createMultipartUpload({
      key,
      content_type,
      author_id,
      source: DropMediaUploadSource.DROP
    });
  }

  async getSignedUrlForPartOfMultipartUpload({
    upload_id,
    key,
    part_no,
    authenticatedProfileId
  }: {
    upload_id: string;
    key: string;
    part_no: number;
    authenticatedProfileId?: string;
  }): Promise<string> {
    const upload = await this.findTrackedDropMediaUpload({ key, upload_id });
    this.assertDropMediaUploadOwner({ upload, key, authenticatedProfileId });
    const bucket = upload?.ingest_bucket ?? this.getS3Bucket();
    const objectKey = upload?.ingest_key ?? key;
    const s3 = upload ? this.getIngestS3() : this.getS3();
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
    authenticatedProfileId
  }: {
    upload_id: string;
    key: string;
    parts: { etag: string; part_no: number }[];
    authenticatedProfileId?: string;
  }): Promise<ApiCompleteMultipartUploadResponse> {
    const upload = await this.findTrackedDropMediaUpload({ key, upload_id });
    this.assertDropMediaUploadOwner({ upload, key, authenticatedProfileId });
    if (upload) {
      return await this.completeSanitizedImageMultipartUpload({
        upload,
        parts
      });
    }

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
    return {
      media_url: `${CLOUDFRONT_LINK}/${completeResp.Key}`,
      media_status: ApiDropMediaStatus.Ready
    };
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
      s3: this.getS3()
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
    return `distribution/${process.env.NODE_ENV}/${contract.toLowerCase()}/${card_id}-${randomUUID()}${fileExtension}`;
  }

  private createWaveMediaKey({
    file_name,
    author_id
  }: {
    file_name: string;
    author_id: string;
  }) {
    return `waves/author_${author_id}/${sanitizeFileName(file_name)}`;
  }

  private createDropMediaKey({
    file_name,
    author_id
  }: {
    file_name: string;
    author_id: string;
  }) {
    const uploadId = randomUUID();
    const fileExtension = getFileExtension(file_name);
    const baseName = fileExtension
      ? file_name.substring(0, file_name.length - fileExtension.length)
      : file_name;
    const slug = slugifyBaseName(baseName);
    const sanitizedFileName = slug
      ? `${slug}${fileExtension}`
      : `${uploadId}${fileExtension}`;
    return `drops/author_${author_id}/${uploadId}/${sanitizedFileName}`;
  }

  private async createMultipartUpload({
    key,
    content_type,
    author_id,
    source
  }: {
    key: string;
    content_type: string;
    author_id: string;
    source: MediaUploadSource;
  }): Promise<ApiStartMultipartMediaUploadResponse> {
    if (!this.shouldSanitizeMultipartUpload(content_type)) {
      const uploadId = await this.createMultipartUploadId({
        key,
        content_type,
        bucket: this.getS3Bucket(),
        s3: this.getS3()
      });
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
      s3: this.getIngestS3()
    });
    const mediaUploadId = randomUUID();
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
      completed_at: null
    } satisfies DropMediaUploadEntity);

    return {
      key,
      upload_id: uploadId,
      media_upload_id: mediaUploadId,
      media_status: ApiDropMediaStatus.Uploading
    };
  }

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
    } else if (
      upload.status === DropMediaUploadStatus.COMPLETING ||
      upload.status === DropMediaUploadStatus.SANITIZING
    ) {
      return {
        media_url: upload.public_url,
        media_upload_id: upload.id,
        media_status: ApiDropMediaStatus.Processing
      };
    } else if (upload.status !== DropMediaUploadStatus.PROCESSING) {
      throw new Error(
        `Drop media upload ${upload.id} is ${upload.status}, not processing`
      );
    }

    try {
      await this.enqueueSanitization({ mediaUploadId: upload.id });
    } catch {
      throw new Error(
        `Failed to enqueue sanitization for media upload ${upload.id}`
      );
    }

    return {
      media_url: upload.public_url,
      media_upload_id: upload.id,
      media_status: ApiDropMediaStatus.Processing
    };
  }

  private processingResponse(
    upload: DropMediaUploadEntity
  ): ApiCompleteMultipartUploadResponse {
    return {
      media_url: upload.public_url,
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
    const signedUrl = await getSignedUrl(this.getS3(), command, {
      expiresIn: Time.hours(1).toSeconds()
    });
    return {
      upload_url: signedUrl,
      content_type,
      media_url: `${CLOUDFRONT_LINK}/${key}`
    };
  }

  private async createMultipartUploadId({
    key,
    content_type,
    bucket,
    s3
  }: {
    key: string;
    content_type: string;
    bucket: string;
    s3: S3Client;
  }): Promise<string> {
    const createCmd = new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: content_type
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

  private shouldSanitizeMultipartUpload(contentType: string): boolean {
    return isDropMediaSanitizationEnabled() && isImageMimeType(contentType);
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

  private assertDropMediaUploadOwner({
    upload,
    key,
    authenticatedProfileId
  }: {
    upload: DropMediaUploadEntity | null;
    key: string;
    authenticatedProfileId: string | undefined;
  }): void {
    if (!upload) {
      this.assertUntrackedDropMediaKeyOwner({ key, authenticatedProfileId });
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
    authenticatedProfileId
  }: {
    key: string;
    authenticatedProfileId: string | undefined;
  }): void {
    if (!this.isPotentialTrackedDropMediaKey(key)) {
      return;
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
    if (this.shouldSanitizeMultipartUpload(contentType)) {
      throw new BadRequestException(
        'Image uploads must use multipart upload while image sanitization is enabled'
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

export const uploadMediaService = new UploadMediaService(getS3);
