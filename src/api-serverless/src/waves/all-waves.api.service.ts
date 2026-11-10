import { ApiAllWavesPage } from '@/api/generated/models/ApiAllWavesPage';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import {
  getWaveReadContextProfileId,
  getGroupsUserIsEligibleForReadContext
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { BadRequestException } from '@/exceptions';
import { WaveEntity } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import {
  decodeJoinedWaveCursor,
  encodeJoinedWaveCursor,
  JoinedWaveSnapshot,
  JoinedWaveSnapshotStore
} from './joined-wave-snapshot';

export interface AllWavesQuery {
  readonly page_size: number;
  readonly cursor?: string;
}

export class AllWavesApiService {
  constructor(
    private readonly wavesDb: WavesApiDb,
    private readonly groups: UserGroupsService,
    private readonly mapper: ApiWaveOverviewMapper,
    private readonly snapshots: JoinedWaveSnapshotStore
  ) {}

  public async findPage(
    query: AllWavesQuery,
    ctx: RequestContext
  ): Promise<ApiAllWavesPage> {
    const profileId = getWaveReadContextProfileId(ctx.authenticationContext);
    const viewerKey = profileId ?? 'guest';
    const eligibleGroups = await getGroupsUserIsEligibleForReadContext(
      this.groups,
      ctx
    );
    const cursor = query.cursor ? decodeJoinedWaveCursor(query.cursor) : null;
    if (cursor && cursor.pageSize !== query.page_size) {
      throw new BadRequestException(
        'Page size cannot change within an all wave snapshot'
      );
    }
    const snapshot = cursor
      ? await this.snapshots.read(viewerKey, cursor)
      : await this.snapshots.create(
          viewerKey,
          await this.wavesDb.findAllRootWaveIds(
            { identityId: profileId, eligibleGroups },
            ctx
          ),
          query.page_size
        );
    const { waves, offset } = await this.readVisiblePage(
      snapshot,
      cursor?.offset ?? 0,
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
      const entities = await this.wavesDb.findWavesByIdsEligibleForRead(
        waveIds,
        eligibleGroups,
        ctx.connection
      );
      const byId = new Map(entities.map((wave) => [wave.id, wave]));
      for (const waveId of waveIds) {
        offset += 1;
        const wave = byId.get(waveId);
        if (wave && !wave.is_direct_message && wave.parent_wave_id === null) {
          waves.push(wave);
        }
        if (waves.length === snapshot.pageSize) break;
      }
    }
    return { waves, offset };
  }
}

export const allWavesApiService = new AllWavesApiService(
  wavesApiDb,
  userGroupsService,
  apiWaveOverviewMapper,
  new JoinedWaveSnapshotStore('all')
);
