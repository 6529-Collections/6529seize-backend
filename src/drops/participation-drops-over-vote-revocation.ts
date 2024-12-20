import { ConnectionWrapper } from '../sql-executor';
import { dropsDb } from './drops.db';
import { Timer } from '../time';
import { RequestContext } from '../request.context';
import { userNotifier } from '../notifications/user.notifier';
import { profileActivityLogsDb } from '../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { Logger } from '../logging';

const logger = Logger.get('PARTICIPATION_DROPS_OVER_VOTE_REVOCATION');

export async function revokeRepBasedDropOverVotes(
  param: {
    rep_recipient_id: string;
    rep_giver_id: string;
    credit_category: string;
  },
  connection: ConnectionWrapper<any>
) {
  const ctx = {
    timer: new Timer('revokeRepBasedDropOverVotes'),
    connection
  };
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
    const { wave_id, credit_limit, total_given_votes } = overratedWave;
    await reduceVotesForDrops(
      {
        profile_id,
        wave_id,
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
  const overratedWaves =
    await dropsDb.findTdhBasedSubmissionDropOvervotersWithOvervoteAmounts(ctx);

  for (const overratedWave of overratedWaves) {
    const {
      profile_id,
      wave_id,
      tdh: credit_limit,
      total_given_votes
    } = overratedWave;
    await reduceVotesForDrops(
      {
        profile_id,
        wave_id,
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
    credit_limit,
    total_given_votes
  }: {
    profile_id: string;
    wave_id: string;
    credit_limit: number;
    total_given_votes: number;
  },
  ctx: RequestContext
) {
  const dropsForWaves = await dropsDb.findDropVotesForWaves(
    {
      profile_id,
      wave_id
    },
    ctx
  );
  const reductionCoefficient = credit_limit / total_given_votes;
  let votes_still_given = total_given_votes;
  for (const drop of dropsForWaves) {
    const { drop_id, votes, author_id, visibility_group_id } = drop;
    const voteAfterRevocation = Math.floor(votes * reductionCoefficient);
    votes_still_given -= Math.abs(votes - voteAfterRevocation);
    logger.info(
      `Revoking drop votes ${JSON.stringify({
        ...drop,
        reductionCoefficient,
        credit_limit,
        voteAfterRevocation,
        votes_still_given
      })}`
    );
    await Promise.all([
      dropsDb.updateDropVoterState(
        {
          profile_id,
          drop_id,
          votes: voteAfterRevocation
        },
        ctx
      ),
      dropsDb.updateDropRank(
        {
          profile_id,
          drop_id,
          change: votes - voteAfterRevocation
        },
        ctx
      ),
      userNotifier.notifyOfDropVote(
        {
          voter_id: profile_id,
          drop_id,
          vote: voteAfterRevocation,
          wave_id,
          drop_author_id: author_id
        },
        visibility_group_id,
        ctx.connection
      ),
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
          additional_data_1: null,
          additional_data_2: null,
          proxy_id: null
        },
        ctx.connection!,
        ctx.timer
      )
    ]);
    if (votes_still_given <= credit_limit) {
      break;
    }
  }
}
