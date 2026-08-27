import type { ApiProfileWaveActivityPage } from '@/api/generated/models/ApiProfileWaveActivityPage';
import { ApiProfileWaveActivityType } from '@/api/generated/models/ApiProfileWaveActivityType';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
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
    private readonly apiWaveOverviewMapper: ApiWaveOverviewMapper,
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
      const candidates = await this.findCandidates(
        request,
        targetProfileId,
        eligibleGroups,
        ctx
      );
      const pageItems = candidates.slice(0, request.limit);
      const wavesById = await this.apiWaveOverviewMapper.mapWaves(
        pageItems.map((item) => item.wave),
        ctx,
        { groupIdsUserIsEligibleFor: eligibleGroups }
      );
      return {
        data: pageItems.map((item) => ({
          wave: wavesById[item.wave.id],
          latest_post_timestamp: item.latestPostTimestamp
        })),
        next_cursor:
          candidates.length > request.limit
            ? this.encodeNextCursor(
                request.activityType,
                targetProfileId,
                pageItems[pageItems.length - 1]
              )
            : null
      };
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private async findCandidates(
    request: GetProfileWaveActivityRequest,
    targetProfileId: string,
    eligibleGroups: string[],
    ctx: RequestContext
  ): Promise<ProfileWaveActivityDbItem[]> {
    switch (request.activityType) {
      case ApiProfileWaveActivityType.Created:
        return await this.wavesApiDb.findCreatedProfileWaveActivity(
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
      case ApiProfileWaveActivityType.Recent:
        return await this.wavesApiDb.findRecentProfileWaveActivity(
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
      default:
        return assertUnreachable(request.activityType);
    }
  }

  private encodeNextCursor(
    activityType: ApiProfileWaveActivityType,
    targetProfileId: string,
    item: ProfileWaveActivityDbItem | undefined
  ): string | null {
    if (!item) {
      return null;
    }
    switch (activityType) {
      case ApiProfileWaveActivityType.Created:
        return this.cursorCodec.encodeCreated(targetProfileId, {
          hasQualifyingPost: item.hasQualifyingPost ? 1 : 0,
          latestPostTimestamp: item.latestPostTimestamp ?? 0,
          waveSerialNo: Number(item.wave.serial_no),
          waveId: item.wave.id
        });
      case ApiProfileWaveActivityType.Recent:
        if (item.latestPostTimestamp === null) {
          throw new Error('Recent profile wave activity requires a timestamp');
        }
        return this.cursorCodec.encodeRecent(targetProfileId, {
          latestPostTimestamp: item.latestPostTimestamp,
          waveId: item.wave.id
        });
      default:
        return assertUnreachable(activityType);
    }
  }
}

export const profileWaveActivityApiService = new ProfileWaveActivityApiService(
  identityFetcher,
  userGroupsService,
  wavesApiDb,
  apiWaveOverviewMapper,
  profileWaveActivityCursorCodec
);
