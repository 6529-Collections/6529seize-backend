import {
  dropVotingDb,
  DropVotingDb
} from '../api-serverless/src/drops/drop-voting.db';
import { Time, Timer } from '../time';
import { RequestContext } from '../request.context';
import { Logger } from '../logging';
import { DropRealVoteInTimeWithoutId } from '../entities/IDropRealVoteInTime';
import { DropRealVoterVoteInTimeEntityWithoutId } from '../entities/IDropRealVoterVoteInTime';
import { BadRequestException } from '../exceptions';
import { collections } from '../collections';
import { numbers } from '../numbers';

type DropVoteState =
  | DropRealVoteInTimeWithoutId
  | DropRealVoterVoteInTimeEntityWithoutId;

interface WeightedThresholdIntervalAnalysis {
  crossedThresholdAtMs: number | null;
  wasBelowThreshold: boolean;
}

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
              previousLeaderboardTimestamp: numbers.parseIntOrNull(
                it.leaderboard_timestamp
              ),
              winningMinThreshold: numbers.parseIntOrNull(
                it.winning_min_threshold
              ),
              winningThresholdMinDurationMs:
                numbers.parseIntOrNull(it.winning_threshold_min_duration_ms) ??
                0,
              previousOverThresholdSinceMs: numbers.parseIntOrNull(
                it.over_threshold_since_ms
              ),
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
      previousLeaderboardTimestamp,
      winningMinThreshold,
      winningThresholdMinDurationMs,
      previousOverThresholdSinceMs,
      startTime,
      endTime,
      nextDecisionTime
    }: {
      dropId: string;
      waveId: string;
      previousLeaderboardTimestamp: number | null;
      winningMinThreshold: number | null;
      winningThresholdMinDurationMs: number | null;
      previousOverThresholdSinceMs: number | null;
      startTime: Time;
      endTime: Time;
      nextDecisionTime: Time | null;
    },
    ctx: RequestContext
  ) {
    await this.dropVotingDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        const voteHistoryStartTime = this.getVoteHistoryStartTime({
          previousLeaderboardTimestamp,
          previousOverThresholdSinceMs,
          startTime,
          endTime,
          shouldTrackOverThreshold:
            winningMinThreshold !== null &&
            (winningThresholdMinDurationMs ?? 0) > 0
        });
        const voteStates = await this.dropVotingDb.getDropVoteStatesInTimespan(
          {
            dropId,
            fromTime: voteHistoryStartTime.toMillis(),
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
        const overThresholdSinceMs = this.calculateOverThresholdSinceMs({
          winningMinThreshold,
          winningThresholdMinDurationMs,
          previousOverThresholdSinceMs,
          previousLeaderboardTimestamp,
          finalVote,
          voteStates,
          startTime,
          endTime
        });
        await this.dropVotingDb.upsertWaveLeaderboardEntry(
          {
            drop_id: dropId,
            wave_id: waveId,
            vote: finalVote,
            timestamp: endTime.toMillis(),
            vote_on_decision_time: finalVoteInDecisionTime,
            over_threshold_since_ms: overThresholdSinceMs
          },
          ctxWithConnection
        );
      }
    );
  }

  private getVoteHistoryStartTime({
    previousLeaderboardTimestamp,
    previousOverThresholdSinceMs,
    startTime,
    endTime,
    shouldTrackOverThreshold
  }: {
    previousLeaderboardTimestamp: number | null;
    previousOverThresholdSinceMs: number | null;
    startTime: Time;
    endTime: Time;
    shouldTrackOverThreshold: boolean;
  }): Time {
    const timeLockDuration = endTime.minus(startTime);
    if (!shouldTrackOverThreshold) {
      return startTime;
    }
    const thresholdEvaluationStartTime =
      previousOverThresholdSinceMs === null ||
      previousLeaderboardTimestamp === null
        ? startTime
        : Time.millis(previousLeaderboardTimestamp);
    return thresholdEvaluationStartTime.minus(timeLockDuration);
  }

  private calculateOverThresholdSinceMs({
    winningMinThreshold,
    winningThresholdMinDurationMs,
    previousOverThresholdSinceMs,
    previousLeaderboardTimestamp,
    finalVote,
    voteStates,
    startTime,
    endTime
  }: {
    winningMinThreshold: number | null;
    winningThresholdMinDurationMs: number | null;
    previousOverThresholdSinceMs: number | null;
    previousLeaderboardTimestamp: number | null;
    finalVote: number;
    voteStates: DropVoteState[];
    startTime: Time;
    endTime: Time;
  }): number | null {
    if (
      winningMinThreshold === null ||
      (winningThresholdMinDurationMs ?? 0) <= 0
    ) {
      return null;
    }
    if (finalVote < winningMinThreshold) {
      return null;
    }
    const thresholdEvaluationStartTime =
      previousOverThresholdSinceMs === null ||
      previousLeaderboardTimestamp === null
        ? startTime
        : Time.millis(previousLeaderboardTimestamp);
    const thresholdIntervalAnalysis = this.analyzeWeightedThresholdInterval({
      voteStates,
      startTime: thresholdEvaluationStartTime,
      endTime,
      timeLockDuration: endTime.minus(startTime),
      winningMinThreshold
    });
    if (
      previousOverThresholdSinceMs !== null &&
      previousLeaderboardTimestamp !== null &&
      !thresholdIntervalAnalysis.wasBelowThreshold
    ) {
      return previousOverThresholdSinceMs;
    }
    return (
      thresholdIntervalAnalysis.crossedThresholdAtMs ??
      thresholdEvaluationStartTime.toMillis()
    );
  }

  private analyzeWeightedThresholdInterval({
    voteStates,
    startTime,
    endTime,
    timeLockDuration,
    winningMinThreshold
  }: {
    voteStates: DropVoteState[];
    startTime: Time;
    endTime: Time;
    timeLockDuration: Time;
    winningMinThreshold: number;
  }): WeightedThresholdIntervalAnalysis {
    const checkpoints = this.getWeightedVoteCheckpoints({
      voteStates,
      startTime,
      endTime,
      timeLockDuration
    });
    let previousCheckpoint = checkpoints[0];
    let previousScore = this.calculateWeightedVoteForDrop({
      voteStates,
      startTime: previousCheckpoint.minus(timeLockDuration),
      endTime: previousCheckpoint
    });
    let wasBelowThreshold = previousScore < winningMinThreshold;

    for (let i = 1; i < checkpoints.length; i++) {
      const checkpoint = checkpoints[i];
      const score = this.calculateWeightedVoteForDrop({
        voteStates,
        startTime: checkpoint.minus(timeLockDuration),
        endTime: checkpoint
      });
      if (previousScore < winningMinThreshold && score >= winningMinThreshold) {
        return {
          crossedThresholdAtMs: this.interpolateThresholdCrossingMs({
            previousCheckpoint,
            previousScore,
            checkpoint,
            score,
            winningMinThreshold
          }),
          wasBelowThreshold: true
        };
      }
      if (score < winningMinThreshold) {
        wasBelowThreshold = true;
      }
      previousCheckpoint = checkpoint;
      previousScore = score;
    }

    return {
      crossedThresholdAtMs: null,
      wasBelowThreshold
    };
  }

  private interpolateThresholdCrossingMs({
    previousCheckpoint,
    previousScore,
    checkpoint,
    score,
    winningMinThreshold
  }: {
    previousCheckpoint: Time;
    previousScore: number;
    checkpoint: Time;
    score: number;
    winningMinThreshold: number;
  }): number {
    const previousMillis = previousCheckpoint.toMillis();
    const checkpointMillis = checkpoint.toMillis();
    if (checkpointMillis <= previousMillis || score <= previousScore) {
      return checkpointMillis;
    }
    const crossedAfter =
      ((winningMinThreshold - previousScore) / (score - previousScore)) *
      (checkpointMillis - previousMillis);
    const crossingMillis = previousMillis + Math.ceil(crossedAfter);
    return Math.min(checkpointMillis, Math.max(previousMillis, crossingMillis));
  }

  private getWeightedVoteCheckpoints({
    voteStates,
    startTime,
    endTime,
    timeLockDuration
  }: {
    voteStates: DropVoteState[];
    startTime: Time;
    endTime: Time;
    timeLockDuration: Time;
  }): Time[] {
    const startMillis = startTime.toMillis();
    const endMillis = endTime.toMillis();
    const timeLockMillis = timeLockDuration.toMillis();
    if (startMillis >= endMillis) {
      return [endTime];
    }
    const checkpointMillis = new Set<number>([startMillis, endMillis]);
    for (const voteState of voteStates) {
      if (
        voteState.timestamp > startMillis &&
        voteState.timestamp < endMillis
      ) {
        checkpointMillis.add(voteState.timestamp);
      }
      const expiryTimestamp = voteState.timestamp + timeLockMillis;
      if (expiryTimestamp > startMillis && expiryTimestamp < endMillis) {
        checkpointMillis.add(expiryTimestamp);
      }
    }
    return Array.from(checkpointMillis)
      .sort((a, d) => a - d)
      .map((timestamp) => Time.millis(timestamp));
  }

  public calculateFinalVoteForDrop({
    voteStates,
    endTime,
    startTime
  }: {
    voteStates: DropVoteState[];
    endTime: Time;
    startTime: Time;
  }) {
    return Math.floor(
      this.calculateWeightedVoteForDrop({ voteStates, endTime, startTime })
    );
  }

  private calculateWeightedVoteForDrop({
    voteStates,
    endTime,
    startTime
  }: {
    voteStates: DropVoteState[];
    endTime: Time;
    startTime: Time;
  }) {
    const startMillis = startTime.toMillis();
    const endMillis = endTime.toMillis();
    const voteStatesInTime = voteStates.filter(
      (it) => it.timestamp >= startMillis && it.timestamp <= endMillis
    );
    const newestVoteStateBeforeTime = voteStates.reduce(
      (acc, it) => {
        if (
          it.timestamp < startMillis &&
          (!acc || it.timestamp > acc.timestamp)
        ) {
          return it;
        }
        return acc;
      },
      null as DropVoteState | null
    );
    const finalVoteStates: DropVoteState[] = [];
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
    const nonFlooredResult = numbers.sum(weightedDropVotes);
    return nonFlooredResult;
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
    return await this.calculateWeightedVoteForDropInTime(
      {
        dropId,
        time,
        timeLockMs: timelock
      },
      {}
    );
  }

  public async calculateWeightedVoteForDropInTime(
    {
      dropId,
      time,
      timeLockMs
    }: {
      dropId: string;
      time: Time;
      timeLockMs: number;
    },
    ctx: RequestContext
  ) {
    const endTime = time;
    const startTime = endTime.minusMillis(timeLockMs);
    const voteStates =
      await this.dropVotingDb.getDropsParticipatoryDropsVoteStatesInTimespan(
        {
          dropId,
          toTime: endTime.toMillis(),
          fromTime: startTime.toMillis()
        },
        ctx
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
    const importantVotesByDrop = importantVotes.reduce(
      (acc, it) => {
        if (!acc[it.drop_id]) {
          acc[it.drop_id] = [];
        }
        acc[it.drop_id].push(it);
        return acc;
      },
      {} as Record<string, DropRealVoteInTimeWithoutId[]>
    );
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
        collections.distinct(dropIdsInTie),
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
