import { readWaveSnapshotPage } from '@/api/waves/wave-snapshot-page';
import { ApiJoinedWavesPage } from '@/api/generated/models/ApiJoinedWavesPage';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import {
  getAuthenticatedNonProxyProfileIdOrThrow,
  getGroupsUserIsEligibleForReadContext
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { BadRequestException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import {
  decodeJoinedWaveCursor,
  encodeJoinedWaveCursor,
  joinedWaveSnapshotStore,
  JoinedWaveSnapshotStore
} from './joined-wave-snapshot';

export interface JoinedWavesQuery {
  readonly page_size: number;
  readonly cursor?: string;
}

export class JoinedWavesApiService {
  constructor(
    private readonly wavesDb: WavesApiDb,
    private readonly groups: UserGroupsService,
    private readonly mapper: ApiWaveOverviewMapper,
    private readonly snapshots: JoinedWaveSnapshotStore
  ) {}

  public async findPage(
    query: JoinedWavesQuery,
    ctx: RequestContext
  ): Promise<ApiJoinedWavesPage> {
    const profileId = getAuthenticatedNonProxyProfileIdOrThrow(
      ctx,
      'Joined waves are unavailable while acting as a proxy'
    );
    const eligibleGroups = await getGroupsUserIsEligibleForReadContext(
      this.groups,
      ctx
    );
    const cursor = query.cursor ? decodeJoinedWaveCursor(query.cursor) : null;
    if (cursor && cursor.pageSize !== query.page_size) {
      throw new BadRequestException(
        'Page size cannot change within a joined wave snapshot'
      );
    }
    const snapshot = cursor
      ? await this.snapshots.read(profileId, cursor)
      : await this.snapshots.create(
          profileId,
          await this.wavesDb.findJoinedRootWaveIds(
            { identityId: profileId, eligibleGroups },
            ctx
          ),
          query.page_size
        );
    const { waves, offset } = await readWaveSnapshotPage(
      snapshot,
      cursor?.offset ?? 0,
      async (waveIds) => {
        const ids = await this.wavesDb.findJoinedRootWaveIds(
          { identityId: profileId, eligibleGroups, waveIds },
          ctx
        );
        return await this.wavesDb.findWavesByIdsEligibleForRead(
          ids,
          eligibleGroups,
          ctx.connection
        );
      }
    );
    const mapped = await this.mapper.mapWaves(waves, ctx, {
      groupIdsUserIsEligibleFor: eligibleGroups
    });
    return {
      data: waves.map((wave) => mapped[wave.id]),
      next_cursor:
        offset < snapshot.waveIds.length
          ? encodeJoinedWaveCursor(snapshot, offset)
          : null,
      snapshot_expires_at: snapshot.expiresAt
    };
  }
}

export const joinedWavesApiService = new JoinedWavesApiService(
  wavesApiDb,
  userGroupsService,
  apiWaveOverviewMapper,
  joinedWaveSnapshotStore
);
