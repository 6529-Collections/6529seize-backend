import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getS3 } from '../../../s3.client';
import { randomUUID } from 'crypto';
import { Logger } from '../../../logging';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CreateMediaUploadUrlRequest } from '../generated/models/CreateMediaUploadUrlRequest';
import { CreateMediaUrlResponse } from '../generated/models/CreateMediaUrlResponse';

export class UploadMediaService {
  private readonly logger = Logger.get(UploadMediaService.name);

  constructor(private readonly getS3: () => S3Client) {}

  public async createSingedDropMediaUploadUrl({
    content_type,
    file_name,
    author,
    file_size
  }: CreateMediaUploadUrlRequest & {
    author: string;
  }): Promise<CreateMediaUrlResponse> {
    const fileExtension = this.getFileExtension(file_name);
    const mediaPath = `drops/author_${author}/${randomUUID()}${fileExtension}`;
    return await this.createSignedMediaUrl(mediaPath, content_type, file_size);
  }

  private getFileExtension(name: string): string {
    const lastDotIndex = name.lastIndexOf('.');
    if (lastDotIndex < 0) {
      return '';
    }
    return name.substring(lastDotIndex);
  }

  public async createSingedWaveMediaUploadUrl({
    content_type,
    file_name,
    author,
    file_size
  }: CreateMediaUploadUrlRequest & {
    author: string;
  }): Promise<CreateMediaUrlResponse> {
    const fileExtension = this.getFileExtension(file_name);
    const mediaPath = `waves/author_${author}/${randomUUID()}${fileExtension}`;
    return await this.createSignedMediaUrl(mediaPath, content_type, file_size);
  }

  private async createSignedMediaUrl(
    mediaPath: string,
    content_type: string,
    file_size: number
  ) {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_BUCKET is not configured');
    }
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: mediaPath,
      ContentType: content_type,
      ContentLength: file_size
    });
    const signedUrl = await getSignedUrl(this.getS3(), command, {
      expiresIn: 60
    });
    return {
      upload_url: signedUrl,
      content_type,
      media_url: `https://d3lqz0a4bldqgf.cloudfront.net/${mediaPath}`
    };
  }
}

export const uploadMediaService = new UploadMediaService(getS3);
