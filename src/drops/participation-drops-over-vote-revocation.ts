import { dbSupplier } from '../sql-executor';
import { dropsDb } from './drops.db';
import { Timer } from '../time';
import { RequestContext } from '../request.context';
import { userNotifier } from '../notifications/user.notifier';
import { profileActivityLogsDb } from '../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { Logger } from '../logging';

const logger = Logger.get('PARTICIPATION_DROPS_OVER_VOTE_REVOCATION');

export async function revokeParticipationDropsOverVotes() {
  await Promise.all([revokeTdhBasedDropWavesOverVotes()]);
}

async function revokeTdhBasedDropWavesOverVotes() {
  logger.info(`Revoking TDH-based waves overvotes`);
  const timer = new Timer('revokeTdhBasedWavesOverVotes');
  const db = dbSupplier();
  const ctx: RequestContext = { timer };
  const overVoteScenarios =
    await dropsDb.findWaveScopeTdhBasedSubmissionDropOvervotersWithOvervoteAmounts(
      ctx
    );
  for (const overVoteScenario of overVoteScenarios) {
    const { profile_id, wave_id, tdh, total_given_votes } = overVoteScenario;
    const dropsForWaves = await dropsDb.findDropVotesForWaves(
      {
        profile_id,
        wave_id
      },
      ctx
    );
    const reductionCoefficient = tdh / total_given_votes;
    let votes_still_given = total_given_votes;
    for (const drop of dropsForWaves) {
      const { drop_id, votes, author_id, visibility_group_id } = drop;
      const voteAfterRevocation = Math.floor(votes * reductionCoefficient);
      votes_still_given -= Math.abs(votes - voteAfterRevocation);
      logger.info(
        `Revoking drop votes ${JSON.stringify({
          ...drop,
          reductionCoefficient,
          tdh,
          voteAfterRevocation,
          votes_still_given
        })}`
      );
      await db.executeNativeQueriesInTransaction(async (connection) => {
        const ctxWithConnection: RequestContext = { ...ctx, connection };
        await Promise.all([
          dropsDb.updateDropVoterState(
            {
              profile_id,
              drop_id,
              votes: voteAfterRevocation
            },
            ctxWithConnection
          ),
          dropsDb.updateDropRank(
            {
              profile_id,
              drop_id,
              change: votes - voteAfterRevocation
            },
            ctxWithConnection
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
            connection
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
            connection,
            ctx.timer
          )
        ]);
      });
      if (votes_still_given <= tdh) {
        break;
      }
    }
  }
  logger.info(
    `Finished revoking. TDH-based waves overvotes. Times: ${timer.getReport()}`
  );
}
