import { feedDb, FeedDb } from './feed.db';
import { ApiFeedItem } from '../generated/models/ApiFeedItem';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import {
  ActivityEventAction,
  ActivityEventEntity,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { assertUnreachable } from '../../../assertions';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiWave } from '../generated/models/ApiWave';
import { dropsService } from '../drops/drops.api.service';
import { AuthenticationContext } from '../../../auth-context';
import { waveApiService } from '../waves/wave.api.service';
import { ForbiddenException } from '../../../exceptions';
import { ApiFeedItemType } from '../generated/models/ApiFeedItemType';
import { collections } from '../../../collections';

export class FeedApiService {
  constructor(
    private readonly feedDb: FeedDb,
    private readonly userGroupsService: UserGroupsService
  ) {}

  async getFeed(
    request: FeedApiRequest,
    authenticationContext: AuthenticationContext
  ): Promise<ApiFeedItem[]> {
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
      activityEvents.reduce(
        (acc, it) => {
          const key = this.createActionKey(it);
          if (!acc[key]) {
            acc[key] = [];
          }
          acc[key].push(it);
          return acc;
        },
        {} as Record<string, ActivityEventEntity[]>
      )
    )
      .map((it) => it.at(0)!)
      .sort((a, d) => parseInt(`${d.id}`) - parseInt(`${a.id}`))
      .slice(0, estimatedLimit);
  }

  private createActionKey(it: ActivityEventEntity): string {
    const data = JSON.parse(it.data);
    switch (it.action) {
      case ActivityEventAction.DROP_REPLIED: {
        const dropId =
          it.target_type === ActivityEventTargetType.DROP
            ? it.target_id
            : data.drop_id;
        const replyId =
          it.target_type === ActivityEventTargetType.IDENTITY
            ? data.drop_id
            : it.target_id;
        return `drop-reply-${dropId}-${replyId}`;
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
  ): Promise<ApiFeedItem[]> {
    const dropsIdsNeeded: string[] = activityEvents
      .filter((it) => {
        const action = it.action;
        return [
          ActivityEventAction.DROP_CREATED,
          ActivityEventAction.DROP_REPLIED
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
    const repliesNeeded: string[] = activityEvents
      .filter((it) => {
        const action = it.action;
        return [ActivityEventAction.DROP_REPLIED].includes(action);
      })
      .map((it) => {
        const data = JSON.parse(it.data);
        return data.reply_id as string;
      });
    const { drops, waves } = await this.getRelatedData({
      dropsIdsNeeded,
      waveIdsNeeded,
      replyDropsNeeded: repliesNeeded,
      groupIdsUserIsEligibleFor,
      authenticationContext
    });
    const feedItems = activityEvents
      .map<ApiFeedItem | null>((it) => {
        return this.activityEventToFeedItem({
          activityEvent: it,
          waves,
          drops
        });
      })
      .filter((it) => !!it) as ApiFeedItem[];
    const seenReplyPairs = new Set<string>();
    return feedItems.reduce((acc, it) => {
      if (it.type === ApiFeedItemType.DropReplied) {
        if (!it.item.drop?.id || !it.item.reply?.id) {
          return acc;
        }
        const key = `${it.item.drop.id}-${it.item.reply.id}`;
        if (seenReplyPairs.has(key)) {
          return acc;
        }
        seenReplyPairs.add(key);
      }
      acc.push(it);
      return acc;
    }, [] as ApiFeedItem[]);
  }

  private activityEventToFeedItem({
    activityEvent,
    waves,
    drops
  }: {
    activityEvent: ActivityEventEntity;
    waves: Record<string, ApiWave>;
    drops: Record<string, ApiDrop>;
  }): ApiFeedItem | null {
    const action = activityEvent.action;
    const eventId = parseInt(`${activityEvent.id}`);
    switch (action) {
      case ActivityEventAction.WAVE_CREATED: {
        const waveId = JSON.parse(activityEvent.data).wave_id as string;
        return {
          item: waves[waveId],
          serial_no: eventId,
          type: ApiFeedItemType.WaveCreated
        };
      }
      case ActivityEventAction.DROP_CREATED: {
        const dropId = (JSON.parse(activityEvent.data).drop_id ??
          activityEvent.target_id) as string;
        const drop = drops[dropId];
        if (!drop) {
          return null;
        }
        if (drop.reply_to) {
          return {
            item: {
              reply: drop,
              drop: drops[drop.reply_to.drop_id]
            },
            serial_no: eventId,
            type: ApiFeedItemType.DropReplied
          };
        }
        return {
          item: drop,
          serial_no: eventId,
          type: ApiFeedItemType.DropCreated
        };
      }
      case ActivityEventAction.DROP_REPLIED: {
        const data = JSON.parse(activityEvent.data);
        const replyId = data.reply_id as string;
        const dropId = (data.drop_id ?? activityEvent.target_id) as string;
        return {
          item: {
            drop: drops[dropId],
            reply: drops[replyId]
          },
          serial_no: eventId,
          type: ApiFeedItemType.DropReplied
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
    replyDropsNeeded,
    authenticationContext
  }: {
    groupIdsUserIsEligibleFor: string[];
    dropsIdsNeeded: string[];
    waveIdsNeeded: string[];
    replyDropsNeeded: string[];
    authenticationContext: AuthenticationContext;
  }): Promise<{
    drops: Record<string, ApiDrop>;
    waves: Record<string, ApiWave>;
  }> {
    const [drops, waves] = await Promise.all([
      dropsService
        .findDropsByIds(dropsIdsNeeded, authenticationContext)
        .then(async (drops) => {
          const replyDropIds = Object.values(drops)
            .map((it) => it.reply_to?.drop_id)
            .filter((it) => !!it)
            .map((it) => it!);
          const allReplyDropIds = collections.distinct([
            ...replyDropsNeeded,
            ...replyDropIds
          ]);
          const replies = await dropsService.findDropsByIds(
            allReplyDropIds,
            authenticationContext
          );
          return { ...drops, ...replies };
        }),
      waveApiService.findWavesByIdsOrThrow(
        waveIdsNeeded,
        groupIdsUserIsEligibleFor,
        authenticationContext
      )
    ]);
    return {
      drops,
      waves
    };
  }
}

export interface FeedApiRequest {
  readonly serial_no_less_than: number | null;
}

export const feedApiService = new FeedApiService(feedDb, userGroupsService);
