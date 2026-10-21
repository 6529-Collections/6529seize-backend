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
import { WaveEntity } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import {
  decodeJoinedWaveCursor,
  encodeJoinedWaveCursor,
  joinedWaveSnapshotStore,
  JoinedWaveSnapshot,
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
    const { waves, offset } = await this.readVisiblePage(
      snapshot,
      cursor?.offset ?? 0,
      profileId,
      eligibleGroups,
      ctx
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

  private async readVisiblePage(
    snapshot: JoinedWaveSnapshot,
    start: number,
    profileId: string,
    eligibleGroups: string[],
    ctx: RequestContext
  ): Promise<{ waves: WaveEntity[]; offset: number }> {
    const waves: WaveEntity[] = [];
    let offset = start;
    // Pruned snapshots must not turn one page into hundreds of DB round-trips.
    const scanEnd = Math.min(snapshot.waveIds.length, start + 500);
    while (offset < scanEnd && waves.length < snapshot.pageSize) {
      const waveIds = snapshot.waveIds.slice(
        offset,
        Math.min(scanEnd, offset + Math.max(50, snapshot.pageSize))
      );
      const joinedIds = await this.wavesDb.findJoinedRootWaveIds(
        { identityId: profileId, eligibleGroups, waveIds },
        ctx
      );
      const entities = await this.wavesDb.findWavesByIdsEligibleForRead(
        joinedIds,
        eligibleGroups,
        ctx.connection
      );
      const byId = new Map(entities.map((wave) => [wave.id, wave]));
      for (const waveId of waveIds) {
        offset += 1;
        const wave = byId.get(waveId);
        if (wave) waves.push(wave);
        if (waves.length === snapshot.pageSize) break;
      }
    }
    return { waves, offset };
  }
}

export const joinedWavesApiService = new JoinedWavesApiService(
  wavesApiDb,
  userGroupsService,
  apiWaveOverviewMapper,
  joinedWaveSnapshotStore
);
