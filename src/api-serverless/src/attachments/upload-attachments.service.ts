import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getS3 } from '@/s3.client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Time } from '@/time';
import { getFileExtension } from '@/api/media/sanitize-file-name';

export class UploadAttachmentsService {
  constructor(private readonly getS3: () => S3Client) {}

  async createMultipartUpload({
    attachmentId,
    authorId,
    contentType,
    fileName
  }: {
    attachmentId: string;
    authorId: string;
    contentType: string;
    fileName: string;
  }): Promise<{ key: string; upload_id: string }> {
    const key = this.createAttachmentKey({
      attachmentId,
      authorId,
      fileName
    });
    const uploadId = await this.createMultipartUploadId({
      key,
      contentType
    });
    return {
      key,
      upload_id: uploadId
    };
  }

  async getSignedUrlForPartOfMultipartUpload({
    upload_id,
    key,
    part_no
  }: {
    upload_id: string;
    key: string;
    part_no: number;
  }): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.getBucket(),
      Key: key,
      PartNumber: part_no,
      UploadId: upload_id
    });

    return await getSignedUrl(this.getS3(), command, {
      expiresIn: Time.hours(1).toSeconds()
    });
  }

  async completeMultipartUpload({
    upload_id,
    key,
    parts
  }: {
    upload_id: string;
    key: string;
    parts: { etag: string; part_no: number }[];
  }): Promise<{ bucket: string; key: string }> {
    await this.getS3().send(
      new CompleteMultipartUploadCommand({
        Bucket: this.getBucket(),
        Key: key,
        UploadId: upload_id,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            ETag: part.etag.replace(/(^")|("$)/g, ''),
            PartNumber: part.part_no
          }))
        }
      })
    );
    return {
      bucket: this.getBucket(),
      key
    };
  }

  private async createMultipartUploadId({
    key,
    contentType
  }: {
    key: string;
    contentType: string;
  }): Promise<string> {
    const response = await this.getS3().send(
      new CreateMultipartUploadCommand({
        Bucket: this.getBucket(),
        Key: key,
        ContentType: contentType
      })
    );
    if (!response.UploadId) {
      throw new Error(`No multipart upload id returned for key ${key}`);
    }
    return response.UploadId;
  }

  private createAttachmentKey({
    attachmentId,
    authorId,
    fileName
  }: {
    attachmentId: string;
    authorId: string;
    fileName: string;
  }): string {
    const extension = getFileExtension(fileName).toLowerCase();
    return `${process.env.NODE_ENV}/attachments/incoming/author_${authorId}/${attachmentId}/original${extension || ''}`;
  }

  private getBucket(): string {
    return (
      process.env.ATTACHMENTS_INGEST_S3_BUCKET ??
      (() => {
        throw new Error('ATTACHMENTS_INGEST_S3_BUCKET is not configured');
      })()
    );
  }
}

export const uploadAttachmentsService = new UploadAttachmentsService(getS3);
