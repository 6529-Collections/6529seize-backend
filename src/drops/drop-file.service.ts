import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getS3 } from '../s3.client';
import { randomUUID } from 'crypto';
import { Logger } from '../logging';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class DropFileService {
  private readonly logger = Logger.get(DropFileService.name);

  constructor(private readonly getS3: () => S3Client) {}

  private getFileExtension(name: string): string {
    const lastDotIndex = name.lastIndexOf('.');
    if (lastDotIndex < 0) {
      return '';
    }
    return name.substring(lastDotIndex);
  }

  public async createSingedDropMediaUploadUrl({
    content_type,
    file_name,
    author_id
  }: CreateMediaUploadUrlRequest): Promise<CreateMediaUploadUrlResponse> {
    const fileExtension = this.getFileExtension(file_name);
    const mediaPath = `drops/author_${author_id}/${randomUUID()}${fileExtension}`;
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_BUCKET is not configured');
    }
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: mediaPath,
      ContentType: content_type
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

export interface CreateMediaUploadUrlRequest {
  content_type: string;
  file_name: string;
  author_id: string;
}

export interface CreateMediaUploadUrlResponse {
  upload_url: string;
  content_type: string;
  media_url: string;
}

export const dropFileService = new DropFileService(getS3);
