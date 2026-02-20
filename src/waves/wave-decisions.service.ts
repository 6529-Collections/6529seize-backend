import {
  dropVotingDb,
  DropVotingDb
} from '../api-serverless/src/drops/drop-voting.db';
import { wavesApiDb } from '../api-serverless/src/waves/waves.api.db';
import { collections } from '../collections';
import { DropsDb, dropsDb } from '../drops/drops.db';
import { DropRealVoterVoteInTimeEntityWithoutId } from '../entities/IDropRealVoterVoteInTime';
import {
  WaveDecisionStrategy,
  WaveOutcomeCredit,
  WaveOutcomeSubType,
  WaveOutcomeType
} from '../entities/IWave';
import {
  WaveDecisionWinnerDropEntity,
  WaveDecisionWinnerPrize
} from '../entities/IWaveDecision';
import { WinnerDropVoterVoteEntity } from '../entities/IWinnerDropVoterVote';
import { env } from '../env';
import { deployerDropper, DeployerDropper } from '@/deployer-dropper';
import { Logger } from '../logging';
import { RequestContext } from '../request.context';
import { Time, Timer } from '../time';
import { waveDecisionsDb, WaveDecisionsDb } from './wave-decisions.db';
import { enqueueClaimBuild as publishClaimBuild } from '@/waves/claims-builder-publisher';
import {
  waveLeaderboardCalculationService,
  WaveLeaderboardCalculationService
} from './wave-leaderboard-calculation.service';
import * as priorityAlertsContext from '../priority-alerts.context';

interface WaveOutcome {
  type: WaveOutcomeType;
  subtype?: WaveOutcomeSubType;
  description: string;
  credit?: WaveOutcomeCredit;
  rep_category?: string;
  amount?: number;
  distribution?: Array<WaveOutcomeDistributionItem>;
}

interface WaveOutcomeDistributionItem {
  amount?: number | null;
  description?: string | null;
}

export class WaveDecisionsService {
  private readonly logger: Logger = Logger.get(this.constructor.name);

  constructor(
    private readonly waveDecisionsDb: WaveDecisionsDb,
    private readonly waveLeaderboardCalculationService: WaveLeaderboardCalculationService,
    private readonly dropVotingDb: DropVotingDb,
    private readonly dropsDb: DropsDb,
    private readonly deployerDropper: DeployerDropper
  ) {}

  public async createMissingDecisionsForAllWaves(timer: Timer): Promise<void> {
    this.logger.info(`Looking for wave decisions to execute`);
    timer.start(`${this.constructor.name}->createMissingDecisionsForAllWaves`);
    const currentMillis = Time.currentMillis();
    const wavesLatestDecisionTimesWithStrategies =
      await this.waveDecisionsDb.getWavesWithDecisionTimesBeforeGivenTime(
        currentMillis,
        { timer }
      );
    const waveIds = collections.distinct(
      wavesLatestDecisionTimesWithStrategies.map((it) => it.wave_id)
    );
    const outcomes = await wavesApiDb.getWavesOutcomes(waveIds, { timer });
    const distributionItems =
      await wavesApiDb.getWavesOutcomesDistributionItems(waveIds, { timer });
    const withOutcomes = wavesLatestDecisionTimesWithStrategies.map((it) => {
      const outcomeEntities = outcomes[it.wave_id] ?? [];
      const distributionEntities = distributionItems[it.wave_id] ?? [];
      const result = outcomeEntities
        .sort((a, d) => a.wave_outcome_position - d.wave_outcome_position)
        .map<WaveOutcome>((outcome) => {
          const distributions = distributionEntities
            .filter(
              (it) => it.wave_outcome_position === outcome.wave_outcome_position
            )
            .sort(
              (a, d) =>
                a.wave_outcome_distribution_item_position -
                d.wave_outcome_distribution_item_position
            )
            .map<WaveOutcomeDistributionItem>((item) => ({
              amount: item.amount,
              description: item.description
            }));
          return {
            type: outcome.type,
            subtype: outcome.subtype ?? undefined,
            description: outcome.description,
            credit: outcome.credit ?? undefined,
            rep_category: outcome.rep_category ?? undefined,
            amount: outcome.amount === null ? undefined : outcome.amount,
            distribution: distributions
          };
        });
      return {
        ...it,
        outcomes: result
      };
    });
    this.logger.info(
      `Found ${wavesLatestDecisionTimesWithStrategies.length} waves with past execution deadlines. Starting to execute decisions`
    );
    for (const wavesLatestDecisionTimesWithStrategy of withOutcomes) {
      await this.createDecisionsForWave(
        wavesLatestDecisionTimesWithStrategy,
        currentMillis,
        timer
      );
    }
    this.logger.info(`Executed all overdue wave decisions`);
    timer.stop(`${this.constructor.name}->createMissingDecisionsForAllWaves`);
  }

  async createDecisionsForWave(
    wavesLatestDecisionTimesWithStrategy: {
      wave_id: string;
      latest_decision_time: number | null;
      decisions_strategy: WaveDecisionStrategy;
      time_lock_ms: number | null;
      outcomes: WaveOutcome[];
    },
    currentMillis: number,
    timer: Timer
  ) {
    const wavePauses = await this.waveDecisionsDb.getWavePauses(
      wavesLatestDecisionTimesWithStrategy.wave_id,
      { timer }
    );
    const latestDecisionTime =
      wavesLatestDecisionTimesWithStrategy.latest_decision_time ?? 0;
    const strategy = wavesLatestDecisionTimesWithStrategy.decisions_strategy;
    const decisionGaps =
      wavesLatestDecisionTimesWithStrategy.decisions_strategy
        .subsequent_decisions;
    const is_rolling =
      wavesLatestDecisionTimesWithStrategy.decisions_strategy.is_rolling;
    const outcomes = wavesLatestDecisionTimesWithStrategy.outcomes;
    const waveId = wavesLatestDecisionTimesWithStrategy.wave_id;
    const time_lock_ms = wavesLatestDecisionTimesWithStrategy.time_lock_ms;
    let decisionTime: number | null = strategy.first_decision_time;
    let decisionPointer = -1;
    let decisionsExecuted = 0;
    while (decisionTime !== null && decisionTime < currentMillis) {
      if (latestDecisionTime < decisionTime) {
        let claimBuildDropId: string | null = null;
        await this.waveDecisionsDb.executeNativeQueriesInTransaction(
          async (connection) => {
            this.logger.info(
              `Execution decision ${decisionTime} for wave ${waveId}`
            );
            if (decisionTime !== null) {
              const decisionNotOnPause = !wavePauses.find((p) =>
                Time.millis(decisionTime!).isInInterval(p.start, p.end)
              );
              if (decisionNotOnPause) {
                claimBuildDropId = await this.createDecision(
                  { waveId, decisionTime, outcomes, time_lock_ms },
                  { timer, connection }
                );
                decisionsExecuted++;
              } else {
                this.logger.info(
                  `Decision ${decisionTime} not executed for wave ${waveId}. Found a pause on this time`
                );
              }
            }
            decisionPointer = this.calculateNextDecisionPointer(
              decisionGaps,
              decisionPointer,
              is_rolling
            );
            if (decisionPointer === -1) {
              decisionTime = null;
            } else if (decisionTime !== null) {
              decisionTime += decisionGaps[decisionPointer];
            }
            this.logger.info(
              `Setting next decision time for wave ${waveId} to ${decisionTime}`
            );
            await this.waveDecisionsDb.updateWavesNextDecisionTime(
              waveId,
              decisionTime,
              { timer, connection }
            );
          }
        );
        if (claimBuildDropId) {
          await this.enqueueClaimBuild(claimBuildDropId, waveId);
        }
      } else {
        decisionPointer = this.calculateNextDecisionPointer(
          decisionGaps,
          decisionPointer,
          is_rolling
        );
        if (decisionPointer === -1) {
          decisionTime = null;
        } else {
          decisionTime += decisionGaps[decisionPointer];
        }
      }
    }
    this.logger.info(
      `Executed ${decisionsExecuted} decisions for wave ${waveId}`
    );
  }

  private calculateNextDecisionPointer(
    decisionGaps: number[],
    decisionPointer: number,
    is_rolling: boolean
  ): number {
    if (!decisionGaps.length) {
      return -1;
    } else if (is_rolling) {
      if (decisionPointer === decisionGaps.length - 1) {
        return 0;
      }
      return decisionPointer + 1;
    }
    if (decisionPointer === decisionGaps.length - 1) {
      return -1;
    }
    return decisionPointer + 1;
  }

  private async createDecision(
    {
      decisionTime,
      waveId,
      outcomes,
      time_lock_ms
    }: {
      decisionTime: number;
      waveId: string;
      outcomes: WaveOutcome[];
      time_lock_ms: number | null;
    },
    ctx: RequestContext
  ): Promise<string | null> {
    ctx?.timer?.start(`${this.constructor.name}->createDecision`);
    await this.waveDecisionsDb.insertDecision(
      {
        decision_time: decisionTime,
        wave_id: waveId
      },
      ctx
    );
    const n = outcomes
      .map((it) => it.distribution?.length ?? 1)
      .reduce((previous, cur) => (cur > previous ? cur : previous), 0);
    const winnerDrops = await this.getWinnerDropIdsOrderByPlaces(
      { waveId, n, time_lock_ms, decision_time: Time.millis(decisionTime) },
      ctx
    );
    const decisionWinners: Omit<WaveDecisionWinnerDropEntity, 'id'>[] = [];
    for (const winnerDrop of winnerDrops) {
      const dropPrizes = outcomes
        .map<WaveDecisionWinnerPrize | null>((outcome) => {
          if (
            (outcome.distribution?.length ?? 1) === 1 &&
            winnerDrop.rank > 1
          ) {
            return null;
          }
          if (!outcome.distribution || outcome.distribution.length === 0) {
            return {
              type: outcome.type,
              subtype: outcome.subtype ?? null,
              description: outcome.description,
              credit: outcome.credit ?? null,
              rep_category: outcome.rep_category ?? null,
              amount: outcome.amount ?? null
            };
          } else {
            const outcomePart = outcome.distribution[winnerDrop.rank - 1];
            if (!outcomePart) {
              return null;
            }
            let amount: number | null = null;
            if (outcome.amount) {
              const partAmount = outcomePart.amount ?? 0;
              amount = Math.floor(outcome.amount * (partAmount / 100));
            }
            return {
              type: outcome.type,
              subtype: outcome.subtype ?? null,
              description: `${outcome.description}${
                outcomePart.description ? ` / ${outcomePart.description}` : ''
              }`,
              credit: outcome.credit ?? null,
              rep_category: outcome.rep_category ?? null,
              amount: amount
            };
          }
        })
        .filter((prize) => !!prize)
        .map((prize) => prize!);
      decisionWinners.push({
        wave_id: waveId,
        prizes: dropPrizes,
        ranking: winnerDrop.rank,
        drop_id: winnerDrop.drop_id,
        decision_time: decisionTime,
        final_vote: winnerDrop.vote
      });
    }

    const winnerDropIds = winnerDrops.map((it) => it.drop_id);
    await this.transferFinalVotesToArchive(
      {
        dropIds: winnerDropIds,
        time_lock_ms,
        decision_time: Time.millis(decisionTime),
        waveId
      },
      ctx
    );
    await this.waveDecisionsDb.insertDecisionWinners(decisionWinners, ctx);
    await this.waveDecisionsDb.updateDropsToWinners(winnerDropIds, ctx);
    const mainStageWaveId = env.getStringOrNull('MAIN_STAGE_WAVE_ID');
    const claimBuildDropId =
      mainStageWaveId && waveId === mainStageWaveId && winnerDrops.length > 0
        ? winnerDrops[0].drop_id
        : null;
    await this.waveDecisionsDb.deleteDropsRanks(winnerDropIds, ctx);
    await this.dropsDb.resyncParticipatoryDropCountsForWaves([waveId], ctx);
    await this.dropVotingDb.deleteStaleLeaderboardEntries(ctx);
    await this.createAnnouncementDrop(waveId, winnerDropIds, ctx);
    ctx?.timer?.stop(`${this.constructor.name}->createDecision`);
    return claimBuildDropId;
  }

  private async enqueueClaimBuild(
    dropId: string,
    waveId: string
  ): Promise<void> {
    try {
      await publishClaimBuild(dropId);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const alertError = new Error(
        `enqueueClaimBuild failed for drop ${dropId} in wave ${waveId}: ${rawMessage}`
      );
      if (err instanceof Error && err.stack) {
        alertError.stack = `${alertError.stack}\nCaused by:\n${err.stack}`;
      }
      await priorityAlertsContext.sendPriorityAlert(
        'Wave Decision Loop - Meme Claim Build Enqueue',
        alertError
      );
      this.logger.warn('enqueueClaimBuild failed (decision still committed)', {
        dropId,
        waveId,
        err
      });
    }
  }

  private async getWinnerDropIdsOrderByPlaces(
    {
      waveId,
      n,
      time_lock_ms,
      decision_time
    }: {
      waveId: string;
      n: number;
      time_lock_ms: number | null;
      decision_time: Time;
    },
    ctx: RequestContext
  ): Promise<{ drop_id: string; vote: number; rank: number }[]> {
    if (time_lock_ms !== null && time_lock_ms > 0) {
      return this.waveLeaderboardCalculationService.calculateWaveLeaderBoardInTimeAndGetTopNDropsWithVotes(
        {
          waveId,
          startTime: decision_time.minusMillis(time_lock_ms),
          endTime: decision_time,
          n
        },
        ctx
      );
    }
    return this.waveDecisionsDb.getTopNDropIdsForWaveWithVotes(
      { waveId, n },
      ctx
    );
  }

  public async transferFinalVotesToArchive(
    {
      dropIds,
      decision_time,
      time_lock_ms,
      waveId
    }: {
      time_lock_ms: number | null;
      decision_time: Time;
      dropIds: string[];
      waveId: string;
    },
    ctx: RequestContext
  ) {
    const endTime = decision_time;
    const allFinalVoterVotesByDrops: WinnerDropVoterVoteEntity[] = [];
    if (time_lock_ms !== null && time_lock_ms > 0) {
      const startTime = endTime.minusMillis(time_lock_ms);
      const votesByDropsAndVoters =
        await this.dropVotingDb.getAllVoteChangeLogsForGivenDropsInTimeframe(
          {
            timeLockStart: startTime.toMillis(),
            dropIds
          },
          ctx
        );
      for (const [dropId, votesByVoters] of Object.entries(
        votesByDropsAndVoters
      )) {
        for (const [voterId, dropVoterVotes] of Object.entries(votesByVoters)) {
          const transformed =
            dropVoterVotes.map<DropRealVoterVoteInTimeEntityWithoutId>(
              (vote) => ({
                drop_id: dropId,
                voter_id: voterId,
                vote: vote.vote,
                timestamp:
                  vote.timestamp > startTime.toMillis()
                    ? vote.timestamp
                    : startTime.toMillis(),
                wave_id: waveId
              })
            );
          const finalVoterVoteForThisDrop =
            this.waveLeaderboardCalculationService.calculateFinalVoteForDrop({
              voteStates: transformed,
              startTime,
              endTime
            });
          allFinalVoterVotesByDrops.push({
            voter_id: voterId,
            drop_id: dropId,
            votes: finalVoterVoteForThisDrop,
            wave_id: waveId
          });
        }
      }
    }
    await this.dropVotingDb.insertWinnerDropsVoterVotes(
      allFinalVoterVotesByDrops,
      ctx
    );
  }

  private async createAnnouncementDrop(
    waveId: string,
    winnerDropIds: string[],
    ctx: RequestContext
  ) {
    const mainStageWaveId = env.getStringOrNull('MAIN_STAGE_WAVE_ID');
    const wavesToDropWinnerAnnouncementsTo = env.getStringArray(
      'DEPLOYER_ANNOUNCEMENTS_WAVE_IDS'
    );
    if (wavesToDropWinnerAnnouncementsTo.length && waveId === mainStageWaveId) {
      for (const dropId of winnerDropIds) {
        const winnerHandle = await this.dropsDb.getDropAuthorHandle(
          dropId,
          ctx
        );
        const waveDropUrlTemplate =
          env.getStringOrNull(`FE_WAVE_DROP_URL_TEMPLATE`) ??
          'https://6529.io/waves?&wave={waveId}&drop={dropId}';
        const dropUrl = waveDropUrlTemplate
          .replace('{waveId}', mainStageWaveId)
          .replace('{dropId}', dropId);
        const message = `🏆 New Main Stage Winner!\n${dropUrl}${winnerHandle ? `\nGG @[${winnerHandle}] :sgt_pinched_fingers:` : ``}`;
        await this.deployerDropper.drop(
          {
            message,
            waves: wavesToDropWinnerAnnouncementsTo,
            mentionedUsers: winnerHandle ? [winnerHandle] : []
          },
          ctx
        );
      }
    }
  }
}

export const waveDecisionsService = new WaveDecisionsService(
  waveDecisionsDb,
  waveLeaderboardCalculationService,
  dropVotingDb,
  dropsDb,
  deployerDropper
);
