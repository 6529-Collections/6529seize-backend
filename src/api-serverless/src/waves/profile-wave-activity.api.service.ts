import type { ApiProfileWaveActivity } from '@/api/generated/models/ApiProfileWaveActivity';
import type { ApiProfileWaveActivityPage } from '@/api/generated/models/ApiProfileWaveActivityPage';
import { ApiProfileWaveActivityType } from '@/api/generated/models/ApiProfileWaveActivityType';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import { getGroupsUserIsEligibleForReadContext } from '@/api/waves/wave-access.helpers';
import {
  profileWaveActivityCursorCodec,
  ProfileWaveActivityCursorCodec
} from '@/api/waves/profile-wave-activity.cursor';
import type { ProfileWaveActivityDbItem } from '@/api/waves/waves.api.db';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { assertUnreachable } from '@/assertions';
import { RequestContext } from '@/request.context';

export interface GetProfileWaveActivityRequest {
  readonly identity: string;
  readonly activityType: ApiProfileWaveActivityType;
  readonly limit: number;
  readonly cursor?: string;
}

export class ProfileWaveActivityApiService {
  public constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly userGroupsService: UserGroupsService,
    private readonly wavesApiDb: WavesApiDb,
    private readonly cursorCodec: ProfileWaveActivityCursorCodec
  ) {}

  public async getProfileWaveActivity(
    request: GetProfileWaveActivityRequest,
    ctx: RequestContext
  ): Promise<ApiProfileWaveActivityPage> {
    const timerKey = `${this.constructor.name}->getProfileWaveActivity`;
    ctx.timer?.start(timerKey);
    try {
      const [targetProfileId, eligibleGroups] = await Promise.all([
        this.identityFetcher.getProfileIdByIdentityKeyOrThrow(
          { identityKey: request.identity },
          ctx
        ),
        getGroupsUserIsEligibleForReadContext(this.userGroupsService, ctx)
      ]);
      switch (request.activityType) {
        case ApiProfileWaveActivityType.Created: {
          const candidates =
            await this.wavesApiDb.findCreatedProfileWaveActivity(
              {
                profileId: targetProfileId,
                eligibleGroups,
                limit: request.limit + 1,
                cursor: this.cursorCodec.decodeCreated(
                  request.cursor,
                  targetProfileId
                )
              },
              ctx
            );
          return this.buildPage({
            candidates,
            limit: request.limit,
            encodeCursor: (item) =>
              this.cursorCodec.encodeCreated(targetProfileId, {
                hasQualifyingPost: item.hasQualifyingPost ? 1 : 0,
                latestPostTimestamp: item.latestPostTimestamp ?? 0,
                waveSerialNo: item.waveSerialNo,
                waveId: item.waveId
              })
          });
        }
        case ApiProfileWaveActivityType.Recent: {
          const candidates =
            await this.wavesApiDb.findRecentProfileWaveActivity(
              {
                profileId: targetProfileId,
                eligibleGroups,
                limit: request.limit + 1,
                cursor: this.cursorCodec.decodeRecent(
                  request.cursor,
                  targetProfileId
                )
              },
              ctx
            );
          return this.buildPage({
            candidates,
            limit: request.limit,
            encodeCursor: (item) =>
              this.cursorCodec.encodeRecent(targetProfileId, {
                latestPostTimestamp: item.latestPostTimestamp,
                waveId: item.waveId
              })
          });
        }
        default:
          return assertUnreachable(request.activityType);
      }
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private buildPage<TItem extends ProfileWaveActivityDbItem>({
    candidates,
    limit,
    encodeCursor
  }: {
    readonly candidates: TItem[];
    readonly limit: number;
    readonly encodeCursor: (item: TItem) => string;
  }): ApiProfileWaveActivityPage {
    const pageItems = candidates.slice(0, limit);
    const cursorItem = candidates.length > limit ? pageItems.at(-1) : undefined;
    return {
      data: pageItems.map((item) => this.mapItem(item)),
      next_cursor: cursorItem ? encodeCursor(cursorItem) : null
    };
  }

  private mapItem(item: ProfileWaveActivityDbItem): ApiProfileWaveActivity {
    return {
      wave_id: item.waveId,
      wave_name: item.waveName,
      wave_picture: item.wavePicture,
      is_private: item.isPrivate,
      total_drops_count: item.totalDropsCount,
      latest_post_timestamp: item.latestPostTimestamp
    };
  }
}

export const profileWaveActivityApiService = new ProfileWaveActivityApiService(
  identityFetcher,
  userGroupsService,
  wavesApiDb,
  profileWaveActivityCursorCodec
);
