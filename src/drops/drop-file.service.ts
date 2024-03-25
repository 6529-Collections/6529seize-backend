import { S3Client } from '@aws-sdk/client-s3';
import { getS3 } from '../s3.client';
import { NewDropMedia } from './drops.types';
import { randomUUID } from 'crypto';
import { Upload } from '@aws-sdk/lib-storage';
import { Logger } from '../logging';

export class DropFileService {
  private readonly logger = Logger.get(DropFileService.name);

  constructor(private readonly getS3: () => S3Client) {}

  async uploadDropMedia(
    dropMedia: NewDropMedia,
    authorId: string
  ): Promise<{
    media_url: string;
    media_mime_type: string;
  }> {
    const fileExtension = this.getFileExtension(dropMedia.name);
    const mediaPath = `drops/author_${authorId}/${randomUUID()}${fileExtension}`;
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_BUCKET is not configured');
    }
    const parallelUploads3 = new Upload({
      client: this.getS3(),
      params: {
        Bucket: bucket,
        Key: mediaPath,
        Body: dropMedia.stream,
        ContentType: dropMedia.mimetype
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 5,
      leavePartsOnError: false
    });

    parallelUploads3.on('httpUploadProgress', (progress) => {
      this.logger.info(
        `Uploaded ${progress.loaded}/${progress.total} bytes of part ${progress.part} of file ${bucket}/${mediaPath}`
      );
    });
    await parallelUploads3.done();
    this.logger.info(`${bucket}/${mediaPath} uploaded to S3`);
    return {
      media_url: `https://d3lqz0a4bldqgf.cloudfront.net/${mediaPath}`,
      media_mime_type: dropMedia.mimetype
    };
  }

  private getFileExtension(name: string): string {
    const lastDotIndex = name.lastIndexOf('.');
    if (lastDotIndex < 0) {
      return '';
    }
    return name.substring(lastDotIndex);
  }
}

export const dropFileService = new DropFileService(getS3);
