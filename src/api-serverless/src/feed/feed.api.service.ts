import { feedDb, FeedDb } from './feed.db';
import { FeedItem } from '../generated/models/FeedItem';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import {
  ActivityEventAction,
  ActivityEventEntity,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { assertUnreachable, parseIntOrNull } from '../../../helpers';
import { Drop } from '../generated/models/Drop';
import { Wave } from '../generated/models/Wave';
import { DropComment } from '../generated/models/DropComment';
import { DropVote } from '../generated/models/DropVote';
import { dropsService } from '../drops/drops.api.service';
import { AuthenticationContext } from '../../../auth-context';
import { waveApiService } from '../waves/wave.api.service';
import { ForbiddenException } from '../../../exceptions';
import { profilesApiService } from '../profiles/profiles.api.service';
import { FeedItemType } from '../generated/models/FeedItemType';

export class FeedApiService {
  constructor(
    private readonly feedDb: FeedDb,
    private readonly userGroupsService: UserGroupsService
  ) {}

  async getFeed(
    request: FeedApiRequest,
    authenticationContext: AuthenticationContext
  ): Promise<FeedItem[]> {
    const authenticatedUserId = authenticationContext.getActingAsId();
    if (!authenticatedUserId) {
      throw new ForbiddenException(`Create a profile before accessing feed`);
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies cannot access feed`);
    }
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticatedUserId
      );
    const estimatedLimit = 20;
    const activityEvents = await this.feedDb
      .getNextActivityEvents({
        subscriber_id: authenticatedUserId,
        visibility_group_ids: groupsUserIsEligibleFor,
        limit: estimatedLimit * 3,
        serial_no_less_than: request.serial_no_less_than
      })
      .then((it) => this.groupDuplicates(it, estimatedLimit));
    return await this.createFeedItems(
      activityEvents,
      authenticationContext,
      groupsUserIsEligibleFor
    );
  }

  private groupDuplicates(
    activityEvents: ActivityEventEntity[],
    estimatedLimit: number
  ): ActivityEventEntity[] {
    return Object.values(
      activityEvents.reduce((acc, it) => {
        const key = this.createActionKey(it);
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(it);
        return acc;
      }, {} as Record<string, ActivityEventEntity[]>)
    )
      .map((it) => it.at(-1)!)
      .sort((a, d) => parseInt(`${d.id}`) - parseInt(`${a.id}`))
      .slice(0, estimatedLimit);
  }

  private createActionKey(it: ActivityEventEntity): string {
    const data = JSON.parse(it.data);
    switch (it.action) {
      case ActivityEventAction.DROP_COMMENTED: {
        const dropId =
          it.target_type === ActivityEventTargetType.DROP
            ? it.target_id
            : data.drop_id;
        const voterId =
          it.target_type === ActivityEventTargetType.IDENTITY
            ? data.drop_id
            : it.target_id;
        return `drop-comment-${dropId}-${voterId}`;
      }
      case ActivityEventAction.DROP_VOTED: {
        const dropId =
          it.target_type === ActivityEventTargetType.DROP
            ? it.target_id
            : data.drop_id;
        const voterId =
          it.target_type === ActivityEventTargetType.IDENTITY
            ? data.drop_id
            : it.target_id;
        return `drop-vote-${dropId}-${voterId}`;
      }
      case ActivityEventAction.DROP_CREATED: {
        const creatorId =
          it.target_type === ActivityEventTargetType.IDENTITY
            ? it.target_id
            : data.creator_id;
        const dropId = data.drop_id;
        return `drop-created-${creatorId}-${dropId}`;
      }
      case ActivityEventAction.WAVE_CREATED: {
        const identity = it.target_id;
        return `wave-created-${identity}`;
      }
      default: {
        assertUnreachable(it.action);
      }
    }
    return ''; //  unreachable, but compiler needs it
  }

  private async createFeedItems(
    activityEvents: ActivityEventEntity[],
    authenticationContext: AuthenticationContext,
    groupIdsUserIsEligibleFor: string[]
  ): Promise<FeedItem[]> {
    const dropsIdsNeeded: string[] = activityEvents
      .filter((it) => {
        const action = it.action;
        return [
          ActivityEventAction.DROP_CREATED,
          ActivityEventAction.DROP_VOTED,
          ActivityEventAction.DROP_COMMENTED
        ].includes(action);
      })
      .map((it) => {
        const data = JSON.parse(it.data);
        return data.drop_id ?? it.target_id;
      });
    const waveIdsNeeded: string[] = activityEvents
      .filter((it) => {
        const action = it.action;
        return [ActivityEventAction.WAVE_CREATED].includes(action);
      })
      .map((it) => {
        const data = JSON.parse(it.data);
        return data.wave_id ?? it.target_id;
      });
    const commentsNeeded: number[] = activityEvents
      .filter((it) => {
        const action = it.action;
        return [ActivityEventAction.DROP_COMMENTED].includes(action);
      })
      .map((it) => {
        const data = JSON.parse(it.data);
        return parseIntOrNull(data.comment_id as string)!;
      });
    const votesNeeded: {
      dropId: string;
      voterId: string;
      vote: number;
    }[] = activityEvents
      .filter((it) => {
        const action = it.action;
        return [ActivityEventAction.DROP_VOTED].includes(action);
      })
      .map((it) => {
        const data = JSON.parse(it.data);
        const dropId = (data.drop_id ?? it.target_id) as string;
        const voterId = (data.voter_id ?? it.target_id) as string;
        return { dropId, voterId, vote: data.vote };
      });
    const { drops, waves, votes, comments } = await this.getRelatedData({
      dropsIdsNeeded,
      waveIdsNeeded,
      commentsNeeded,
      votesNeeded,
      groupIdsUserIsEligibleFor,
      authenticationContext
    });
    return activityEvents.map<FeedItem>((it) => {
      return this.activityEventToFeedItem({
        activityEvent: it,
        waves,
        drops,
        comments,
        votes
      });
    });
  }

  private activityEventToFeedItem({
    activityEvent,
    waves,
    drops,
    comments,
    votes
  }: {
    activityEvent: ActivityEventEntity;
    waves: Record<string, Wave>;
    drops: Record<string, Drop>;
    comments: Record<string, DropComment>;
    votes: Record<string, DropVote>;
  }): FeedItem {
    const action = activityEvent.action;
    const eventId = parseInt(`${activityEvent.id}`);
    switch (action) {
      case ActivityEventAction.WAVE_CREATED: {
        const waveId = JSON.parse(activityEvent.data).wave_id as string;
        return {
          item: waves[waveId],
          serial_no: eventId,
          type: FeedItemType.WaveCreated
        };
      }
      case ActivityEventAction.DROP_CREATED: {
        const dropId = (JSON.parse(activityEvent.data).drop_id ??
          activityEvent.target_id) as string;
        return {
          item: drops[dropId],
          serial_no: eventId,
          type: FeedItemType.DropCreated
        };
      }
      case ActivityEventAction.DROP_COMMENTED: {
        const data = JSON.parse(activityEvent.data);
        const dropId = (data.drop_id ?? activityEvent.target_id) as string;
        const commentId = data.comment_id as string;
        return {
          item: {
            drop: drops[dropId],
            comment: comments[commentId]
          },
          serial_no: eventId,
          type: FeedItemType.DropCommented
        };
      }
      case ActivityEventAction.DROP_VOTED: {
        const data = JSON.parse(activityEvent.data);
        const dropId = (data.drop_id ?? activityEvent.target_id) as string;
        const voterId = (data.voter_id ?? activityEvent.target_id) as string;
        return {
          item: {
            drop: drops[dropId],
            vote: votes[`${dropId}-${voterId}`]
          },
          serial_no: eventId,
          type: FeedItemType.DropVoted
        };
      }
      default: {
        return assertUnreachable(action);
      }
    }
  }

  private async getRelatedData({
    groupIdsUserIsEligibleFor,
    dropsIdsNeeded,
    waveIdsNeeded,
    commentsNeeded,
    votesNeeded,
    authenticationContext
  }: {
    groupIdsUserIsEligibleFor: string[];
    dropsIdsNeeded: string[];
    waveIdsNeeded: string[];
    commentsNeeded: number[];
    votesNeeded: { dropId: string; vote: number; voterId: string }[];
    authenticationContext: AuthenticationContext;
  }): Promise<{
    drops: Record<string, Drop>;
    waves: Record<string, Wave>;
    comments: Record<string, DropComment>;
    votes: Record<string, DropVote>;
  }> {
    const [drops, waves, comments, votes] = await Promise.all([
      dropsService.findDropsByIdsOrThrow(dropsIdsNeeded, authenticationContext),
      waveApiService.findWavesByIdsOrThrow(
        waveIdsNeeded,
        groupIdsUserIsEligibleFor,
        authenticationContext
      ),
      dropsService.findCommentsByIds(
        commentsNeeded,
        authenticationContext.getActingAsId()
      ),
      profilesApiService
        .getProfileMinsByIds({
          ids: votesNeeded.map((it) => it.voterId),
          authenticatedProfileId: authenticationContext.getActingAsId()
        })
        .then((result) => {
          return votesNeeded.reduce((acc, it) => {
            const vote = new DropVote();
            vote.voter = result[it.voterId];
            vote.vote = it.vote;
            acc[`${it.dropId}-${it.voterId}`] = {
              voter: result[it.voterId],
              vote: it.vote
            };
            return acc;
          }, {} as Record<string, DropVote>);
        })
    ]);
    return {
      drops,
      waves,
      comments,
      votes
    };
  }
}

export interface FeedApiRequest {
  readonly serial_no_less_than: number | null;
}

export const feedApiService = new FeedApiService(feedDb, userGroupsService);
