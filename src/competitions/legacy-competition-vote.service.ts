import {
  CompetitionRecord,
  competitionRepository
} from '@/competitions/competition.repository';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import {
  competitionCreditService,
  competitionVoteDelta
} from '@/competitions/competition-credit.service';
import { competitionInteractionRepository } from '@/competitions/competition-interaction.repository';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { competitionDropVotesDb } from '@/competitions/competition-drop-votes.db';
import { isCompetitionDecisionPending } from '@/competitions/competition-decision-gate';
import { legacyCompetitionEntryId } from '@/competitions/competition-id';
import { VoteForDropModel } from '@/drops/vote-for-drop.model';
import { RequestContext } from '@/request.context';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { userNotifier } from '@/notifications/user.notifier';
import { metricsRecorder } from '@/metrics/MetricsRecorder';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { appFeatures } from '@/app-features';

/** Replacement values are inherently replayable: a retry with the same value
 * changes neither spend nor history nor notifications. The caller holds the
 * immutable primary ownership row; this command never opens a second transaction. */
export async function voteForMigratedLegacyEntry(
  record: CompetitionRecord,
  model: VoteForDropModel,
  ctx: RequestContext
): Promise<boolean> {
  if (
    !ctx.connection ||
    record.legacy_wave_id !== model.wave_id ||
    record.storage_mode !== 'NATIVE'
  )
    throw new Error('Native legacy voting requires its primary ownership lock');
  const now = Date.now();
  const competition = await new NativeCompetitionReader(
    competitionRepository,
    ctx
  ).getCompetition(record, now);
  if (
    !appFeatures.isNativeCompetitionExecutionEnabled() ||
    !appFeatures.isNativeCompetitionWritesEnabled() ||
    competition.execution_mode !== 'ACTIVE'
  )
    throw new ForbiddenException(
      'Voting is temporarily unavailable. Try again later'
    );
  // This legacy request has no competition-bound signature envelope.
  if (competition.voting.signature_required)
    throw new ForbiddenException(
      'This competition requires a signed vote; use the competition voting endpoint'
    );
  if (isCompetitionDecisionPending(competition, now))
    throw new ForbiddenException(
      "Wave has unresolved decisions and votes can't be edited at the moment. Try again later"
    );
  if (
    competition.voting.starts_at !== null &&
    now < competition.voting.starts_at
  )
    throw new BadRequestException("Voting period for this drop hasn't started");
  if (
    competition.lifecycle !== 'PUBLISHED' ||
    (competition.voting.ends_at !== null && now > competition.voting.ends_at)
  )
    throw new BadRequestException('Voting period for this drop has ended');
  const entry = await competitionRepository.findNativeEntry(
    record.id,
    legacyCompetitionEntryId(record.id, model.drop_id),
    ctx
  );
  if (!entry) throw new BadRequestException('Drop not found');
  if (entry.status !== 'ACTIVE')
    throw new BadRequestException("You can't vote on this drop");
  const group = competition.voting.group_id;
  if (
    group !== null &&
    !(
      await userGroupsService.getGroupsUserIsEligibleFor(
        model.voter_id,
        ctx.timer
      )
    ).includes(group)
  )
    throw new ForbiddenException('Voter is not eligible to vote in this wave');
  const budget = await competitionCreditService.getBudget(
    competition,
    model.voter_id,
    entry,
    ctx
  );
  competitionCreditService.assertVoteFits(budget, model.votes);
  const previous = budget.current_vote!;
  if (previous === model.votes) return false;
  await competitionInteractionRepository.setVote(
    record.id,
    entry.id,
    model.voter_id,
    model.votes,
    now,
    ctx
  );
  await nativeCompetitionRuntimeRepository.recordVoteChange(
    {
      competitionId: record.id,
      entryId: entry.id,
      voterProfileId: model.voter_id,
      previousVote: previous,
      value: model.votes,
      occurredAt: now
    },
    ctx
  );
  await metricsRecorder.recordNativeCompetitionVote(
    {
      competitionId: record.id,
      voterId: model.voter_id,
      voteChange: competitionVoteDelta(previous, model.votes)
    },
    ctx
  );
  await profileActivityLogsDb.insert(
    {
      profile_id: model.voter_id,
      type: ProfileActivityLogType.DROP_VOTE_EDIT,
      target_id: model.drop_id,
      contents: JSON.stringify({ oldVote: previous, newVote: model.votes }),
      additional_data_1: entry.submitter_id,
      additional_data_2: model.wave_id,
      proxy_id: model.proxy_id
    },
    ctx.connection,
    ctx.timer
  );
  if (entry.submitter_id !== model.voter_id) {
    const totals = await competitionDropVotesDb.totals(entry, null, ctx);
    const wave = await wavesApiDb.findById(model.wave_id, ctx.connection);
    if (!wave) throw new BadRequestException('Wave not found');
    await userNotifier.notifyOfDropVote(
      {
        voter_id: model.voter_id,
        drop_id: model.drop_id,
        drop_author_id: entry.submitter_id,
        vote: model.votes,
        vote_change: model.votes - previous,
        total_vote: totals.total,
        wave_id: model.wave_id
      },
      wave.visibility_group_id,
      ctx.connection
    );
  }
  await nativeCompetitionRuntimeService.refreshCompetition(record.id, now, ctx);
  return true;
}
