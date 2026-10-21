import { withLegacyPrimaryMutation } from '@/competitions/legacy-competition-mutation';
import { ConnectionWrapper } from '../sql-executor';
import { dropsDb } from './drops.db';
import { Time, Timer } from '../time';
import { RequestContext } from '../request.context';
import { userNotifier } from '../notifications/user.notifier';
import { profileActivityLogsDb } from '../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { Logger } from '../logging';
import { dropVotingDb } from '../api-serverless/src/drops/drop-voting.db';
import { appFeatures } from '../app-features';
import { WaveCreditScope, WaveCreditType } from '../entities/IWave';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionDropVotesDb } from '@/competitions/competition-drop-votes.db';
import { competitionExecutionRouter } from '@/competitions/competition-execution.router';
import { Competition } from '@/competitions/competition.types';
import { wavesApiDb } from '@/api/waves/waves.api.db';

const logger = Logger.get('PARTICIPATION_DROPS_OVER_VOTE_REVOCATION');

export async function revokeRepBasedDropOverVotes(
  param: {
    rep_recipient_id: string;
    rep_giver_id: string;
    credit_category: string;
  },
  connection: ConnectionWrapper<any>
) {
  if (!appFeatures.isDropOvervoteRevocationEnabled()) {
    logger.warn(`Drop overvote revocation is disabled. Skipping.`);
    return;
  }
  const ctx = {
    timer: new Timer('revokeRepBasedDropOverVotes'),
    connection
  };
  await revokeNativeOvervotes(
    (competition) =>
      competition.voting.credit_type === WaveCreditType.REP &&
      (competition.voting.credit_category === null ||
        competition.voting.credit_category === param.credit_category) &&
      (competition.voting.credit_creditor === null ||
        competition.voting.credit_creditor === param.rep_giver_id),
    param.rep_recipient_id,
    ctx
  );
  const hasVoted = await dropsDb.hasProfileVotedInAnyOpenRepBasedWave(
    param.rep_recipient_id,
    ctx
  );
  if (!hasVoted) {
    return;
  }
  logger.info(
    `Revoking REP-based drops overvotes for voter ${param.rep_recipient_id}`
  );
  const category_giver_rep =
    await dropsDb.findCategoryRepAmountFromProfileForProfile(param, ctx);
  const overratedWaves = await dropsDb
    .findRepBasedSubmissionDropOvervotedWavesWithOvervoteAmounts(
      {
        voter_id: param.rep_recipient_id,
        creditor_id: param.rep_giver_id,
        credit_category: param.credit_category,
        credit_limit: category_giver_rep
      },
      ctx
    )
    .then((res) =>
      res.map((it) => ({ ...it, credit_limit: category_giver_rep }))
    );
  for (const overratedWave of overratedWaves) {
    const profile_id = param.rep_recipient_id;
    const { wave_id, drop_id, credit_limit, credit_scope, total_given_votes } =
      overratedWave;
    await reduceVotesForDrops(
      {
        profile_id,
        wave_id,
        drop_id: credit_scope === WaveCreditScope.DROP ? drop_id : null,
        credit_scope,
        credit_limit,
        total_given_votes
      },
      ctx
    );
  }

  logger.info(
    `Revoked REP-based drops overvotes for voter ${
      param.rep_recipient_id
    }. Times: ${ctx.timer.getReport()}`
  );
}

export async function revokeTdhBasedDropWavesOverVotes(
  connection: ConnectionWrapper<any>
) {
  logger.info(`Revoking TDH-based waves overvotes`);
  const timer = new Timer('revokeTdhBasedWavesOverVotes');
  const ctx: RequestContext = { timer, connection };
  await revokeNativeOvervotes(
    (competition) => competition.voting.credit_type !== WaveCreditType.REP,
    null,
    ctx
  );
  const overratedWaves =
    await dropsDb.findTdhBasedSubmissionDropOvervotersWithOvervoteAmounts(ctx);

  for (const overratedWave of overratedWaves) {
    const {
      profile_id,
      wave_id,
      drop_id,
      credit_scope,
      credit_limit,
      total_given_votes
    } = overratedWave;
    await reduceVotesForDrops(
      {
        profile_id,
        wave_id,
        drop_id: credit_scope === WaveCreditScope.DROP ? drop_id : null,
        credit_scope,
        credit_limit,
        total_given_votes
      },
      ctx
    );
  }
  logger.info(
    `Finished revoking. TDH-based waves overvotes. Times: ${timer.getReport()}`
  );
}

async function reduceVotesForDrops(
  {
    profile_id,
    wave_id,
    drop_id,
    credit_scope,
    credit_limit,
    total_given_votes
  }: {
    profile_id: string;
    wave_id: string;
    drop_id: string | null;
    credit_scope: WaveCreditScope;
    credit_limit: number;
    total_given_votes: number;
  },
  ctx: RequestContext
) {
  return withLegacyPrimaryMutation(wave_id, ctx, async (nativeOwner) => {
    // Native namespaces were reconciled from their own current votes above.
    // Stale physical discovery must never select their budget or notifications.
    if (
      nativeOwner ||
      !(await competitionExecutionRouter.shouldUseLegacyWaveExecution(
        wave_id,
        ctx
      ))
    )
      return;
    const dropsForWaves = await dropsDb.findDropVotesForWaves(
      {
        profile_id,
        wave_id,
        drop_id
      },
      ctx
    );
    const reductionCoefficient = credit_limit / total_given_votes;
    let votes_still_given = total_given_votes;
    for (const drop of dropsForWaves) {
      const { drop_id, votes, author_id, visibility_group_id } = drop;
      const now = Time.currentMillis();
      await dropVotingDb.lockDropsCurrentRealVote(drop_id, ctx);
      const voteAfterRevocation =
        credit_scope === WaveCreditScope.DROP
          ? limitVoteToCredit(votes, credit_limit)
          : Math.floor(votes * reductionCoefficient);
      const voteChange = voteAfterRevocation - votes;
      if (voteChange === 0) {
        logger.info(
          `Skipping drop vote revocation for unchanged vote ${JSON.stringify({
            ...drop,
            reductionCoefficient,
            credit_limit,
            voteAfterRevocation,
            votes_still_given
          })}`
        );
        continue;
      }
      votes_still_given -= Math.abs(voteChange);
      logger.info(
        `Revoking drop votes ${JSON.stringify({
          ...drop,
          reductionCoefficient,
          credit_limit,
          voteAfterRevocation,
          votes_still_given
        })}`
      );
      await dropVotingDb.getDropVoterStateForDrop(
        { voterId: profile_id, drop_id },
        ctx
      );
      await Promise.all([
        dropVotingDb.upsertState(
          {
            voter_id: profile_id,
            drop_id,
            votes: voteAfterRevocation,
            wave_id
          },
          ctx
        ),
        dropVotingDb.upsertAggregateDropRank(
          {
            drop_id,
            change: voteChange,
            wave_id: wave_id
          },
          ctx
        )
      ]);
      await Promise.all([
        notifyOfDropVoteRevocation({
          profile_id,
          drop_id,
          voteAfterRevocation,
          voteChange,
          wave_id,
          author_id,
          visibility_group_id,
          ctx
        }),
        profileActivityLogsDb.insert(
          {
            profile_id,
            type: ProfileActivityLogType.DROP_VOTE_EDIT,
            target_id: drop_id,
            contents: JSON.stringify({
              oldVote: votes,
              newVote: voteAfterRevocation,
              reason: 'CREDIT_OVERSPENT'
            }),
            additional_data_1: drop.author_id,
            additional_data_2: wave_id,
            proxy_id: null
          },
          ctx.connection!,
          ctx.timer
        )
      ]);
      await Promise.all([
        dropVotingDb.snapShotDropsRealVoteInTimeBasedOnRank(drop_id, now, ctx),
        dropVotingDb.snapshotDropVotersRealVoteInTimeBasedOnVoterState(
          {
            voterId: profile_id,
            dropId: drop_id,
            now
          },
          ctx
        )
      ]);
      await dropVotingDb.getDropVoterStateForDrop(
        { voterId: profile_id, drop_id },
        ctx
      );
      if (votes_still_given <= credit_limit) {
        break;
      }
    }
  });
}

function limitVoteToCredit(votes: number, creditLimit: number): number {
  const allowedCredit = Math.floor(Math.max(0, creditLimit));
  if (votes > allowedCredit) {
    return allowedCredit;
  }
  if (votes < -allowedCredit) {
    return -allowedCredit;
  }
  return votes;
}

async function notifyOfDropVoteRevocation({
  profile_id,
  drop_id,
  voteAfterRevocation,
  voteChange,
  wave_id,
  author_id,
  visibility_group_id,
  ctx
}: {
  profile_id: string;
  drop_id: string;
  voteAfterRevocation: number;
  voteChange: number;
  wave_id: string;
  author_id: string;
  visibility_group_id: string | null;
  ctx: RequestContext;
}) {
  if (profile_id === author_id) {
    return;
  }

  const totalDropRating = await dropVotingDb.getAggregateDropRankVote(
    drop_id,
    ctx
  );
  await userNotifier.notifyOfDropVote(
    {
      voter_id: profile_id,
      drop_id,
      vote: voteAfterRevocation,
      vote_change: voteChange,
      total_vote: totalDropRating,
      wave_id,
      drop_author_id: author_id
    },
    visibility_group_id,
    ctx.connection
  );
}

async function revokeNativeOvervotes(
  accepts: (competition: Competition) => boolean,
  profileId: string | null,
  ctx: RequestContext
): Promise<void> {
  let afterId = '';
  for (;;) {
    const ids = await nativeCompetitionRuntimeRepository.discoverCompetitions(
      afterId,
      100,
      ctx
    );
    if (!ids.length) return;
    for (const id of ids) {
      const competition =
        await nativeCompetitionRuntimeRepository.lockCompetition(id, ctx);
      if (
        !competition ||
        !accepts(competition) ||
        competition.execution_mode !== 'ACTIVE' ||
        competition.lifecycle !== 'PUBLISHED'
      )
        continue;
      const voters = profileId
        ? [profileId]
        : await nativeCompetitionRuntimeRepository.listActiveVoters(id, ctx);
      for (const voter of voters)
        await reconcileNativeVoter(competition, voter, ctx);
    }
    afterId = ids[ids.length - 1];
  }
}

async function reconcileNativeVoter(
  competition: Competition,
  profileId: string,
  ctx: RequestContext
): Promise<void> {
  const before = await nativeCompetitionRuntimeRepository.getVoterActiveVotes(
    competition.id,
    profileId,
    ctx
  );
  if (!before.length) return;
  const budget = await competitionCreditService.getBudget(
    competition,
    profileId,
    undefined,
    ctx
  );
  await nativeCompetitionRuntimeService.reconcileVoterCredit(
    {
      competitionId: competition.id,
      voterProfileId: profileId,
      availableCredit: budget.available,
      creditScope: competition.voting.credit_scope,
      occurredAt: Date.now()
    },
    ctx
  );
  const after = new Map(
    (
      await nativeCompetitionRuntimeRepository.getVoterActiveVotes(
        competition.id,
        profileId,
        ctx
      )
    ).map((vote) => [vote.entryId, vote.value])
  );
  for (const vote of before) {
    const value = after.get(vote.entryId) ?? 0;
    if (value === vote.value) continue;
    const entry = await competitionRepository.findNativeEntry(
      competition.id,
      vote.entryId,
      ctx
    );
    if (!entry || entry.submitter_id === profileId) continue;
    const wave = await wavesApiDb.findById(competition.wave_id, ctx.connection);
    if (!wave) continue;
    const total = await competitionDropVotesDb.totals(entry, null, ctx);
    await userNotifier.notifyOfDropVote(
      {
        voter_id: profileId,
        drop_id: entry.drop_id,
        wave_id: competition.wave_id,
        drop_author_id: entry.submitter_id,
        vote: value,
        vote_change: value - vote.value,
        total_vote: total.total
      },
      wave.visibility_group_id,
      ctx.connection
    );
  }
  await nativeCompetitionRuntimeService.refreshCompetition(
    competition.id,
    Date.now(),
    ctx
  );
  logger.info(
    `Reconciled competition ${competition.id} credit for ${profileId}`
  );
}
