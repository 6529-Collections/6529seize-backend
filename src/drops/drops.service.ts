import { dropsDb, DropsDb } from './drops.db';
import { profilesService, ProfilesService } from '../profiles/profiles.service';
import { ConnectionWrapper } from '../sql-executor';
import { DropFull } from './drops.types';
import { BadRequestException } from '../exceptions';
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
      max_storm_sequence: dropEntity.max_storm_sequence,
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

  public async findLatestDrops({
    amount,
    curation_criteria_id
  }: {
    curation_criteria_id: string | null;
    amount: number;
  }): Promise<DropFull[]> {
    const dropEntities = await this.dropsDb.findLatestDropsGroupedInStorms({
      amount,
      curation_criteria_id
    });
    return await this.convertToDropFulls(dropEntities);
  }

  private async convertToDropFulls(
    dropEntities: (Drop & { max_storm_sequence: number })[]
  ): Promise<DropFull[]> {
    const dropIds = dropEntities.map((it) => it.id);
    const mentions = await this.dropsDb.findMentionsByDropIds(dropIds);
    const referencedNfts = await this.dropsDb.findReferencedNftsByDropIds(
      dropIds
    );
    const metadata = await this.dropsDb.findMetadataByDropIds(dropIds);
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
  }): Promise<DropFull[]> {
    const dropEntities = await this.dropsDb.findProfileDropsGroupedInStorms(
      param
    );
    return await this.convertToDropFulls(dropEntities);
  }
}

export const dropsService = new DropsService(dropsDb, profilesService);
