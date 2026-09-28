import { metricsRecorder } from '@/metrics/MetricsRecorder';
import { ApiSetCompetitionVoteRequest } from '@/api/generated/models/ApiSetCompetitionVoteRequest';
import {
  competitionCommandRepository,
  competitionConflict
} from '@/competitions/competition-command.repository';
import {
  competitionCreditService,
  CompetitionCreditBudget
} from '@/competitions/competition-credit.service';
import { competitionInteractionRepository } from '@/competitions/competition-interaction.repository';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionService } from '@/competitions/competition.service';
import { Competition } from '@/competitions/competition.types';
import { LegacyCompetitionAdapter } from '@/competitions/legacy-competition.adapter';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import {
  CompetitionEntryStatus,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import {
  assertCompetitionGroup,
  assertCompetitionOpen,
  competitionActor,
  lockNativeCompetition,
  requireNativeWrites,
  visibleCompetitionWave
} from './competition-command-access';
import { verifyCompetitionSignature } from './competition-signature';

export class CompetitionVotingService {
  public async budget(
    waveId: string,
    competitionId: string,
    entryId: string | undefined,
    ctx: RequestContext
  ): Promise<CompetitionCreditBudget> {
    if (!ctx.connection) {
      return sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          this.budget(waveId, competitionId, entryId, { ...ctx, connection }),
        { isolationLevel: 'REPEATABLE READ' }
      );
    }
    const actor = competitionActor(ctx);
    await competitionService.getCompetition(waveId, competitionId, ctx);
    const competition = await this.domainCompetition(competitionId, ctx);
    const entry = entryId
      ? await competitionService.getEntry(waveId, competitionId, entryId, ctx)
      : undefined;
    return competitionCreditService.getBudget(competition, actor, entry, ctx);
  }

  public async vote(
    waveId: string,
    competitionId: string,
    entryId: string,
    request: ApiSetCompetitionVoteRequest,
    ctx: RequestContext
  ) {
    requireNativeWrites();
    await visibleCompetitionWave(waveId, ctx);
    const actor = competitionActor(ctx);
    return competitionCommandRepository.command(
      actor,
      request.idempotency_key,
      { waveId, competitionId, entryId, action: 'vote', request },
      async (tx) => {
        const { competition } = await lockNativeCompetition(
          waveId,
          competitionId,
          request.config_version,
          tx
        );
        const { groups } = await visibleCompetitionWave(waveId, tx);
        assertCompetitionGroup(
          competition.voting.group_id,
          groups,
          ProfileProxyActionType.RATE_WAVE_DROP,
          tx
        );
        const now = Date.now();
        assertCompetitionOpen(competition, now, 'vote');
        const entry = await competitionRepository.findNativeEntry(
          competitionId,
          entryId,
          tx
        );
        if (!entry) throw new NotFoundException('Competition entry not found');
        if (entry.status !== CompetitionEntryStatus.ACTIVE)
          competitionConflict('Only active entries accept votes');
        await verifyCompetitionSignature(
          {
            action: 'VOTE_SET',
            wave_id: waveId,
            competition_id: competitionId,
            competition_entry_id: entryId,
            drop_id: entry.drop_id,
            config_version: request.config_version,
            payload: { value: request.value }
          },
          request.signature,
          competition.voting.signature_required,
          now,
          tx
        );
        const initial = await competitionCreditService.getBudget(
          competition,
          actor,
          entry,
          tx
        );
        await nativeCompetitionRuntimeService.reconcileVoterCredit(
          {
            competitionId,
            voterProfileId: actor,
            availableCredit: initial.available,
            creditScope: competition.voting.credit_scope,
            occurredAt: now
          },
          tx
        );
        const budget = await competitionCreditService.getBudget(
          competition,
          actor,
          entry,
          tx
        );
        competitionCreditService.assertVoteFits(budget, request.value);
        await competitionInteractionRepository.setVote(
          competitionId,
          entryId,
          actor,
          request.value,
          now,
          tx
        );
        await nativeCompetitionRuntimeRepository.recordVoteChange(
          {
            competitionId,
            entryId,
            voterProfileId: actor,
            previousVote: budget.current_vote ?? 0,
            value: request.value,
            occurredAt: now
          },
          tx
        );
        if (request.value !== (budget.current_vote ?? 0)) {
          await metricsRecorder.recordNativeCompetitionVote(
            {
              competitionId,
              voterId: actor,
              voteChange: request.value - (budget.current_vote ?? 0)
            },
            tx
          );
        }
        await nativeCompetitionRuntimeService.refreshCompetition(
          competitionId,
          now,
          tx
        );
        return competitionCreditService.getBudget(
          competition,
          actor,
          entry,
          tx
        );
      },
      ctx
    );
  }

  private async domainCompetition(
    competitionId: string,
    ctx: RequestContext
  ): Promise<Competition> {
    const record = await competitionRepository.findCompetitionRecordById(
      competitionId,
      ctx
    );
    if (!record) throw new NotFoundException('Competition not found');
    const reader =
      record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER
        ? new LegacyCompetitionAdapter(competitionRepository, wavesApiDb, ctx)
        : new NativeCompetitionReader(competitionRepository, ctx);
    return reader.getCompetition(record, Date.now());
  }
}

export const competitionVotingService = new CompetitionVotingService();
