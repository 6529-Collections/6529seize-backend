import { DropEntity } from '../../../entities/IDrop';
import { ConnectionWrapper } from '../../../sql-executor';
import { Drop } from '../generated/models/Drop';
import { distinct, parseIntOrNull, resolveEnumOrThrow } from '../../../helpers';
import { ProfileMin } from '../generated/models/ProfileMin';
import { DropPart } from '../generated/models/DropPart';
import { DropMedia } from '../generated/models/DropMedia';
import { DropReferencedNFT } from '../generated/models/DropReferencedNFT';
import { DropMentionedUser } from '../generated/models/DropMentionedUser';
import { DropMetadata } from '../generated/models/DropMetadata';
import { DropRater } from '../generated/models/DropRater';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { DropSubscriptionTargetAction } from '../generated/models/DropSubscriptionTargetAction';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import {
  profilesApiService,
  ProfilesApiService
} from '../profiles/profiles.api.service';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { DropWithoutWave } from '../generated/models/DropWithoutWave';
import { RequestContext } from '../../../request.context';
import { AuthenticationContext } from '../../../auth-context';
import { WaveMin } from '../generated/models/WaveMin';

export class DropsMappers {
  constructor(
    private readonly userGroupsService: UserGroupsService,
    private readonly profilesService: ProfilesApiService,
    private readonly dropsDb: DropsDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  public async convertToDropFulls(
    {
      dropEntities,
      contextProfileId
    }: {
      dropEntities: DropEntity[];
      contextProfileId?: string | null;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Drop[]> {
    const dWoW = await this.convertToDropsWithoutWaves(dropEntities, {
      connection,
      authenticationContext: contextProfileId
        ? AuthenticationContext.fromProfileId(contextProfileId)
        : AuthenticationContext.notAuthenticated()
    });
    const waveOverviews = await this.wavesApiDb.getWaveOverviewsByDropIds(
      dropEntities.map((it) => it.id),
      connection
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        contextProfileId ?? null
      );
    return dWoW.map<Drop>((d) => {
      const wave = waveOverviews[d.id];
      const waveMin: WaveMin | null = wave
        ? {
            id: wave.id,
            name: wave.name,
            picture: wave.picture,
            description_drop_id: wave.description_drop_id,
            authenticated_user_eligible_to_vote:
              wave.voting_group_id === null ||
              group_ids_user_is_eligible_for.includes(wave.voting_group_id),
            authenticated_user_eligible_to_participate:
              wave.participation_group_id === null ||
              group_ids_user_is_eligible_for.includes(
                wave.participation_group_id
              )
          }
        : null;
      return {
        ...d,
        wave: waveMin as any
      };
    });
  }

  private async getAllDropsRelatedData(
    {
      dropIds,
      contextProfileId,
      replyDropIds
    }: {
      dropIds: string[];
      replyDropIds: string[];
      contextProfileId?: string | null;
    },
    connection?: ConnectionWrapper<any>
  ) {
    const [
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsRatings,
      dropsRatingsByContextProfile,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsRepliesCounts,
      subscribedActions
    ] = await Promise.all([
      this.dropsDb.findMentionsByDropIds(dropIds, connection),
      this.dropsDb.findReferencedNftsByDropIds(dropIds, connection),
      this.dropsDb.findMetadataByDropIds(dropIds, connection),
      this.dropsDb.findDropsTopRaters(dropIds, connection),
      this.dropsDb.findDropsTotalRatingsStats(dropIds, connection),
      this.findContextProfilesTotalRatingsForDrops(
        contextProfileId,
        dropIds,
        connection
      ),
      this.dropsDb.getDropsQuoteCounts(dropIds, contextProfileId, connection),
      this.dropsDb.getDropMedia(dropIds, connection),
      this.dropsDb.getDropsParts(dropIds, connection),
      this.dropsDb.countRepliesByDropIds(
        { dropIds, context_profile_id: contextProfileId },
        connection
      ),
      !contextProfileId
        ? Promise.resolve({} as Record<string, ActivityEventAction[]>)
        : this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTargets(
            {
              subscriber_id: contextProfileId,
              target_ids: dropIds,
              target_type: ActivityEventTargetType.DROP
            },
            connection
          )
    ]);
    const quotedDropIds = distinct(
      Object.values(dropsParts)
        .flat()
        .map((it) => it.quoted_drop_id)
        .filter((it) => it !== null) as string[]
    );
    const relatedDropIds = distinct([
      ...quotedDropIds,
      ...replyDropIds,
      ...dropIds
    ]);
    const deletedDrops = await this.dropsDb.findDeletedDrops(
      relatedDropIds,
      connection
    );
    return {
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsRatings,
      dropsRatingsByContextProfile,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsRepliesCounts,
      subscribedActions: Object.entries(subscribedActions).reduce(
        (acc, [id, actions]) => {
          acc[id] = actions.map((it) =>
            resolveEnumOrThrow(DropSubscriptionTargetAction, it)
          );
          return acc;
        },
        {} as Record<string, DropSubscriptionTargetAction[]>
      ),
      deletedDrops
    };
  }

  private async findContextProfilesTotalRatingsForDrops(
    contextProfileId: string | undefined | null,
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, number>> {
    if (!contextProfileId) {
      return {};
    }
    return this.dropsDb.findDropsTotalRatingsByProfile(
      dropIds,
      contextProfileId,
      connection
    );
  }

  async convertToDropsWithoutWaves(
    dropEntities: DropEntity[],
    ctx: RequestContext
  ): Promise<DropWithoutWave[]> {
    const dropIds = dropEntities.map((it) => it.id);
    const contextProfileId = ctx.authenticationContext?.getActingAsId() ?? null;
    const {
      mentions,
      referencedNfts,
      metadata,
      dropsTopRaters,
      dropsRatings,
      dropsRatingsByContextProfile,
      dropsQuoteCounts,
      dropMedia,
      dropsParts,
      dropsRepliesCounts,
      subscribedActions,
      deletedDrops
    } = await this.getAllDropsRelatedData(
      {
        dropIds,
        replyDropIds: distinct(
          [...dropEntities.map((it) => it.reply_to_drop_id)].filter(
            (it) => it !== null
          ) as string[]
        ),
        contextProfileId
      },
      ctx.connection
    );
    const raterProfileIds = Object.values(dropsTopRaters)
      .map((it) => it.map((r) => r.rater_profile_id))
      .flat();
    const allProfileIds = distinct([
      ...dropEntities.map((it) => it.author_id),
      ...mentions.map((it) => it.mentioned_profile_id),
      ...raterProfileIds,
      ...Object.values(deletedDrops).map((it) => it.author_id)
    ]);
    const profileMins = await this.profilesService.getProfileMinsByIds({
      ids: allProfileIds,
      authenticatedProfileId: contextProfileId
    });
    const UNKNOWN_PROFILE: ProfileMin = {
      id: 'an-unknown-profile',
      handle: 'An unknown profile',
      banner1_color: null,
      banner2_color: null,
      pfp: null,
      cic: 0,
      rep: 0,
      tdh: 0,
      level: 0,
      archived: true,
      subscribed_actions: []
    };
    const profilesByIds = allProfileIds.reduce((acc, profileId) => {
      acc[profileId] = profileMins[profileId] ?? UNKNOWN_PROFILE;
      return acc;
    }, {} as Record<string, ProfileMin>);
    return dropEntities.map<DropWithoutWave>((dropEntity) => {
      const replyToDropId = dropEntity.reply_to_drop_id;
      return {
        id: dropEntity.id,
        serial_no: dropEntity.serial_no,
        reply_to: replyToDropId
          ? {
              is_deleted: !!deletedDrops[replyToDropId],
              drop_id: replyToDropId,
              drop_part_id: dropEntity.reply_to_part_id ?? 0
            }
          : undefined,
        author: profilesByIds[dropEntity.author_id]!,
        title: dropEntity.title,
        parts:
          dropsParts[dropEntity.id]?.map<DropPart>((it) => {
            const quotedDropId = it.quoted_drop_id;
            return {
              content: it.content,
              quoted_drop:
                quotedDropId && it.quoted_drop_part_id
                  ? {
                      is_deleted: !!deletedDrops[quotedDropId],
                      drop_id: quotedDropId,
                      drop_part_id: it.quoted_drop_part_id
                    }
                  : null,
              part_id: it.drop_part_id,
              media:
                (dropMedia[dropEntity.id] ?? [])
                  .filter((m) => m.drop_part_id === it.drop_part_id)
                  .map<DropMedia>((it) => ({
                    url: it.url,
                    mime_type: it.mime_type
                  })) ?? [],
              replies_count:
                dropsRepliesCounts[it.drop_id]?.[it.drop_part_id]?.count ?? 0,
              quotes_count:
                dropsQuoteCounts[it.drop_id]?.[it.drop_part_id]?.total ?? 0,
              context_profile_context: contextProfileId
                ? {
                    replies_count:
                      dropsRepliesCounts[it.drop_id]?.[it.drop_part_id]
                        ?.context_profile_count ?? 0,
                    quotes_count:
                      dropsQuoteCounts[it.drop_id]?.[it.drop_part_id]
                        ?.by_context_profile ?? 0
                  }
                : null
            };
          }) ?? [],
        parts_count: dropEntity.parts_count,
        created_at: dropEntity.created_at,
        updated_at: parseIntOrNull(dropEntity.updated_at),
        referenced_nfts: referencedNfts
          .filter((it) => it.drop_id === dropEntity.id)
          .map<DropReferencedNFT>((it) => ({
            contract: it.contract,
            token: it.token,
            name: it.name
          })),
        mentioned_users: mentions
          .filter((it) => it.drop_id === dropEntity.id)
          .map<DropMentionedUser>((it) => ({
            mentioned_profile_id: it.mentioned_profile_id,
            handle_in_content: it.handle_in_content,
            current_handle:
              profilesByIds[it.mentioned_profile_id]?.handle ?? null
          })),
        metadata: metadata
          .filter((it) => it.drop_id === dropEntity.id)
          .map<DropMetadata>((it) => ({
            data_key: it.data_key,
            data_value: it.data_value
          })),
        rating: dropsRatings[dropEntity.id]?.rating ?? 0,
        raters_count: dropsRatings[dropEntity.id]?.distinct_raters ?? 0,
        top_raters: (dropsTopRaters[dropEntity.id] ?? [])
          .map<DropRater>((rater) => ({
            rating: rater.rating,
            profile: profilesByIds[rater.rater_profile_id]!
          }))
          .sort((a, b) => b.rating - a.rating),
        context_profile_context: contextProfileId
          ? {
              rating: dropsRatingsByContextProfile[dropEntity.id] ?? 0
            }
          : null,
        subscribed_actions: subscribedActions[dropEntity.id] ?? []
      };
    });
  }
}

export const dropsMappers = new DropsMappers(
  userGroupsService,
  profilesApiService,
  dropsDb,
  wavesApiDb,
  identitySubscriptionsDb
);
