import { dropsDb, DropsDb } from './drops.db';
import { profilesService, ProfilesService } from '../profiles/profiles.service';
import { ConnectionWrapper } from '../sql-executor';
import { DropFull } from './drops.types';
import { NotFoundException } from '../exceptions';
import { ProfileMin } from '../profiles/profile-min';
import { Drop } from '../entities/IDrop';

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
          throw new NotFoundException(`Drop ${dropId} not found`);
        }
        return drop;
      });
    return this.convertToDropFulls([dropEntity], connection).then(
      (it) => it[0]!
    );
  }

  public async findLatestDrops({
    amount,
    curation_criteria_id,
    id_less_than,
    storm_id
  }: {
    curation_criteria_id: string | null;
    id_less_than: number | null;
    storm_id: number | null;
    amount: number;
  }): Promise<DropFull[]> {
    const dropEntities = await this.dropsDb.findLatestDropsGroupedInStorms({
      amount,
      id_less_than,
      curation_criteria_id,
      storm_id
    });
    return await this.convertToDropFulls(dropEntities);
  }

  private async convertToDropFulls(
    dropEntities: (Drop & { max_storm_sequence: number })[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropFull[]> {
    const dropIds = dropEntities.map((it) => it.id);
    const mentions = await this.dropsDb.findMentionsByDropIds(
      dropIds,
      connection
    );
    const referencedNfts = await this.dropsDb.findReferencedNftsByDropIds(
      dropIds,
      connection
    );
    const metadata = await this.dropsDb.findMetadataByDropIds(
      dropIds,
      connection
    );
    const allProfileIds = [
      ...dropEntities.map((it) => it.author_id),
      ...mentions.map((it) => it.mentioned_profile_id)
    ];
    const profileMins = await this.profilesService.getProfileMinsByIds(
      allProfileIds
    );
    const missingProfileIds = allProfileIds.filter(
      (it) => !profileMins.some((profile) => profile.id === it)
    );
    const profileArchiveLatests =
      await this.profilesService.getNewestVersionOfArchivedProfileHandles(
        missingProfileIds
      );
    const profilesByIds = allProfileIds.reduce((acc, profileId) => {
      const activeProfile = profileMins.find((it) => it.id === profileId);
      let profileMin = activeProfile;
      if (!profileMin) {
        const archivedProfile = profileArchiveLatests.find(
          (it) => it.external_id === profileId
        );
        if (archivedProfile) {
          profileMin = {
            id: archivedProfile.external_id,
            handle: archivedProfile.handle,
            pfp: null,
            cic: 0,
            rep: 0,
            tdh: 0,
            level: 0
          };
        } else {
          profileMin = {
            id: 'an-unknown-profile',
            handle: 'An unknown profile',
            pfp: null,
            cic: 0,
            rep: 0,
            tdh: 0,
            level: 0
          };
        }
      }
      acc[profileId] = {
        profile: profileMin,
        archived: !activeProfile
      };
      return acc;
    }, {} as Record<string, { profile: ProfileMin; archived: boolean }>);
    return dropEntities.map((dropEntity) => ({
      id: dropEntity.id,
      author: profilesByIds[dropEntity.author_id].profile,
      author_archived: profilesByIds[dropEntity.author_id]!.archived,
      title: dropEntity.title,
      content: dropEntity.content,
      created_at: dropEntity.created_at,
      storm_id: dropEntity.storm_id,
      storm_sequence: dropEntity.storm_sequence,
      max_storm_sequence: dropEntity.max_storm_sequence,
      quoted_drop_id: dropEntity.quoted_drop_id,
      media_url: dropEntity.media_url,
      media_mime_type: dropEntity.media_mime_type,
      referenced_nfts: referencedNfts.filter(
        (it) => it.drop_id === dropEntity.id
      ),
      mentioned_users: mentions
        .filter((it) => it.drop_id === dropEntity.id)
        .map((it) => ({
          mentioned_profile_id: it.mentioned_profile_id,
          handle_in_content: it.handle_in_content,
          current_handle:
            profilesByIds[it.mentioned_profile_id]?.profile.handle ?? null
        })),
      metadata: metadata.filter((it) => it.drop_id === dropEntity.id)
    }));
  }

  async findProfilesLatestDrops(param: {
    amount: number;
    profile_id: string;
    id_less_than: number | null;
  }): Promise<DropFull[]> {
    const dropEntities = await this.dropsDb.findProfileDropsGroupedInStorms(
      param
    );
    return await this.convertToDropFulls(dropEntities);
  }
}

export const dropsService = new DropsService(dropsDb, profilesService);
