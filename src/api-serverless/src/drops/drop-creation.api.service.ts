import { BadRequestException } from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Logger } from '../../../logging';
import { DropsApiService, dropsService } from './drops.api.service';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../../../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import { Drop } from '../generated/models/Drop';
import { DropReferencedNFT } from '../generated/models/DropReferencedNFT';

export class DropCreationApiService {
  private readonly logger = Logger.get(DropCreationApiService.name);

  constructor(
    private readonly dropsService: DropsApiService,
    private readonly dropsDb: DropsDb,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb
  ) {}

  async createDrop(
    createDropRequest: CreateDropRequest & { author: { external_id: string } }
  ): Promise<Drop> {
    await this.validateReferences(createDropRequest);
    const dropFull = await this.persistDrop(createDropRequest);
    await giveReadReplicaTimeToCatchUp();
    this.logger.info(
      `Drop ${dropFull.id} created by user ${dropFull.author.id}`
    );
    return dropFull;
  }

  private async persistDrop(
    createDropRequest: CreateDropRequest & { author: { external_id: string } }
  ) {
    return await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const rootDropId = createDropRequest.root_drop_id;
        let storm_sequence = 1;
        if (rootDropId) {
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
            title: createDropRequest.title ?? null,
            content: createDropRequest.content ?? null,
            root_drop_id: createDropRequest.root_drop_id ?? null,
            storm_sequence: storm_sequence,
            quoted_drop_id: createDropRequest.quoted_drop_id ?? null
          },
          connection
        );
        await this.profileActivityLogsDb.insert(
          {
            profile_id: createDropRequest.author.external_id,
            target_id: dropId.toString(),
            contents: JSON.stringify({
              drop_id: dropId,
              title: createDropRequest.title ?? null,
              content: createDropRequest.content ?? null,
              media: createDropRequest.media
            }),
            type: ProfileActivityLogType.DROP_CREATED
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
          createDropRequest.referenced_nfts.reduce<
            Record<string, DropReferencedNFT>
          >((acc, it) => {
            acc[JSON.stringify(it)] = it;
            return acc;
          }, {} as Record<string, DropReferencedNFT>)
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
        const media = createDropRequest.media.map((it) => ({
          ...it,
          drop_id: dropId
        }));
        await this.dropsDb.insertDropMedia(media, connection);
        return this.dropsService.findDropByIdOrThrow(
          { dropId, contextProfileId: createDropRequest.author.external_id },
          connection
        );
      }
    );
  }

  private async validateReferences(createDropRequest: CreateDropRequest) {
    const quotedDropId = createDropRequest.quoted_drop_id;
    if (quotedDropId) {
      const quotedDrop = await this.dropsDb
        .getDropsByIds([quotedDropId])
        .then((it) => it[0] ?? null);
      if (!quotedDrop) {
        throw new BadRequestException('Invalid quoted drop');
      }
    }
  }
}

export const dropCreationService = new DropCreationApiService(
  dropsService,
  dropsDb,
  profileActivityLogsDb
);
