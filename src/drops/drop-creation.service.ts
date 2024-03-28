import {
  CreateNewDropRequest,
  DropFull,
  DropReferencedNft
} from './drops.types';
import { BadRequestException } from '../exceptions';
import { dropsDb, DropsDb } from './drops.db';
import { giveReadReplicaTimeToCatchUp } from '../api-serverless/src/api-helpers';
import { Logger } from '../logging';
import { dropsService, DropsService } from './drops.service';
import { dropFileService, DropFileService } from './drop-file.service';

export class DropCreationService {
  private readonly logger = Logger.get('DropCreationService');

  constructor(
    private readonly dropsService: DropsService,
    private readonly dropsDb: DropsDb,
    private readonly dropFileService: DropFileService
  ) {}

  async createDrop(createDropRequest: CreateNewDropRequest): Promise<DropFull> {
    await this.validateReferences(createDropRequest);
    const dropMedia = await this.uploadMediaIfExists(createDropRequest);
    const dropFull = await this.persistDrop(createDropRequest, dropMedia);
    await giveReadReplicaTimeToCatchUp();
    this.logger.info(
      `Drop ${dropFull.id} created by user ${dropFull.author.id}`
    );
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
    return this.dropFileService.uploadDropMedia(
      dropMedia,
      createDropRequest.author.external_id
    );
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
        const rootDropId = createDropRequest.root_drop_id;
        let storm_sequence = 1;
        if (rootDropId !== null) {
          const rootDrop = await this.dropsDb.lockDrop(rootDropId, connection);
          if (!rootDrop) {
            throw new BadRequestException('Invalid root drop');
          }
          const current_storm_sequence =
            await this.dropsDb.findRootDropMaxStormSequenceOrZero(
              {
                root_drop_id: rootDropId,
                author_id: createDropRequest.author.external_id
              },
              connection
            );
          storm_sequence = current_storm_sequence + 1;
        }
        const dropId = await this.dropsDb.insertDrop(
          {
            author_id: createDropRequest.author.external_id,
            title: createDropRequest.title,
            content: createDropRequest.content,
            root_drop_id: createDropRequest.root_drop_id,
            storm_sequence: storm_sequence,
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
  }
}

export const dropCreationService = new DropCreationService(
  dropsService,
  dropsDb,
  dropFileService
);
