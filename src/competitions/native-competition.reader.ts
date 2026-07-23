import {
  CompetitionEntryStatus,
  CompetitionStorageMode
} from '@/entities/ICompetition';
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
import {
  CompetitionRecord,
  CompetitionRepository
} from '@/competitions/competition.repository';
import { computeCompetitionPhase } from '@/competitions/competition-phase';
import { collectCompetitionPages } from '@/competitions/competition-page';

export class NativeCompetitionReader implements CompetitionReader {
  public constructor(
    private readonly repository: CompetitionRepository,
    private readonly ctx: RequestContext
  ) {}

  public async getCompetition(
    routingRecord: CompetitionRoutingRecord,
    now: number
  ): Promise<Competition> {
    const raw = await this.repository.findCompetitionRecordById(
      routingRecord.id,
      this.ctx
    );
    if (raw?.storage_mode !== CompetitionStorageMode.NATIVE) {
      throw new Error(`Native competition ${routingRecord.id} not found`);
    }
    const record = this.repository.parseCompetitionRecord(raw);
    const capabilities = await this.repository.findCapabilities(
      record.id,
      this.ctx
    );
    const competition = this.toCompetition(record, capabilities);
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
    if (status?.length === 0) {
      return Promise.resolve({ data: [], next_cursor: null, has_more: false });
    }
    return this.repository.listNativeEntries(
      record.id,
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
    return this.repository.findNativeEntry(record.id, entryId, this.ctx);
  }

  public listLeaderboard(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionLeaderboardEntry>> {
    return this.repository.listNativeLeaderboard(record.id, request, this.ctx);
  }

  public listVoters(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    entryId?: string
  ): Promise<CompetitionPage<CompetitionVoter>> {
    return this.repository.listNativeVoters(
      record.id,
      request,
      this.ctx,
      entryId
    );
  }

  public listEntryVotes(
    record: CompetitionRoutingRecord,
    entryId: string,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionEntryVote>> {
    return this.repository.listNativeEntryVotes(
      record.id,
      entryId,
      request,
      this.ctx
    );
  }

  public listDecisions(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionDecision>> {
    return this.repository.listNativeDecisions(record.id, request, this.ctx);
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
    return this.repository.listNativeOutcomes(record.id, request, this.ctx);
  }

  public listDistribution(
    record: CompetitionRoutingRecord,
    outcomeId: string,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionDistributionItem>> {
    return this.repository.listNativeDistribution(
      record.id,
      outcomeId,
      request,
      this.ctx
    );
  }

  public listPauses(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionPause>> {
    return this.repository.listNativePauses(record.id, request, this.ctx);
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

  private toCompetition(
    record: CompetitionRecord,
    capabilities: Competition['capabilities']
  ): Omit<Competition, 'computed_phase'> {
    const parsed = this.repository.parseCompetitionRecord(record);
    return {
      id: parsed.id,
      wave_id: parsed.wave_id,
      storage_mode: parsed.storage_mode,
      execution_mode: parsed.execution_mode,
      type: parsed.type,
      lifecycle: parsed.lifecycle,
      title: parsed.title,
      description: parsed.description,
      config_version: Number(parsed.config_version),
      participation:
        parsed.participation_config as Competition['participation'],
      voting: parsed.voting_config as Competition['voting'],
      decisions: parsed.decision_config as Competition['decisions'],
      winners: parsed.winner_config as Competition['winners'],
      outcome_config: parsed.outcome_config as Competition['outcome_config'],
      capabilities,
      created_at: Number(parsed.created_at),
      updated_at: Number(parsed.updated_at),
      published_at:
        parsed.published_at === null ? null : Number(parsed.published_at),
      ended_at: parsed.ended_at === null ? null : Number(parsed.ended_at),
      cancelled_at:
        parsed.cancelled_at === null ? null : Number(parsed.cancelled_at),
      archived_at:
        parsed.archived_at === null ? null : Number(parsed.archived_at)
    };
  }
}
