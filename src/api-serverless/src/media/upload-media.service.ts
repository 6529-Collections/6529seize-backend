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

export class UploadMediaService {
  constructor(private readonly getS3: () => S3Client) {}

  public async createSingedDropMediaUploadUrl({
    content_type,
    file_name,
    author_id
  }: {
    content_type: string;
    file_name: string;
    author_id: string;
  }): Promise<{ upload_url: string; media_url: string; content_type: string }> {
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
  }): Promise<{ key: string; upload_id: string }> {
    const key = this.createWaveMediaKey({ file_name, author_id });

    const uploadId = await this.createMultipartUploadId({ key, content_type });
    return {
      key,
      upload_id: uploadId
    };
  }

  async getDropMediaMultipartUploadKeyAndUploadId({
    content_type,
    file_name,
    author_id
  }: {
    author_id: string;
    file_name: string;
    content_type: string;
  }): Promise<{ key: string; upload_id: string }> {
    const key = this.createDropMediaKey({ file_name, author_id });

    const uploadId = await this.createMultipartUploadId({
      key,
      content_type: content_type
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
    const s3 = this.getS3();
    const command = new UploadPartCommand({
      Bucket: this.getS3Bucket(),
      Key: key,
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
    parts
  }: {
    upload_id: string;
    key: string;
    parts: { etag: string; part_no: number }[];
  }): Promise<string> {
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
    return `https://d3lqz0a4bldqgf.cloudfront.net/${completeResp.Key}`;
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
    const uploadId = await this.createMultipartUploadId({ key, content_type });
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
    return `distribution/${process.env.NODE_ENV}/${contract.toLowerCase()}/${card_id}/${file_name}`;
  }

  private createWaveMediaKey({
    file_name,
    author_id
  }: {
    file_name: string;
    author_id: string;
  }) {
    const fileExtension = this.getFileExtension(file_name);
    return `waves/author_${author_id}/${randomUUID()}${fileExtension}`;
  }

  private createDropMediaKey({
    file_name,
    author_id
  }: {
    file_name: string;
    author_id: string;
  }) {
    const fileExtension = this.getFileExtension(file_name);
    return `drops/author_${author_id}/${randomUUID()}${fileExtension}`;
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
      media_url: `https://d3lqz0a4bldqgf.cloudfront.net/${key}`
    };
  }

  private async createMultipartUploadId({
    key,
    content_type
  }: {
    key: string;
    content_type: string;
  }): Promise<string> {
    const bucket = this.getS3Bucket();
    const createCmd = new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: content_type
    });

    const createResp = await this.getS3().send(createCmd);
    const uploadId = createResp.UploadId;
    if (!uploadId) {
      throw new Error(
        `Didn't find upload with for key ${key} (content type: ${content_type})`
      );
    }
    return uploadId;
  }

  private getS3Bucket(): string {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_BUCKET is not configured');
    }
    return bucket;
  }

  private getFileExtension(name: string): string {
    const lastDotIndex = name.lastIndexOf('.');
    if (lastDotIndex < 0) {
      return '';
    }
    return name.substring(lastDotIndex);
  }
}

export const uploadMediaService = new UploadMediaService(getS3);
