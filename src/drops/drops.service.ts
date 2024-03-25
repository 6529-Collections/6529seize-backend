import { dropsDb, DropsDb } from './drops.db';
import { profilesService, ProfilesService } from '../profiles/profiles.service';
import { ConnectionWrapper } from '../sql-executor';
import { DropFull } from './drops.types';
import { BadRequestException } from '../exceptions';

export class DropsService {
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly profilesService: ProfilesService
  ) {}

  public async findDropByIdOrThrow(
    dropId: number,
    connection?: ConnectionWrapper<any>
  ): Promise<DropFull> {
    const dropEntity = await this.dropsDb
      .findDropById(dropId, connection)
      .then((drop) => {
        if (!drop) {
          throw new BadRequestException('Drop not found');
        }
        return drop;
      });
    const mentions = await this.dropsDb.findMentionsByDropId(
      dropId,
      connection
    );
    const referencedNfts = await this.dropsDb.findReferencedNftsByDropId(
      dropId,
      connection
    );
    const metadata = await this.dropsDb.findMetadataByDropId(
      dropId,
      connection
    );
    const realHandledByProfileIds =
      await this.profilesService.getProfileHandlesByIds(
        mentions.map((it) => it.mentioned_profile_id)
      );
    let author = await this.profilesService
      .getProfileMinsByIds([dropEntity.author_id])
      .then((it) => it[0] ?? null);
    const author_archived = !author;
    if (author_archived) {
      const archivedProfile =
        await this.profilesService.getNewestVersionOfArchivedProfile(
          dropEntity.author_id
        );
      if (archivedProfile === null) {
        throw new Error(`Author profile not found for drop ${dropId}`);
      }
      author = {
        id: archivedProfile.external_id,
        handle: archivedProfile.handle,
        pfp: archivedProfile.pfp_url ?? null,
        cic: 0,
        rep: 0,
        tdh: 0,
        level: 0
      };
    }
    return {
      id: dropEntity.id,
      author,
      author_archived,
      title: dropEntity.title,
      content: dropEntity.content,
      created_at: dropEntity.created_at,
      storm_id: dropEntity.storm_id,
      storm_sequence: dropEntity.storm_sequence,
      quoted_drop_id: dropEntity.quoted_drop_id,
      media_url: dropEntity.media_url,
      media_mime_type: dropEntity.media_mime_type,
      referenced_nfts: referencedNfts.map((it) => ({
        contract: it.contract,
        token: it.token,
        name: it.name
      })),
      mentioned_users: mentions.map((it) => ({
        mentioned_profile_id: it.mentioned_profile_id,
        handle_in_content: it.handle_in_content,
        current_handle: realHandledByProfileIds[it.mentioned_profile_id] ?? null
      })),
      metadata: metadata.map((it) => ({
        data_key: it.data_key,
        data_value: it.data_value
      }))
    };
  }
}

export const dropsService = new DropsService(dropsDb, profilesService);
