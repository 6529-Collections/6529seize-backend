import { dropVotingDb, DropVotingDb } from '../drops/drop-voting.db';
import { Time, Timer } from '../../../time';
import { WaveLeaderboardEntryWithoutId } from '../../../entities/IWaveLeaderboardEntry';
import { RequestContext } from '../../../request.context';
import { DropRealVoteInTimeWithoutId } from '../../../entities/IDropRealVoteInTime';

export class WaveLeaderboardCalculationService {
  constructor(private readonly dropVotingDb: DropVotingDb) {}

  async refreshLeaderboardForWavesInNeedOfRefresh() {
    const timer = new Timer(
      `${this.constructor.name}->refreshLeaderboardForWavesInNeedOfRefresh`
    );
    const ctx: RequestContext = { timer };
    const now = Time.now().minusSeconds(30);
    const wavesPastLeaderboardCalculationTime =
      await this.dropVotingDb.getWavesPastLeaderboardCalculationTime(now, ctx);
    const toFullProcess: {
      waveId: string;
      startTime: Time;
      endTime: Time;
    }[] = [];
    const toUpdateTime: string[] = [];
    for (const e of wavesPastLeaderboardCalculationTime) {
      if (
        e.latest_leaderboard_calculation === null &&
        e.latest_vote_change === null
      ) {
        continue;
      }
      if (
        e.latest_vote_change === null ||
        e.latest_leaderboard_calculation == null
      ) {
        toFullProcess.push({
          waveId: e.wave_id,
          endTime: now,
          startTime: now.minusMillis(e.time_lock_ms)
        });
      } else if (
        Time.millis(e.time_lock_ms).lt(
          Time.millis(e.latest_leaderboard_calculation).minus(
            Time.millis(e.latest_vote_change)
          )
        )
      ) {
        toUpdateTime.push(e.wave_id);
      } else {
        toFullProcess.push({
          waveId: e.wave_id,
          endTime: now,
          startTime: now.minusMillis(e.time_lock_ms)
        });
      }
    }
    await this.dropVotingDb.updateLeaderboardTimesForAllWavesDrops(
      toUpdateTime,
      now.toMillis(),
      ctx
    );
    for (const fullProcessableEntity of toFullProcess) {
      await this.dropVotingDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const newLeaderBoard =
            await this.calculateLeaderboardForWaveForPeriod(
              fullProcessableEntity,
              ctxWithConnection
            );
          await this.dropVotingDb.reinsertWaveLeaderboardData(
            newLeaderBoard,
            fullProcessableEntity.waveId,
            ctxWithConnection
          );
        }
      );
    }
  }

  async calculateLeaderboardForWaveForPeriod(
    {
      waveId,
      startTime,
      endTime
    }: {
      waveId: string;
      startTime: Time;
      endTime: Time;
    },
    ctx: RequestContext
  ): Promise<WaveLeaderboardEntryWithoutId[]> {
    const finalResult: (Omit<WaveLeaderboardEntryWithoutId, 'rank'> & {
      last_increase_time: number;
    })[] = [];
    const lastIncreaseTimes =
      await this.dropVotingDb.getDropsLastVoteIncreaseTimes(waveId, ctx);
    const voteStates = await this.dropVotingDb.getDropsVoteStatesInTimespan(
      {
        fromTime: startTime.toMillis(),
        toTime: endTime.toMillis(),
        waveId
      },
      ctx
    );

    const voteStatesByDrops = voteStates
      .sort((a, d) => a.timestamp - d.timestamp)
      .reduce((acc, it) => {
        const dropId = it.drop_id;
        if (!acc[dropId]) {
          acc[dropId] = [];
        }
        acc[dropId].push(it);
        return acc;
      }, {} as Record<string, DropRealVoteInTimeWithoutId[]>);
    const fullTimeSpanInMs = endTime.minus(startTime).toMillis();
    for (const [dropId, voteStates] of Object.entries(voteStatesByDrops)) {
      let timePointer = endTime.toMillis();
      const weightedDropVotes: number[] = [];
      for (let i = voteStates.length - 1; i >= 0; i--) {
        const voteChangeTimestamp = voteStates[i].timestamp;
        const dropVote = voteStates[i].vote;
        const voteActivityTimeMs = timePointer - voteChangeTimestamp;
        if (fullTimeSpanInMs === 0) {
          weightedDropVotes.push(dropVote);
        } else {
          weightedDropVotes.push(
            dropVote * (voteActivityTimeMs / fullTimeSpanInMs)
          );
        }
        timePointer = voteChangeTimestamp;
      }
      const finalVote = Math.floor(
        weightedDropVotes.reduce((a, b) => a + b, 0) / weightedDropVotes.length
      );
      finalResult.push({
        vote: finalVote,
        drop_id: dropId,
        wave_id: waveId,
        timestamp: endTime.toMillis(),
        last_increase_time: lastIncreaseTimes[dropId] ?? 0
      });
    }
    return finalResult
      .sort((a, d) => {
        if (a.vote === d.vote) {
          return d.last_increase_time - a.last_increase_time;
        }
        return d.vote - a.vote;
      })
      .map((it, idx) => ({ ...it, rank: idx + 1 }));
  }
}

export const waveLeaderboardCalculationService =
  new WaveLeaderboardCalculationService(dropVotingDb);
