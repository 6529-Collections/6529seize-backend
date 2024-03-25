import {
  CreateNewDropRequest,
  DropFull,
  DropReferencedNft
} from './drops.types';
import { BadRequestException } from '../exceptions';
import { dropsDb, DropsDb } from './drops.db';
import { giveReadReplicaTimeToCatchUp } from '../api-serverless/src/api-helpers';
import { S3Client } from '@aws-sdk/client-s3';
import { getS3 } from '../s3.client';
import { randomUUID } from 'crypto';
import { Upload } from '@aws-sdk/lib-storage';
import { Logger } from '../logging';
import { dropsService, DropsService } from './drops.service';

export class DropCreationService {
  private readonly logger = Logger.get('DropCreationService');

  constructor(
    private readonly dropsService: DropsService,
    private readonly dropsDb: DropsDb,
    private readonly getS3: () => S3Client
  ) {}

  async createDrop(createDropRequest: CreateNewDropRequest): Promise<DropFull> {
    const dropMedia = await this.uploadMediaIfExists(createDropRequest);
    await this.validateReferences(createDropRequest);
    const dropFull = await this.persistDrop(createDropRequest, dropMedia);
    await giveReadReplicaTimeToCatchUp();
    return dropFull;
  }

  private async uploadMediaIfExists(
    createDropRequest: CreateNewDropRequest
  ): Promise<{
    media_url: string | null;
    media_mime_type: string | null;
  }> {
    const dropMedia = createDropRequest.dropMedia;
    if (dropMedia === null) {
      return {
        media_url: null,
        media_mime_type: null
      };
    }
    const fileExtension = this.getFileExtension(dropMedia.name);
    const mediaPath = `drops/author_${
      createDropRequest.author.external_id
    }/${randomUUID()}${fileExtension}`;
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

  private async persistDrop(
    createDropRequest: CreateNewDropRequest,
    dropMedia: {
      media_url: string | null;
      media_mime_type: string | null;
    }
  ) {
    return await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const dropId = await this.dropsDb.insertDrop(
          {
            author_id: createDropRequest.author.external_id,
            title: createDropRequest.title,
            content: createDropRequest.content,
            storm_id: createDropRequest.storm_id,
            quoted_drop_id: createDropRequest.quoted_drop_id,
            media_url: dropMedia.media_url,
            media_mime_type: dropMedia.media_mime_type
          },
          connection
        );
        const mentionEntities = createDropRequest.mentioned_users.map((it) => ({
          drop_id: dropId,
          mentioned_profile_id: it.mentioned_profile_id,
          handle_in_content: it.handle_in_content
        }));
        await this.dropsDb.insertMentions(mentionEntities, connection);
        const referencedNfts = Object.values(
          createDropRequest.referenced_nfts.reduce((acc, it) => {
            acc[JSON.stringify(it)] = it;
            return acc;
          }, {} as Record<string, DropReferencedNft>)
        );
        await this.dropsDb.insertReferencedNfts(
          referencedNfts.map((it) => ({
            drop_id: dropId,
            contract: it.contract,
            token: it.token,
            name: it.name
          })),
          connection
        );
        const metadata = createDropRequest.metadata.map((it) => ({
          ...it,
          drop_id: dropId
        }));
        await this.dropsDb.insertDropMetadata(metadata, connection);
        return this.dropsService.findDropByIdOrThrow(dropId, connection);
      }
    );
  }

  private async validateReferences(createDropRequest: CreateNewDropRequest) {
    const quotedDropId = createDropRequest.quoted_drop_id;
    if (quotedDropId !== null) {
      const quotedDrop = await this.dropsDb
        .getDropsByIds([quotedDropId])
        .then((it) => it[0] ?? null);
      if (!quotedDrop) {
        throw new BadRequestException('Invalid quoted drop');
      }
    }
    const stormId = createDropRequest.storm_id;
    if (stormId !== null) {
      const stormDropsCount = await this.dropsDb.countStormDrops(
        stormId,
        createDropRequest.author.external_id
      );
      if (stormDropsCount === 0) {
        throw new BadRequestException('Invalid storm');
      }
    }
  }

  private getFileExtension(name: string): string {
    const lastDotIndex = name.lastIndexOf('.');
    if (lastDotIndex < 0) {
      return '';
    }
    return name.substring(lastDotIndex);
  }
}

export const dropCreationService = new DropCreationService(
  dropsService,
  dropsDb,
  getS3
);
