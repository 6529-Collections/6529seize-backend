import {
  CompetitionEntryStatus,
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';
import { WaveEntity, WaveType } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import {
  Competition,
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
  CompetitionSnapshot,
  CompetitionVoter
} from '@/competitions/competition.types';
import { CompetitionRepository } from '@/competitions/competition.repository';
import { computeCompetitionPhase } from '@/competitions/competition-phase';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { collectCompetitionPages } from '@/competitions/competition-page';

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function competitionType(waveType: WaveType): CompetitionType {
  if (waveType === WaveType.RANK) return CompetitionType.RANK;
  if (waveType === WaveType.APPROVE) return CompetitionType.APPROVE;
  throw new Error(`Chat wave does not have a legacy competition`);
}

function lifecycle(wave: WaveEntity, now: number): CompetitionLifecycle {
  const relevantEnds = [
    nullableNumber(wave.participation_period_end),
    nullableNumber(wave.voting_period_end)
  ].filter((value): value is number => value !== null);
  return relevantEnds.length > 0 &&
    relevantEnds.every((value) => value <= now) &&
    wave.next_decision_time === null
    ? CompetitionLifecycle.ENDED
    : CompetitionLifecycle.PUBLISHED;
}

export class LegacyCompetitionAdapter implements CompetitionReader {
  public constructor(
    private readonly repository: CompetitionRepository,
    private readonly wavesApiDb: WavesApiDb,
    private readonly ctx: RequestContext
  ) {}

  public async getCompetition(
    record: CompetitionRoutingRecord,
    now: number
  ): Promise<Competition> {
    if (record.storage_mode !== CompetitionStorageMode.LEGACY_ADAPTER) {
      throw new Error(`${record.id} is not a legacy competition`);
    }
    const wave = await this.wavesApiDb.findWaveById(
      record.wave_id,
      this.ctx.connection
    );
    if (!wave || wave.type === WaveType.CHAT) {
      throw new Error(`Legacy competition wave ${record.wave_id} not found`);
    }
    const [creditNfts, capabilities, outcomes] = await Promise.all([
      this.repository.getLegacyCreditNfts(record.wave_id, this.ctx),
      this.repository.findCapabilities(record.id, this.ctx),
      collectCompetitionPages((page) =>
        this.repository.listLegacyOutcomes(record, page, this.ctx)
      )
    ]);
    const competition = this.mapWave(
      record,
      wave,
      creditNfts,
      capabilities,
      outcomes,
      now
    );
    return {
      ...competition,
      computed_phase: computeCompetitionPhase(competition, now)
    };
  }

  public listEntries(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    status?: readonly CompetitionEntryStatus[],
    submitterId?: string
  ): Promise<CompetitionPage<CompetitionEntry>> {
    if (
      status?.length === 0 ||
      status?.every(
        (item) =>
          item !== CompetitionEntryStatus.ACTIVE &&
          item !== CompetitionEntryStatus.WINNER
      )
    ) {
      return Promise.resolve({ data: [], next_cursor: null, has_more: false });
    }
    return this.repository.listLegacyEntries(
      record,
      request,
      this.ctx,
      status,
      submitterId
    );
  }

  public getEntry(
    record: CompetitionRoutingRecord,
    entryId: string
  ): Promise<CompetitionEntry | null> {
    return this.repository.findLegacyEntry(record, entryId, this.ctx);
  }

  public listLeaderboard(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionLeaderboardEntry>> {
    return this.repository.listLegacyLeaderboard(record, request, this.ctx);
  }

  public listVoters(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    entryId?: string
  ): Promise<CompetitionPage<CompetitionVoter>> {
    return this.repository.listLegacyVoters(record, request, this.ctx, entryId);
  }

  public listEntryVotes(
    record: CompetitionRoutingRecord,
    entryId: string,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionEntryVote>> {
    return this.repository.listLegacyEntryVotes(
      record,
      entryId,
      request,
      this.ctx
    );
  }

  public listDecisions(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionDecision>> {
    return this.repository.listLegacyDecisions(record, request, this.ctx);
  }

  public listWinners(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionEntry>> {
    return this.listEntries(record, request, [CompetitionEntryStatus.WINNER]);
  }

  public listOutcomes(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionOutcome>> {
    return this.repository.listLegacyOutcomes(record, request, this.ctx);
  }

  public listDistribution(
    record: CompetitionRoutingRecord,
    outcomeId: string,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionDistributionItem>> {
    return this.repository.listLegacyDistribution(
      record,
      outcomeId,
      request,
      this.ctx
    );
  }

  public listPauses(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionPause>> {
    return this.repository.listLegacyPauses(record, request, this.ctx);
  }

  public async getSnapshot(
    record: CompetitionRoutingRecord
  ): Promise<CompetitionSnapshot> {
    const [
      competition,
      entries,
      voters,
      leaderboard,
      decisions,
      outcomes,
      pauses
    ] = await Promise.all([
      this.getCompetition(record, Date.now()),
      collectCompetitionPages((page) => this.listEntries(record, page)),
      collectCompetitionPages((page) => this.listVoters(record, page)),
      collectCompetitionPages((page) => this.listLeaderboard(record, page)),
      collectCompetitionPages((page) => this.listDecisions(record, page)),
      collectCompetitionPages((page) => this.listOutcomes(record, page)),
      collectCompetitionPages((page) => this.listPauses(record, page))
    ]);
    const distributions = await Promise.all(
      outcomes.map((outcome) =>
        collectCompetitionPages((page) =>
          this.listDistribution(record, outcome.id, page)
        )
      )
    );
    return {
      storage_mode: competition.storage_mode,
      config_version: competition.config_version,
      configuration: competition,
      entries,
      votes_and_credits: voters,
      leaderboard,
      decisions_and_winners: decisions,
      outcomes_and_distributions: outcomes.map((outcome, index) => ({
        outcome,
        distribution: distributions[index] ?? []
      })),
      pauses,
      capabilities: competition.capabilities
    };
  }

  private mapWave(
    record: CompetitionRoutingRecord,
    wave: WaveEntity,
    creditNfts: readonly unknown[],
    capabilities: Competition['capabilities'],
    outcomes: readonly CompetitionOutcome[],
    now: number
  ): Omit<Competition, 'computed_phase'> {
    const participation = {
      group_id: wave.participation_group_id,
      signature_required: Boolean(wave.participation_signature_required),
      max_entries_per_participant: nullableNumber(
        wave.participation_max_applications_per_participant
      ),
      required_metadata: parseJson<readonly Record<string, unknown>[]>(
        wave.participation_required_metadata as unknown as readonly Record<
          string,
          unknown
        >[]
      ),
      required_media: parseJson<readonly string[]>(
        wave.participation_required_media
      ),
      submission_type: wave.submission_type,
      identity_submission_strategy: wave.identity_submission_strategy,
      identity_submission_duplicates: wave.identity_submission_duplicates,
      starts_at: nullableNumber(wave.participation_period_start),
      ends_at: nullableNumber(wave.participation_period_end),
      terms: wave.participation_terms
    };
    const voting = {
      group_id: wave.voting_group_id,
      credit_type: wave.voting_credit_type,
      credit_scope: wave.voting_credit_scope,
      credit_category: wave.voting_credit_category,
      credit_creditor: wave.voting_credit_creditor,
      credit_nfts: creditNfts as readonly Record<string, unknown>[],
      signature_required: Boolean(wave.voting_signature_required),
      starts_at: nullableNumber(wave.voting_period_start),
      ends_at: nullableNumber(wave.voting_period_end),
      max_votes_per_identity_to_entry: nullableNumber(
        wave.max_votes_per_identity_to_drop
      ),
      forbid_negative_votes: Boolean(wave.forbid_negative_votes)
    };
    const decisions = {
      strategy:
        wave.decisions_strategy === null
          ? null
          : (parseJson(wave.decisions_strategy) as unknown as Record<
              string,
              unknown
            >),
      next_decision_time: nullableNumber(wave.next_decision_time),
      winning_min_threshold: nullableNumber(wave.winning_min_threshold),
      winning_max_threshold: nullableNumber(wave.winning_max_threshold),
      winning_threshold_min_duration_ms: Number(
        wave.winning_threshold_min_duration_ms
      ),
      max_winners: nullableNumber(wave.max_winners),
      time_lock_ms: nullableNumber(wave.time_lock_ms)
    };
    const resolvedLifecycle = lifecycle(wave, now);
    return {
      id: record.id,
      wave_id: wave.id,
      storage_mode: record.storage_mode,
      execution_mode: record.execution_mode,
      type: competitionType(wave.type),
      lifecycle: resolvedLifecycle,
      title: wave.name,
      description: null,
      config_version: Number(record.config_version ?? 1),
      participation,
      voting,
      decisions,
      winners: {
        max_winners: decisions.max_winners,
        winning_min_threshold: decisions.winning_min_threshold,
        winning_max_threshold: decisions.winning_max_threshold,
        winning_threshold_min_duration_ms:
          decisions.winning_threshold_min_duration_ms
      },
      outcome_config: outcomes,
      capabilities,
      created_at: Number(wave.created_at),
      updated_at: nullableNumber(wave.updated_at) ?? Number(wave.created_at),
      published_at: Number(wave.created_at),
      ended_at:
        resolvedLifecycle === CompetitionLifecycle.ENDED
          ? Math.max(
              nullableNumber(wave.participation_period_end) ?? 0,
              nullableNumber(wave.voting_period_end) ?? 0
            ) || null
          : null,
      cancelled_at: null,
      archived_at: null
    };
  }
}
