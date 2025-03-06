import { waveDecisionsDb, WaveDecisionsDb } from './wave-decisions.db';
import { Time, Timer } from '../time';
import { RequestContext } from '../request.context';
import { WaveDecisionStrategy, WaveOutcome } from '../entities/IWave';
import {
  WaveDecisionWinnerDropEntity,
  WaveDecisionWinnerPrize
} from '../entities/IWaveDecision';
import { Logger } from '../logging';

export class WaveDecisionsService {
  private readonly logger: Logger = Logger.get(this.constructor.name);

  constructor(private readonly waveDecisionsDb: WaveDecisionsDb) {}

  public async createMissingDecisionsForAllWaves(timer: Timer): Promise<void> {
    this.logger.info(`Looking for wave decisions to execute`);
    timer.start(`${this.constructor.name}->createMissingDecisionsForAllWaves`);
    const currentMillis = Time.currentMillis();
    const wavesLatestDecisionTimesWithStrategies =
      await this.waveDecisionsDb.getWavesWithDecisionTimesBeforeGivenTime(
        currentMillis,
        { timer }
      );
    this.logger.info(
      `Found ${wavesLatestDecisionTimesWithStrategies.length} waves with past execution deadlines. Starting to execute decisions`
    );
    for (const wavesLatestDecisionTimesWithStrategy of wavesLatestDecisionTimesWithStrategies) {
      await this.createDecisionsForWave(
        wavesLatestDecisionTimesWithStrategy,
        currentMillis,
        timer
      );
    }
    this.logger.info(`Executed all overdue wave decisions`);
    timer.stop(`${this.constructor.name}->createMissingDecisionsForAllWaves`);
  }

  private async createDecisionsForWave(
    wavesLatestDecisionTimesWithStrategy: {
      wave_id: string;
      latest_decision_time: number | null;
      decisions_strategy: WaveDecisionStrategy;
      outcomes: WaveOutcome[];
    },
    currentMillis: number,
    timer: Timer
  ) {
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
    let decisionTime: number | null = strategy.first_decision_time;
    let decisionPointer = 0;
    let decisionsExecuted = 0;
    while (decisionTime !== null && decisionTime < currentMillis) {
      if (latestDecisionTime < decisionTime) {
        await this.waveDecisionsDb.executeNativeQueriesInTransaction(
          async (connection) => {
            this.logger.info(
              `Execution decision ${decisionTime} for wave ${waveId}`
            );
            if (decisionTime !== null) {
              await this.createDecision(
                { waveId, decisionTime, outcomes },
                { timer, connection }
              );
              decisionsExecuted++;
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
      outcomes
    }: { decisionTime: number; waveId: string; outcomes: WaveOutcome[] },
    ctx: RequestContext
  ) {
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
    const winnerDropIdsOrderByPlaces =
      await this.waveDecisionsDb.getTopNDropIdsForWave({ waveId, n }, ctx);
    const decisionWinners: Omit<WaveDecisionWinnerDropEntity, 'id'>[] = [];
    let place = 1;
    for (const dropId of winnerDropIdsOrderByPlaces) {
      const dropPrizes = outcomes
        .map<WaveDecisionWinnerPrize | null>((outcome) => {
          if ((outcome.distribution?.length ?? 1) === 1 && place > 1) {
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
            const outcomePart = outcome.distribution[place - 1];
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
        ranking: place,
        drop_id: dropId,
        decision_time: decisionTime
      });
      place++;
    }
    await this.waveDecisionsDb.insertDecisionWinners(decisionWinners, ctx);
    await this.waveDecisionsDb.updateDropsToWinners(
      winnerDropIdsOrderByPlaces,
      ctx
    );
    await this.waveDecisionsDb.deleteDropsRanks(
      winnerDropIdsOrderByPlaces,
      ctx
    );
    ctx?.timer?.stop(`${this.constructor.name}->createDecision`);
  }
}

export const waveDecisionsService = new WaveDecisionsService(waveDecisionsDb);
