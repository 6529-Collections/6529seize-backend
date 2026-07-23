import { appFeatures, AppFeatures } from '@/app-features';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import {
  CompetitionEntryStatus,
  CompetitionLifecycle,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import {
  getGroupsUserIsEligibleForReadContext,
  assertWaveAndParentVisibleOrThrow,
  getWaveReadContextProfileId
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  competitionRepository,
  CompetitionRecord,
  CompetitionRepository
} from '@/competitions/competition.repository';
import {
  competitionCursorCodec,
  CompetitionCursorCodec
} from '@/competitions/competition-cursor';
import { LegacyCompetitionAdapter } from '@/competitions/legacy-competition.adapter';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import {
  competitionShadowComparator,
  CompetitionShadowComparator
} from '@/competitions/competition-shadow-comparator';
import type {
  Competition,
  CompetitionConfigVersion,
  CompetitionDecision,
  CompetitionDistributionItem,
  CompetitionEntry,
  CompetitionEntryVote,
  CompetitionLeaderboardEntry,
  CompetitionOutcome,
  CompetitionPage,
  CompetitionPageRequest,
  CompetitionPause,
  CompetitionReader,
  CompetitionRoutingRecord,
  CompetitionVoter
} from '@/competitions/competition.types';
import { WaveEntity } from '@/entities/IWave';
import { collectCompetitionPages } from '@/competitions/competition-page';

export type CompetitionPermissions = {
  readonly view: true;
  readonly submit: boolean;
  readonly vote: boolean;
  readonly administer: boolean;
};

export type PublicCompetition = Omit<
  Competition,
  'storage_mode' | 'execution_mode'
> & {
  readonly permissions: CompetitionPermissions;
};

export type WaveHub = {
  readonly id: string;
  readonly name: string;
  readonly picture: string | null;
  readonly created_at: number;
  readonly capabilities: {
    readonly chat: boolean;
    readonly competitions: true;
  };
  readonly permissions: {
    readonly view: true;
    readonly chat: boolean;
    readonly administer: boolean;
  };
};

export type CursorPageRequest<
  TSort extends string = 'submitted_at' | 'rating' | 'rank'
> = {
  readonly cursor?: string;
  readonly limit: number;
  readonly direction: 'ASC' | 'DESC';
  readonly sort?: TSort;
};

export type CompetitionListRequest = CursorPageRequest<
  'created_at' | 'starts_at' | 'updated_at'
> & {
  readonly lifecycle?: readonly CompetitionLifecycle[];
  readonly phase?: readonly Competition['computed_phase'][];
  readonly sort: 'created_at' | 'starts_at' | 'updated_at';
};

type ResolvedCompetition = {
  readonly wave: WaveEntity;
  readonly eligibleGroups: string[];
  readonly record: CompetitionRecord;
  readonly reader: CompetitionReader;
};

export class CompetitionService {
  public constructor(
    private readonly repository: CompetitionRepository,
    private readonly wavesDb: WavesApiDb,
    private readonly groupsService: UserGroupsService,
    private readonly features: AppFeatures,
    private readonly cursorCodec: CompetitionCursorCodec,
    private readonly shadowComparator: CompetitionShadowComparator = competitionShadowComparator
  ) {}

  public async getHub(waveId: string, ctx: RequestContext): Promise<WaveHub> {
    this.assertUnifiedReadsEnabled();
    const { wave, eligibleGroups } = await this.getVisibleWave(waveId, ctx);
    const administer = this.canAdminister(wave, eligibleGroups, ctx);
    return {
      id: wave.id,
      name: wave.name,
      picture: wave.picture,
      created_at: Number(wave.created_at),
      capabilities: {
        chat: Boolean(wave.chat_enabled),
        competitions: true
      },
      permissions: {
        view: true,
        chat:
          Boolean(wave.chat_enabled) &&
          this.hasGroupAccess(wave.chat_group_id, eligibleGroups),
        administer
      }
    };
  }

  public async listCompetitions(
    waveId: string,
    request: CompetitionListRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<PublicCompetition>> {
    this.assertUnifiedReadsEnabled();
    const { wave, eligibleGroups } = await this.getVisibleWave(waveId, ctx);
    const filters = {
      lifecycle: request.lifecycle ?? [],
      phase: request.phase ?? [],
      sort: request.sort,
      direction: request.direction
    };
    const offset = this.cursorCodec.decode(
      request.cursor,
      `wave:${waveId}:competitions`,
      filters
    );
    const records = await this.repository.listCompetitionRecordsForWave(
      waveId,
      ctx
    );
    const competitions = await Promise.all(
      records.map(async (record) => {
        const reader = this.createReader(record, ctx);
        return await reader.getCompetition(record, Time.currentMillis());
      })
    );
    const filtered = competitions.filter(
      (competition) =>
        (!request.lifecycle?.length ||
          request.lifecycle.includes(competition.lifecycle)) &&
        (!request.phase?.length ||
          request.phase.includes(competition.computed_phase))
    );
    const ordered = [...filtered].sort((left, right) => {
      const leftValue = this.competitionSortValue(left, request.sort);
      const rightValue = this.competitionSortValue(right, request.sort);
      const order = leftValue - rightValue || left.id.localeCompare(right.id);
      return request.direction === 'ASC' ? order : -order;
    });
    const data = ordered
      .slice(offset, offset + request.limit)
      .map((competition) =>
        this.toPublicCompetition(competition, wave, eligibleGroups, ctx)
      );
    const hasMore = offset + data.length < ordered.length;
    return {
      data,
      has_more: hasMore,
      next_cursor: hasMore
        ? this.cursorCodec.encode(
            `wave:${waveId}:competitions`,
            filters,
            offset + data.length
          )
        : null
    };
  }

  public async getCompetition(
    waveId: string,
    competitionId: string,
    ctx: RequestContext
  ): Promise<PublicCompetition> {
    const resolved = await this.resolve(waveId, competitionId, ctx);
    const competition = await resolved.reader.getCompetition(
      resolved.record,
      Time.currentMillis()
    );
    if (
      resolved.record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER
    ) {
      const legacyBaseline = new LegacyCompetitionAdapter(
        this.repository,
        this.wavesDb,
        ctx
      );
      await this.shadowComparator.compareIfSampled(
        resolved.record,
        () => legacyBaseline.getSnapshot(resolved.record),
        () => resolved.reader.getSnapshot(resolved.record),
        ctx
      );
    }
    return this.toPublicCompetition(
      competition,
      resolved.wave,
      resolved.eligibleGroups,
      ctx
    );
  }

  public async listVersions(
    waveId: string,
    competitionId: string,
    request: Omit<CursorPageRequest, 'direction'>,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionConfigVersion>> {
    return await this.readPage(
      waveId,
      competitionId,
      'versions',
      { ...request, direction: 'DESC' },
      {},
      ctx,
      (resolved, page) =>
        this.repository.listConfigVersions(resolved.record.id, page, ctx)
    );
  }

  public async listEntries(
    waveId: string,
    competitionId: string,
    request: CursorPageRequest,
    filters: {
      readonly status?: readonly CompetitionEntryStatus[];
      readonly submitterId?: string;
    },
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionEntry>> {
    return await this.readPage(
      waveId,
      competitionId,
      'entries',
      request,
      filters,
      ctx,
      (resolved, page) =>
        resolved.reader.listEntries(
          resolved.record,
          page,
          filters.status,
          filters.submitterId
        )
    );
  }

  public async getEntry(
    waveId: string,
    competitionId: string,
    entryId: string,
    ctx: RequestContext
  ): Promise<CompetitionEntry> {
    const resolved = await this.resolve(waveId, competitionId, ctx);
    const entry = await resolved.reader.getEntry(resolved.record, entryId);
    if (!entry) throw this.maskedNotFound(waveId, competitionId);
    return entry;
  }

  public async listLeaderboard(
    waveId: string,
    competitionId: string,
    request: CursorPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionLeaderboardEntry>> {
    return await this.readPage(
      waveId,
      competitionId,
      'leaderboard',
      request,
      {},
      ctx,
      (resolved, page) => resolved.reader.listLeaderboard(resolved.record, page)
    );
  }

  public async listVoters(
    waveId: string,
    competitionId: string,
    request: CursorPageRequest,
    entryId: string | undefined,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionVoter>> {
    if (entryId) await this.getEntry(waveId, competitionId, entryId, ctx);
    return await this.readPage(
      waveId,
      competitionId,
      'voters',
      request,
      { entryId: entryId ?? null },
      ctx,
      (resolved, page) =>
        resolved.reader.listVoters(resolved.record, page, entryId)
    );
  }

  public async listEntryVotes(
    waveId: string,
    competitionId: string,
    entryId: string,
    request: CursorPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionEntryVote>> {
    await this.getEntry(waveId, competitionId, entryId, ctx);
    return await this.readPage(
      waveId,
      competitionId,
      `entries:${entryId}:votes`,
      request,
      {},
      ctx,
      (resolved, page) =>
        resolved.reader.listEntryVotes(resolved.record, entryId, page)
    );
  }

  public async listDecisions(
    waveId: string,
    competitionId: string,
    request: CursorPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionDecision>> {
    return await this.readPage(
      waveId,
      competitionId,
      'decisions',
      request,
      {},
      ctx,
      (resolved, page) => resolved.reader.listDecisions(resolved.record, page)
    );
  }

  public async listWinners(
    waveId: string,
    competitionId: string,
    request: CursorPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionEntry>> {
    return await this.readPage(
      waveId,
      competitionId,
      'winners',
      request,
      {},
      ctx,
      (resolved, page) => resolved.reader.listWinners(resolved.record, page)
    );
  }

  public async listOutcomes(
    waveId: string,
    competitionId: string,
    request: CursorPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionOutcome>> {
    return await this.readPage(
      waveId,
      competitionId,
      'outcomes',
      request,
      {},
      ctx,
      (resolved, page) => resolved.reader.listOutcomes(resolved.record, page)
    );
  }

  public async listDistribution(
    waveId: string,
    competitionId: string,
    outcomeId: string,
    request: CursorPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionDistributionItem>> {
    const resolved = await this.resolve(waveId, competitionId, ctx);
    const outcomes = await collectCompetitionPages((page) =>
      resolved.reader.listOutcomes(resolved.record, page)
    );
    if (!outcomes.some((outcome) => outcome.id === outcomeId)) {
      throw this.maskedNotFound(waveId, competitionId);
    }
    return await this.readPage(
      waveId,
      competitionId,
      `outcomes:${outcomeId}:distribution`,
      request,
      {},
      ctx,
      (resolved, page) =>
        resolved.reader.listDistribution(resolved.record, outcomeId, page)
    );
  }

  public async listPauses(
    waveId: string,
    competitionId: string,
    request: CursorPageRequest,
    ctx: RequestContext
  ): Promise<CompetitionPage<CompetitionPause>> {
    return await this.readPage(
      waveId,
      competitionId,
      'pauses',
      request,
      {},
      ctx,
      (resolved, page) => resolved.reader.listPauses(resolved.record, page)
    );
  }

  private async readPage<T>(
    waveId: string,
    competitionId: string,
    resource: string,
    request: CursorPageRequest,
    filters: unknown,
    ctx: RequestContext,
    read: (
      resolved: ResolvedCompetition,
      page: CompetitionPageRequest
    ) => Promise<CompetitionPage<T>>
  ): Promise<CompetitionPage<T>> {
    const resolved = await this.resolve(waveId, competitionId, ctx);
    const fingerprint = {
      filters,
      direction: request.direction,
      sort: request.sort ?? null
    };
    const scope = `competition:${competitionId}:${resource}`;
    const offset = this.cursorCodec.decode(request.cursor, scope, fingerprint);
    const result = await read(resolved, {
      offset,
      limit: request.limit,
      direction: request.direction,
      sort: request.sort
    });
    return {
      ...result,
      next_cursor: result.has_more
        ? this.cursorCodec.encode(
            scope,
            fingerprint,
            offset + result.data.length
          )
        : null
    };
  }

  private async resolve(
    waveId: string,
    competitionId: string,
    ctx: RequestContext
  ): Promise<ResolvedCompetition> {
    this.assertUnifiedReadsEnabled();
    const { wave, eligibleGroups } = await this.getVisibleWave(waveId, ctx);
    const record = await this.repository.findCompetitionRecordById(
      competitionId,
      ctx
    );
    if (record?.wave_id !== waveId) {
      throw this.maskedNotFound(waveId, competitionId);
    }
    return {
      wave,
      eligibleGroups,
      record,
      reader: this.createReader(record, ctx)
    };
  }

  private createReader(
    record: CompetitionRoutingRecord,
    ctx: RequestContext
  ): CompetitionReader {
    if (record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER) {
      return new LegacyCompetitionAdapter(this.repository, this.wavesDb, ctx);
    }
    return new NativeCompetitionReader(this.repository, ctx);
  }

  private async getVisibleWave(
    waveId: string,
    ctx: RequestContext
  ): Promise<{ wave: WaveEntity; eligibleGroups: string[] }> {
    const eligibleGroups = await getGroupsUserIsEligibleForReadContext(
      this.groupsService,
      ctx
    );
    const wave = await assertWaveAndParentVisibleOrThrow({
      wave: await this.wavesDb.findWaveById(waveId, ctx.connection),
      groupsUserIsEligibleFor: eligibleGroups,
      message: `Wave ${waveId} not found`,
      wavesApiDb: this.wavesDb,
      ctx
    });
    return { wave, eligibleGroups };
  }

  private toPublicCompetition(
    competition: Competition,
    wave: WaveEntity,
    eligibleGroups: string[],
    ctx: RequestContext
  ): PublicCompetition {
    const {
      storage_mode: _storage,
      execution_mode: _execution,
      ...publicData
    } = competition;
    const authenticationContext = ctx.authenticationContext;
    const fullyAuthenticated =
      authenticationContext?.isUserFullyAuthenticated() === true;
    const writesAvailable =
      competition.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER ||
      this.features.isNativeCompetitionWritesEnabled();
    return {
      ...publicData,
      permissions: {
        view: true,
        submit:
          fullyAuthenticated &&
          writesAvailable &&
          this.hasGroupAccess(
            competition.participation.group_id,
            eligibleGroups
          ) &&
          !(
            authenticationContext?.isAuthenticatedAsProxy() &&
            !authenticationContext.hasProxyAction(
              ProfileProxyActionType.CREATE_DROP_TO_WAVE
            )
          ),
        vote:
          fullyAuthenticated &&
          writesAvailable &&
          this.hasGroupAccess(competition.voting.group_id, eligibleGroups) &&
          !(
            authenticationContext?.isAuthenticatedAsProxy() &&
            !authenticationContext.hasProxyAction(
              ProfileProxyActionType.RATE_WAVE_DROP
            )
          ),
        administer: this.canAdminister(wave, eligibleGroups, ctx)
      }
    };
  }

  private canAdminister(
    wave: WaveEntity,
    eligibleGroups: readonly string[],
    ctx: RequestContext
  ): boolean {
    const profileId = getWaveReadContextProfileId(ctx.authenticationContext);
    return Boolean(
      profileId &&
      (wave.created_by === profileId ||
        (wave.admin_group_id && eligibleGroups.includes(wave.admin_group_id)))
    );
  }

  private hasGroupAccess(
    groupId: string | null,
    eligibleGroups: readonly string[]
  ): boolean {
    return groupId === null || eligibleGroups.includes(groupId);
  }

  private competitionSortValue(
    competition: Competition,
    sort: CompetitionListRequest['sort']
  ): number {
    if (sort === 'updated_at') return competition.updated_at;
    if (sort === 'starts_at') {
      return (
        competition.participation.starts_at ??
        competition.voting.starts_at ??
        competition.created_at
      );
    }
    return competition.created_at;
  }

  private assertUnifiedReadsEnabled(): void {
    if (!this.features.isUnifiedCompetitionReadsEnabled()) {
      throw new NotFoundException('Competition reads are not enabled');
    }
  }

  private maskedNotFound(
    waveId: string,
    competitionId: string
  ): NotFoundException {
    return new NotFoundException(
      `Competition ${competitionId} for wave ${waveId} not found`
    );
  }
}

export const competitionService = new CompetitionService(
  competitionRepository,
  wavesApiDb,
  userGroupsService,
  appFeatures,
  competitionCursorCodec
);
