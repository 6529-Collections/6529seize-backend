import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { AttachmentEntity, DropAttachmentEntity } from '@/entities/IAttachment';
import {
  DropEntity,
  DropGroupMentionEntity,
  DropMentionedWaveEntity,
  DropMentionEntity,
  DropReferencedNftEntity,
  DropType
} from '@/entities/IDrop';
import { NftLinkEntity } from '@/entities/INftLink';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { RequestContext } from '@/request.context';
import { collections } from '@/collections';
import { enums } from '@/enums';
import { numbers } from '@/numbers';
import { DropReplyPreview, dropsDb, DropsDb } from '@/drops/drops.db';
import { dropNftLinksDb, DropNftLinksDb } from '@/drops/drop-nft-links.db';
import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';
import { mapAttachmentToApiAttachment } from '@/api/attachments/attachments.mappers';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';
import { ApiDropGroupMention } from '@/api/generated/models/ApiDropGroupMention';
import { ApiDropMainType } from '@/api/generated/models/ApiDropMainType';
import { ApiDropMentionedUser } from '@/api/generated/models/ApiDropMentionedUser';
import { ApiDropNftLink } from '@/api/generated/models/ApiDropNftLink';
import { ApiDropReactionCounter } from '@/api/generated/models/ApiDropReactionCounter';
import { ApiDropReferencedNFT } from '@/api/generated/models/ApiDropReferencedNFT';
import { ApiDropV2 } from '@/api/generated/models/ApiDropV2';
import { ApiDropV2ContextProfileContext } from '@/api/generated/models/ApiDropV2ContextProfileContext';
import { ApiMentionedWaveV2 } from '@/api/generated/models/ApiMentionedWaveV2';
import { ApiReplyToDropV2 } from '@/api/generated/models/ApiReplyToDropV2';
import { ApiSubmissionDropContext } from '@/api/generated/models/ApiSubmissionDropContext';
import { ApiSubmissionDropStatus } from '@/api/generated/models/ApiSubmissionDropStatus';
import { ApiSubmissionDropVoting } from '@/api/generated/models/ApiSubmissionDropVoting';
import { ApiSubmissionDropVotingContextProfileContext } from '@/api/generated/models/ApiSubmissionDropVotingContextProfileContext';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '@/api/identity-subscriptions/identity-subscriptions.db';
import { getWaveReadContextProfileId } from '@/api/waves/wave-access.helpers';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  wavesApiDb,
  WavesApiDb,
  WaveMentionOverview
} from '@/api/waves/waves.api.db';
import {
  directMessageWaveDisplayService,
  DirectMessageWaveDisplayService,
  resolveWavePictureOverride
} from '@/api/waves/direct-message-wave-display.service';
import {
  DropReactionCountersResult,
  reactionsDb,
  ReactionsDb
} from '@/api/drops/reactions.db';
import {
  dropBookmarksDb,
  DropBookmarksDb
} from '@/api/drops/drop-bookmarks.db';
import {
  DropSubmissionVotingSummary,
  dropVotingDb,
  DropVotingDb
} from '@/api/drops/drop-voting.db';
import {
  dropVotingService,
  DropVotingService
} from '@/api/drops/drop-voting.service';
import { nftLinksDb, NftLinksDb } from '@/nft-links/nft-links.db';
import { mapNftLinkEntityToApiLink } from '@/nft-links/nft-link-api.mapper';
import {
  nftLinkResolvingService,
  NftLinkResolvingService
} from '@/nft-links/nft-link-resolving.service';

type VoteRangeByDropId = Record<
  string,
  { min: number; max: number; current: number }
>;

export class ApiDropMapper {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly identitiesDb: IdentitiesDb,
    private readonly dropsDb: DropsDb,
    private readonly attachmentsDb: AttachmentsDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly wavesApiDb: WavesApiDb,
    private readonly directMessageWaveDisplayService: DirectMessageWaveDisplayService,
    private readonly reactionsDb: ReactionsDb,
    private readonly dropBookmarksDb: DropBookmarksDb,
    private readonly dropVotingDb: DropVotingDb,
    private readonly dropVotingService: DropVotingService,
    private readonly dropNftLinksDb: DropNftLinksDb,
    private readonly nftLinksDb: NftLinksDb,
    private readonly nftLinkResolvingService: NftLinkResolvingService
  ) {}

  public async mapDrops(
    dropEntities: DropEntity[],
    ctx: RequestContext
  ): Promise<Record<string, ApiDropV2>> {
    const timerKey = `${this.constructor.name}->mapDrops`;
    ctx.timer?.start(timerKey);
    try {
      const entities = collections.distinctBy(dropEntities, (drop) => drop.id);
      if (!entities.length) {
        return {};
      }
      const dropIds = entities.map((drop) => drop.id);
      const contextProfileId = getWaveReadContextProfileId(
        ctx.authenticationContext
      );
      const authorIds = collections.distinct(
        entities.map((drop) => drop.author_id)
      );
      const replyDropIds = collections.distinct(
        entities
          .map((drop) => drop.reply_to_drop_id)
          .filter((id): id is string => !!id)
      );
      const submissionEntities = entities.filter((drop) =>
        this.isSubmissionDrop(drop)
      );
      const submissionDropIds = submissionEntities.map((drop) => drop.id);
      const participatoryDropEntities = submissionEntities.filter(
        (drop) => drop.drop_type === DropType.PARTICIPATORY
      );
      const winnerDropIds = submissionEntities
        .filter((drop) => drop.drop_type === DropType.WINNER)
        .map((drop) => drop.id);

      const dropAttachmentsPromise =
        this.attachmentsDb.getDropPartOneAttachments(dropIds, ctx);
      const attachmentsByIdPromise = dropAttachmentsPromise.then(
        (dropAttachments) =>
          this.findAttachmentsByDropAttachments(dropAttachments, ctx)
      );
      const mentionsPromise = this.dropsDb.findMentionsByDropIds(
        dropIds,
        ctx.connection
      );
      const mentionedHandlesPromise = mentionsPromise.then((mentions) =>
        this.getMentionedHandles(mentions, ctx)
      );
      const mentionedWavesPromise = this.dropsDb.findMentionedWavesByDropIds(
        dropIds,
        ctx.connection
      );
      const mentionedWaveOverviewsPromise = mentionedWavesPromise.then(
        (mentionedWaves) =>
          this.getMentionedWaveOverviews(mentionedWaves, contextProfileId, ctx)
      );

      const [
        authorsById,
        partOnes,
        partOneMedia,
        dropAttachments,
        attachmentsById,
        referencedNfts,
        mentions,
        mentionedHandles,
        mentionedGroups,
        mentionedWaves,
        mentionedWaveOverviews,
        nftLinksByDropId,
        submissionDropIdsWithMetadata,
        reactionsByDropId,
        boostsCount,
        boostedDropIds,
        bookmarkedDropIds,
        subscribedActions,
        replyPreviews,
        submissionVotingSummaries,
        votingRanges,
        winningDropsRatingsByVoter
      ] = await Promise.all([
        this.identityFetcher.getApiIdentityOverviewsByIds(authorIds, ctx),
        this.dropsDb.getDropPartOnes(dropIds, ctx),
        this.dropsDb.getDropPartOneMedia(dropIds, ctx),
        dropAttachmentsPromise,
        attachmentsByIdPromise,
        this.dropsDb.findReferencedNftsByDropIds(dropIds, ctx.connection),
        mentionsPromise,
        mentionedHandlesPromise,
        this.dropsDb.findDropGroupMentionsByDropIds(dropIds, ctx.connection),
        mentionedWavesPromise,
        mentionedWaveOverviewsPromise,
        this.getNftLinksByDropId(dropIds, ctx),
        submissionDropIds.length
          ? this.dropsDb.findDropIdsWithMetadata(submissionDropIds, ctx)
          : Promise.resolve(new Set<string>()),
        this.reactionsDb.getCountersByDropIds(dropIds, contextProfileId, ctx),
        this.dropsDb.countBoostsOfGivenDrops(dropIds, ctx),
        contextProfileId
          ? this.dropsDb.whichOfGivenDropsAreBoostedByIdentity(
              dropIds,
              contextProfileId,
              ctx
            )
          : Promise.resolve(new Set<string>()),
        contextProfileId
          ? this.dropBookmarksDb.findBookmarkedDropIds(
              {
                identity_id: contextProfileId,
                drop_ids: dropIds
              },
              ctx.connection
            )
          : Promise.resolve(new Set<string>()),
        contextProfileId
          ? this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTargets(
              {
                subscriber_id: contextProfileId,
                target_ids: dropIds,
                target_type: ActivityEventTargetType.DROP
              },
              ctx.connection
            )
          : Promise.resolve({} as Record<string, ActivityEventAction[]>),
        this.dropsDb.getReplyPreviewsByDropIds(replyDropIds, ctx),
        this.dropVotingDb.getDropV2SubmissionVotingSummaries(
          submissionDropIds,
          ctx
        ),
        contextProfileId
          ? this.dropVotingService.findCreditLeftForVotingForDrops(
              contextProfileId,
              participatoryDropEntities,
              ctx.connection
            )
          : Promise.resolve({} as VoteRangeByDropId),
        contextProfileId
          ? this.dropVotingDb.getWinningDropsRatingsByVoter(
              winnerDropIds,
              contextProfileId,
              ctx
            )
          : Promise.resolve({} as Record<string, number>)
      ]);

      const referencedNftsByDropId = this.groupByDropId(referencedNfts);
      const mentionsByDropId = this.groupByDropId(mentions);
      const mentionedGroupsByDropId =
        this.mapMentionedGroupsByDropId(mentionedGroups);
      const mentionedWavesByDropId = this.groupByDropId(mentionedWaves);

      return entities.reduce(
        (acc, drop) => {
          acc[drop.id] = this.mapDrop({
            drop,
            author: authorsById[drop.author_id],
            partOne: partOnes[drop.id],
            partOneMedia: partOneMedia[drop.id] ?? [],
            dropAttachments: dropAttachments[drop.id] ?? [],
            attachmentsById,
            referencedNfts: referencedNftsByDropId[drop.id] ?? [],
            mentions: mentionsByDropId[drop.id] ?? [],
            mentionedHandles,
            mentionedGroups: mentionedGroupsByDropId[drop.id] ?? [],
            mentionedWaves: mentionedWavesByDropId[drop.id] ?? [],
            mentionedWaveOverviews,
            nftLinks: nftLinksByDropId[drop.id] ?? [],
            hasMetadata: submissionDropIdsWithMetadata.has(drop.id),
            reactions: reactionsByDropId.get(drop.id),
            boosts: boostsCount[drop.id] ?? 0,
            boosted: boostedDropIds.has(drop.id),
            bookmarked: bookmarkedDropIds.has(drop.id),
            subscribed: (subscribedActions[drop.id] ?? []).length > 0,
            replyPreview: drop.reply_to_drop_id
              ? replyPreviews[drop.reply_to_drop_id]
              : undefined,
            submissionVotingSummary: submissionVotingSummaries[drop.id],
            votingRanges,
            winningDropsRatingsByVoter,
            contextProfileId
          });
          return acc;
        },
        {} as Record<string, ApiDropV2>
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private mapDrop({
    drop,
    author,
    partOne,
    partOneMedia,
    dropAttachments,
    attachmentsById,
    referencedNfts,
    mentions,
    mentionedHandles,
    mentionedGroups,
    mentionedWaves,
    mentionedWaveOverviews,
    nftLinks,
    hasMetadata,
    reactions,
    boosts,
    boosted,
    bookmarked,
    subscribed,
    replyPreview,
    submissionVotingSummary,
    votingRanges,
    winningDropsRatingsByVoter,
    contextProfileId
  }: {
    drop: DropEntity;
    author: ApiDropV2['author'];
    partOne?: { content: string | null };
    partOneMedia: { url: string; mime_type: string }[];
    dropAttachments: DropAttachmentEntity[];
    attachmentsById: Record<string, AttachmentEntity>;
    referencedNfts: DropReferencedNftEntity[];
    mentions: DropMentionEntity[];
    mentionedHandles: Record<string, string>;
    mentionedGroups: ApiDropGroupMention[];
    mentionedWaves: DropMentionedWaveEntity[];
    mentionedWaveOverviews: Record<string, WaveMentionOverview>;
    nftLinks: ApiDropNftLink[];
    hasMetadata: boolean;
    reactions?: DropReactionCountersResult;
    boosts: number;
    boosted: boolean;
    bookmarked: boolean;
    subscribed: boolean;
    replyPreview?: DropReplyPreview;
    submissionVotingSummary?: DropSubmissionVotingSummary;
    votingRanges: VoteRangeByDropId;
    winningDropsRatingsByVoter: Record<string, number>;
    contextProfileId: string | null;
  }): ApiDropV2 {
    const apiDrop: ApiDropV2 = {
      id: drop.id,
      serial_no: drop.serial_no,
      created_at: drop.created_at,
      is_signed: !!drop.signature,
      hide_link_preview: drop.hide_link_preview ?? false,
      parts_count: drop.parts_count,
      author,
      drop_type: this.mapDropType(drop.drop_type),
      boosts
    };
    const updatedAt = numbers.parseIntOrNull(drop.updated_at);
    if (updatedAt !== null) {
      apiDrop.updated_at = updatedAt;
    }
    if (drop.title !== null) {
      apiDrop.title = drop.title;
    }
    if (partOne?.content !== null && partOne?.content !== undefined) {
      apiDrop.content = partOne.content;
    }
    const media = partOneMedia.map((it) => ({
      url: it.url,
      mime_type: it.mime_type
    }));
    if (media.length) {
      apiDrop.media = media;
    }
    const attachments = this.mapAttachments(dropAttachments, attachmentsById);
    if (attachments.length) {
      apiDrop.attachments = attachments;
    }
    const apiReferencedNfts = referencedNfts.map<ApiDropReferencedNFT>(
      (it) => ({
        contract: it.contract,
        token: it.token,
        name: it.name
      })
    );
    if (apiReferencedNfts.length) {
      apiDrop.referenced_nfts = apiReferencedNfts;
    }
    const apiMentions = mentions.map<ApiDropMentionedUser>((mention) => {
      const apiMention: ApiDropMentionedUser = {
        mentioned_profile_id: mention.mentioned_profile_id,
        handle_in_content: mention.handle_in_content
      };
      const currentHandle = mentionedHandles[mention.mentioned_profile_id];
      if (currentHandle !== undefined) {
        apiMention.current_handle = currentHandle;
      }
      return apiMention;
    });
    if (apiMentions.length) {
      apiDrop.mentioned_users = apiMentions;
    }
    if (mentionedGroups.length) {
      apiDrop.mentioned_groups = mentionedGroups;
    }
    const apiMentionedWaves = mentionedWaves.map<ApiMentionedWaveV2>(
      (mention) => {
        const apiMentionedWave: ApiMentionedWaveV2 = {
          id: mention.wave_id,
          in_content: mention.wave_name_in_content
        };
        const overview = mentionedWaveOverviews[mention.wave_id];
        if (overview) {
          apiMentionedWave.name = overview.name;
          if (overview.picture !== null) {
            apiMentionedWave.pfp = overview.picture;
          }
        }
        return apiMentionedWave;
      }
    );
    if (apiMentionedWaves.length) {
      apiDrop.mentioned_waves = apiMentionedWaves;
    }
    if (nftLinks.length) {
      apiDrop.nft_links = nftLinks;
    }
    const reactionCounters = (reactions?.reactions ?? []).map(
      (reaction): ApiDropReactionCounter => ({
        reaction: reaction.reaction,
        count: reaction.count
      })
    );
    if (reactionCounters.length) {
      apiDrop.reactions = reactionCounters;
    }
    if (drop.reply_to_drop_id) {
      apiDrop.reply_to_drop = this.mapReplyToDrop(
        drop.reply_to_drop_id,
        replyPreview
      );
    }
    if (submissionVotingSummary) {
      apiDrop.submission_context = this.mapSubmissionContext({
        drop,
        votingSummary: submissionVotingSummary,
        votingRanges,
        winningDropsRatingsByVoter,
        contextProfileId,
        hasMetadata
      });
    }
    if (contextProfileId) {
      const context: ApiDropV2ContextProfileContext = {
        boosted,
        bookmarked,
        subscribed
      };
      if (reactions?.context_profile_reaction !== undefined) {
        context.reaction = reactions.context_profile_reaction;
      }
      apiDrop.context_profile_context = context;
    }
    return apiDrop;
  }

  private mapReplyToDrop(
    dropId: string,
    replyPreview?: DropReplyPreview
  ): ApiReplyToDropV2 {
    const apiReply: ApiReplyToDropV2 = { id: dropId };
    if (!replyPreview) {
      return apiReply;
    }
    apiReply.serial_no = Number(replyPreview.serial_no);
    if (replyPreview.content !== null) {
      apiReply.content = replyPreview.content;
    }
    if (
      replyPreview.author_handle !== null &&
      replyPreview.author_pfp !== null
    ) {
      apiReply.author = {
        handle: replyPreview.author_handle,
        pfp: replyPreview.author_pfp
      };
    }
    return apiReply;
  }

  private mapSubmissionContext({
    drop,
    votingSummary,
    votingRanges,
    winningDropsRatingsByVoter,
    contextProfileId,
    hasMetadata
  }: {
    drop: DropEntity;
    votingSummary: DropSubmissionVotingSummary;
    votingRanges: VoteRangeByDropId;
    winningDropsRatingsByVoter: Record<string, number>;
    contextProfileId: string | null;
    hasMetadata: boolean;
  }): ApiSubmissionDropContext {
    const voting: ApiSubmissionDropVoting = {
      is_open: votingSummary.is_open,
      total_votes_given: votingSummary.total_votes_given,
      current_calculated_vote: votingSummary.current_calculated_vote,
      predicted_final_vote: votingSummary.predicted_final_vote,
      voters_count: votingSummary.voters_count,
      place: votingSummary.place
    };
    if (contextProfileId) {
      voting.context_profile_context = this.mapSubmissionVotingContext({
        drop,
        votingSummary,
        votingRanges,
        winningDropsRatingsByVoter
      });
    }
    return {
      status:
        drop.drop_type === DropType.WINNER
          ? ApiSubmissionDropStatus.Winner
          : ApiSubmissionDropStatus.Active,
      voting,
      has_metadata: hasMetadata
    };
  }

  private mapSubmissionVotingContext({
    drop,
    votingSummary,
    votingRanges,
    winningDropsRatingsByVoter
  }: {
    drop: DropEntity;
    votingSummary: DropSubmissionVotingSummary;
    votingRanges: VoteRangeByDropId;
    winningDropsRatingsByVoter: Record<string, number>;
  }): ApiSubmissionDropVotingContextProfileContext {
    if (drop.drop_type === DropType.WINNER) {
      const current = winningDropsRatingsByVoter[drop.id] ?? 0;
      return {
        can_vote: false,
        min: current,
        max: current,
        current
      };
    }
    const votingRange = votingRanges[drop.id];
    let min = votingRange?.min ?? 0;
    if (votingSummary.forbid_negative_votes && min < 0) {
      min = 0;
    }
    const current = votingRange?.current ?? 0;
    const max = votingRange?.max ?? 0;
    return {
      can_vote: votingSummary.is_open && (min !== current || max !== current),
      min,
      max,
      current
    };
  }

  private mapAttachments(
    dropAttachments: DropAttachmentEntity[],
    attachmentsById: Record<string, AttachmentEntity>
  ): ApiAttachment[] {
    return dropAttachments
      .map((dropAttachment) => attachmentsById[dropAttachment.attachment_id])
      .filter((attachment): attachment is AttachmentEntity => !!attachment)
      .map((attachment) => {
        const apiAttachment = mapAttachmentToApiAttachment(attachment);
        if (apiAttachment.url === null) {
          delete apiAttachment.url;
        }
        if (apiAttachment.error_reason === null) {
          delete apiAttachment.error_reason;
        }
        return apiAttachment;
      });
  }

  private async findAttachmentsByDropAttachments(
    dropAttachmentsByDropId: Record<string, DropAttachmentEntity[]>,
    ctx: RequestContext
  ): Promise<Record<string, AttachmentEntity>> {
    const attachmentIds = collections.distinct(
      Object.values(dropAttachmentsByDropId)
        .flat()
        .map((attachment) => attachment.attachment_id)
    );
    return attachmentIds.length
      ? this.attachmentsDb.findAttachmentsByIds(attachmentIds, ctx.connection)
      : {};
  }

  private async getMentionedHandles(
    mentions: DropMentionEntity[],
    ctx: RequestContext
  ): Promise<Record<string, string>> {
    const mentionedProfileIds = collections.distinct(
      mentions.map((mention) => mention.mentioned_profile_id)
    );
    return this.identitiesDb.findProfileHandlesByIds(mentionedProfileIds, ctx);
  }

  private async getMentionedWaveOverviews(
    mentionedWaves: DropMentionedWaveEntity[],
    contextProfileId: string | null,
    ctx: RequestContext
  ): Promise<Record<string, WaveMentionOverview>> {
    const mentionedWaveIds = collections.distinct(
      mentionedWaves.map((mention) => mention.wave_id)
    );
    if (!mentionedWaveIds.length) {
      return {};
    }
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        contextProfileId,
        ctx.timer
      );
    const waveOverviewsById =
      await this.wavesApiDb.findWaveMentionOverviewsByIds(
        mentionedWaveIds,
        groupIdsUserIsEligibleFor,
        ctx
      );
    const waveOverviews = Object.values(waveOverviewsById);
    if (!waveOverviews.length) {
      return {};
    }
    const displayByWaveId =
      await this.directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext(
        {
          waveEntities: waveOverviews,
          contextProfileId
        },
        ctx.connection
      );
    return waveOverviews.reduce(
      (acc, waveOverview) => {
        acc[waveOverview.id] = {
          ...waveOverview,
          name: displayByWaveId[waveOverview.id]?.name ?? waveOverview.name,
          picture: resolveWavePictureOverride(
            waveOverview.picture,
            displayByWaveId[waveOverview.id]
          )
        };
        return acc;
      },
      {} as Record<string, WaveMentionOverview>
    );
  }

  private async getNftLinksByDropId(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, ApiDropNftLink[]>> {
    const dropNftLinks = await this.dropNftLinksDb.findByDropIds(
      dropIds,
      ctx.connection
    );
    const canonicalIds = collections.distinct(
      dropNftLinks.map((link) => link.canonical_id)
    );
    const resolvedNftLinksByCanonicalId = (
      await this.nftLinksDb.findByCanonicalIds(canonicalIds, ctx)
    ).reduce(
      (acc, link) => {
        acc[link.canonical_id] = link;
        return acc;
      },
      {} as Record<string, NftLinkEntity>
    );
    const linksByDropId = dropNftLinks.reduce(
      (acc, link) => {
        const links = acc[link.drop_id] ?? [];
        const resolvedLink = resolvedNftLinksByCanonicalId[link.canonical_id];
        links.push({
          url_in_text: link.url_in_text,
          data: resolvedLink ? mapNftLinkEntityToApiLink(resolvedLink) : null
        });
        acc[link.drop_id] = links;
        return acc;
      },
      {} as Record<string, ApiDropNftLink[]>
    );
    if (!ctx.connection && dropNftLinks.length) {
      void this.nftLinkResolvingService
        .refreshStaleTrackingForUrls(
          dropNftLinks.map((link) => link.url_in_text),
          { connection: ctx.connection }
        )
        .catch(() => undefined);
    }
    return linksByDropId;
  }

  private groupByDropId<T extends { drop_id: string }>(
    rows: T[]
  ): Record<string, T[]> {
    return rows.reduce(
      (acc, row) => {
        const items = acc[row.drop_id] ?? [];
        items.push(row);
        acc[row.drop_id] = items;
        return acc;
      },
      {} as Record<string, T[]>
    );
  }

  private mapMentionedGroupsByDropId(
    mentionedGroups: DropGroupMentionEntity[]
  ): Record<string, ApiDropGroupMention[]> {
    return mentionedGroups.reduce(
      (acc, mention) => {
        const groups = acc[mention.drop_id] ?? [];
        groups.push(
          enums.resolveOrThrow(ApiDropGroupMention, mention.mentioned_group)
        );
        acc[mention.drop_id] = groups;
        return acc;
      },
      {} as Record<string, ApiDropGroupMention[]>
    );
  }

  private mapDropType(dropType: DropType): ApiDropMainType {
    return dropType === DropType.CHAT
      ? ApiDropMainType.Chat
      : ApiDropMainType.Submission;
  }

  private isSubmissionDrop(drop: DropEntity): boolean {
    return (
      drop.drop_type === DropType.PARTICIPATORY ||
      drop.drop_type === DropType.WINNER
    );
  }
}

export const apiDropMapper = new ApiDropMapper(
  identityFetcher,
  identitiesDb,
  dropsDb,
  attachmentsDb,
  identitySubscriptionsDb,
  userGroupsService,
  wavesApiDb,
  directMessageWaveDisplayService,
  reactionsDb,
  dropBookmarksDb,
  dropVotingDb,
  dropVotingService,
  dropNftLinksDb,
  nftLinksDb,
  nftLinkResolvingService
);
