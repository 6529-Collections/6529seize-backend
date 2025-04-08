import {
  dropVotingDb,
  DropVotingDb
} from '../api-serverless/src/drops/drop-voting.db';
import { Time, Timer } from '../time';
import { RequestContext } from '../request.context';
import { Logger } from '../logging';
import { DropRealVoteInTimeWithoutId } from '../entities/IDropRealVoteInTime';
import { distinct } from '../helpers';
import { DropRealVoterVoteInTimeEntityWithoutId } from '../entities/IDropRealVoterVoteInTime';
import { BadRequestException } from '../exceptions';

export class WaveLeaderboardCalculationService {
  private readonly logger = Logger.get(WaveLeaderboardCalculationService.name);

  constructor(private readonly dropVotingDb: DropVotingDb) {}

  async refreshLeaderboardEntriesForDropsInNeed(timer: Timer) {
    const ctx: RequestContext = { timer };
    const now = Time.now();
    const dropsInNeedOfLeaderboardUpdate =
      await this.dropVotingDb.getDropsInNeedOfLeaderboardUpdate(ctx);
    this.logger.info(
      `Found ${dropsInNeedOfLeaderboardUpdate.length} drops in need of leaderboard update. Will update them`
    );
    const tracker = { success: 0, failed: 0 };
    await Promise.all(
      dropsInNeedOfLeaderboardUpdate.map(async (it) => {
        try {
          await this.calculateLeaderboardEntryForDrop(
            {
              dropId: it.drop_id,
              waveId: it.wave_id,
              startTime: now.minusMillis(it.time_lock_ms),
              endTime: now,
              nextDecisionTime: it.next_decision_time
                ? Time.millis(it.next_decision_time)
                : null
            },
            ctx
          );
          tracker.success++;
        } catch (error) {
          this.logger.error(
            `Failed to update leaderboard entry for drop ${
              it.drop_id
            }. Error: ${JSON.stringify(error)}`
          );
          tracker.failed++;
        }
      })
    );
    this.logger.info(
      `Updated ${
        dropsInNeedOfLeaderboardUpdate.length
      } leaderboard entries (${JSON.stringify(tracker)}).`
    );
    this.logger.info(`Deleting stale leaderboard entries`);
    await this.dropVotingDb.deleteStaleLeaderboardEntries(ctx);
    this.logger.info(`Stale leaderboard entries deleted`);
  }

  async calculateLeaderboardEntryForDrop(
    {
      dropId,
      waveId,
      startTime,
      endTime,
      nextDecisionTime
    }: {
      dropId: string;
      waveId: string;
      startTime: Time;
      endTime: Time;
      nextDecisionTime: Time | null;
    },
    ctx: RequestContext
  ) {
    await this.dropVotingDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        const voteStates = await this.dropVotingDb.getDropVoteStatesInTimespan(
          {
            dropId,
            fromTime: startTime.toMillis(),
            toTime: endTime.toMillis()
          },
          ctxWithConnection
        );
        const finalVote = this.calculateFinalVoteForDrop({
          voteStates,
          endTime,
          startTime
        });
        const finalVoteInDecisionTime = nextDecisionTime
          ? this.calculateFinalVoteForDrop({
              voteStates,
              endTime: nextDecisionTime,
              startTime: nextDecisionTime.minus(endTime.minus(startTime))
            })
          : finalVote;
        await this.dropVotingDb.upsertWaveLeaderboardEntry(
          {
            drop_id: dropId,
            wave_id: waveId,
            vote: finalVote,
            timestamp: endTime.toMillis(),
            vote_on_decision_time: finalVoteInDecisionTime
          },
          ctxWithConnection
        );
      }
    );
  }

  public calculateFinalVoteForDrop({
    voteStates,
    endTime,
    startTime
  }: {
    voteStates: (
      | DropRealVoteInTimeWithoutId
      | DropRealVoterVoteInTimeEntityWithoutId
    )[];
    endTime: Time;
    startTime: Time;
  }) {
    const startMillis = startTime.toMillis();
    const endMillis = endTime.toMillis();
    const voteStatesInTime = voteStates.filter(
      (it) => +it.timestamp >= startMillis && +it.timestamp <= endMillis
    );
    const newestVoteStateBeforeTime = voteStates.reduce((acc, it) => {
      if (
        +it.timestamp < startMillis &&
        (!acc || +it.timestamp > +acc.timestamp)
      ) {
        return it;
      }
      return acc;
    }, null as DropRealVoteInTimeWithoutId | DropRealVoterVoteInTimeEntityWithoutId | null);
    const finalVoteStates: (
      | DropRealVoteInTimeWithoutId
      | DropRealVoterVoteInTimeEntityWithoutId
    )[] = [];
    if (newestVoteStateBeforeTime) {
      finalVoteStates.push({
        ...newestVoteStateBeforeTime,
        timestamp: startMillis
      });
    }
    finalVoteStates.push(...voteStatesInTime);
    finalVoteStates.sort((a, d) => a.timestamp - d.timestamp);
    const fullTimeSpanInMs = endTime.minus(startTime).toMillis();
    const endTimeInMillis = endTime.toMillis();
    const weightedDropVotes: number[] = [];
    for (let i = 0; i < finalVoteStates.length; i++) {
      const weighted = finalVoteStates[i];
      const thisTimeStamp = weighted.timestamp;
      const nextTimestamp =
        i === finalVoteStates.length - 1
          ? endTimeInMillis
          : finalVoteStates[i + 1].timestamp;
      const timeSpan = nextTimestamp - thisTimeStamp;
      const weight = timeSpan / fullTimeSpanInMs;
      const weightedVote = weight * finalVoteStates[i].vote;
      weightedDropVotes.push(weightedVote);
    }
    return Math.floor(weightedDropVotes.reduce((a, b) => a + b, 0));
  }

  public async calculateWeightedVoteForDropAtTime({
    dropId,
    time
  }: {
    dropId: string;
    time: Time;
  }) {
    const timelock = await this.dropVotingDb.findWavesTimelockByDropId(dropId);
    if (!timelock) {
      throw new BadRequestException(
        `Drop ${dropId} is not in a timelocked wave`
      );
    }
    const endTime = time;
    const startTime = endTime.minus(Time.millis(timelock));
    const voteStates =
      await this.dropVotingDb.getDropsParticipatoryDropsVoteStatesInTimespan(
        {
          dropId,
          toTime: endTime.toMillis(),
          fromTime: startTime.toMillis()
        },
        {}
      );
    return this.calculateFinalVoteForDrop({ voteStates, endTime, startTime });
  }

  async calculateWaveLeaderBoardInTimeAndGetTopNDropsWithVotes(
    param: {
      waveId: string;
      startTime: Time;
      endTime: Time;
      n: number;
    },
    ctx: RequestContext
  ): Promise<{ drop_id: string; vote: number; rank: number }[]> {
    if (param.n < 1) {
      return [];
    }
    const importantVotes =
      await this.dropVotingDb.getWavesParticipatoryDropsVoteStatesInTimespan(
        {
          fromTime: param.startTime.toMillis(),
          toTime: param.endTime.toMillis(),
          waveId: param.waveId
        },
        ctx
      );
    const importantVotesByDrop = importantVotes.reduce((acc, it) => {
      if (!acc[it.drop_id]) {
        acc[it.drop_id] = [];
      }
      acc[it.drop_id].push(it);
      return acc;
    }, {} as Record<string, DropRealVoteInTimeWithoutId[]>);
    const allFinalVotesByDropIds = Object.entries(importantVotesByDrop)
      .map(([dropId, votes]) => {
        const finalVote = this.calculateFinalVoteForDrop({
          voteStates: votes,
          endTime: param.endTime,
          startTime: param.startTime
        });
        return { dropId, finalVote };
      })
      .sort((a, d) => d.finalVote - a.finalVote);
    if (allFinalVotesByDropIds.length === 0) {
      return [];
    }
    const finalVotesByDropIds: { dropId: string; finalVote: number }[] = [
      allFinalVotesByDropIds[0]
    ];
    const dropIdsInTie: string[] = [];
    for (let i = 1; i < allFinalVotesByDropIds.length - 1; i++) {
      const current = allFinalVotesByDropIds[i];
      finalVotesByDropIds.push(current);
      const previous = allFinalVotesByDropIds[i - 1];
      if (current.finalVote == previous.finalVote) {
        dropIdsInTie.push(current.dropId);
        dropIdsInTie.push(previous.dropId);
      } else if (i > param.n) {
        break;
      }
    }
    const tieBreakers =
      await this.dropVotingDb.getLastVoteIncreaseTimesForEachDrop(
        distinct(dropIdsInTie),
        ctx
      );
    finalVotesByDropIds.sort((a, d) => {
      if (a.finalVote === d.finalVote) {
        return (tieBreakers[d.dropId] ?? 0) - (tieBreakers[a.dropId] ?? 0);
      }
      return d.finalVote - a.finalVote;
    });
    return finalVotesByDropIds.slice(0, param.n).map((it, idx) => ({
      drop_id: it.dropId,
      vote: it.finalVote,
      rank: idx + 1
    }));
  }
}

export const waveLeaderboardCalculationService =
  new WaveLeaderboardCalculationService(dropVotingDb);
