import { waveDecisionsDb, WaveDecisionsDb } from './wave-decisions.db';
import { Time, Timer } from '../time';
import { RequestContext } from '../request.context';
import { WaveDecisionStrategy, WaveOutcome } from '../entities/IWave';
import {
  WaveDecisionWinnerDropEntity,
  WaveDecisionWinnerPrize
} from '../entities/IWaveDecision';

export class WaveDecisionsService {
  constructor(private readonly waveDecisionsDb: WaveDecisionsDb) {}

  public async createMissingDecisionsForAllWaves(timer: Timer): Promise<void> {
    timer.start(`${this.constructor.name}->createMissingDecisionsForAllWaves`);
    await this.waveDecisionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection, timer };
        const currentMillis = Time.currentMillis();
        const wavesLatestDecisionTimesWithStrategies =
          await this.waveDecisionsDb.getWavesWithDecisionTimesBeforeGivenTime(
            currentMillis,
            ctx
          );
        for (const wavesLatestDecisionTimesWithStrategy of wavesLatestDecisionTimesWithStrategies) {
          await this.createDecisionsForWaves(
            wavesLatestDecisionTimesWithStrategy,
            currentMillis,
            ctx
          );
        }
      }
    );
    timer.stop(`${this.constructor.name}->createMissingDecisionsForAllWaves`);
  }

  private async createDecisionsForWaves(
    wavesLatestDecisionTimesWithStrategy: {
      wave_id: string;
      latest_decision_time: number | null;
      decisions_strategy: WaveDecisionStrategy;
      outcomes: WaveOutcome[];
    },
    currentMillis: number,
    ctx: RequestContext
  ) {
    const latestDecisionTime =
      wavesLatestDecisionTimesWithStrategy.latest_decision_time ?? 0;
    const strategy = wavesLatestDecisionTimesWithStrategy.decisions_strategy;
    const subsequentDecisionsStrategy =
      wavesLatestDecisionTimesWithStrategy.decisions_strategy
        .subsequent_decisions;
    const is_rolling =
      wavesLatestDecisionTimesWithStrategy.decisions_strategy.is_rolling;
    const outcomes = wavesLatestDecisionTimesWithStrategy.outcomes;
    const waveId = wavesLatestDecisionTimesWithStrategy.wave_id;
    let decisionTime: number | null = strategy.first_decision_time;
    let subsequentDecisionPointer = 0;
    while (decisionTime !== null && decisionTime < currentMillis) {
      if (latestDecisionTime < decisionTime) {
        await this.createDecision({ waveId, decisionTime, outcomes }, ctx);
      }
      // calculate next decision time
      if (!subsequentDecisionsStrategy.length) {
        subsequentDecisionPointer = -1;
      } else if (is_rolling) {
        if (
          subsequentDecisionPointer ===
          subsequentDecisionsStrategy.length - 1
        ) {
          subsequentDecisionPointer = 0;
        } else {
          subsequentDecisionPointer++;
        }
      } else {
        if (
          subsequentDecisionPointer ===
          subsequentDecisionsStrategy.length - 1
        ) {
          subsequentDecisionPointer = -1;
        } else {
          subsequentDecisionPointer++;
        }
      }
      if (subsequentDecisionPointer === -1) {
        decisionTime = null;
      } else {
        decisionTime += subsequentDecisionsStrategy[subsequentDecisionPointer];
      }
      if (decisionTime === null || latestDecisionTime < decisionTime) {
        await this.waveDecisionsDb.updateWavesNextDecisionTime(
          waveId,
          decisionTime,
          ctx
        );
      }
    }
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
      await this.waveDecisionsDb.getTopNDropIdsForWave(waveId, n, ctx);
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
            let amount: number | null = null;
            if (outcome.amount) {
              const partAmount = outcomePart.amount ?? 0;
              amount = Math.floor(outcome.amount * (partAmount / 100));
            }
            return {
              type: outcome.type,
              subtype: outcome.subtype ?? null,
              description: `${outcome.description}${
                outcomePart.description ? `/ ${outcomePart.description}` : ''
              }`,
              credit: outcome.credit ?? null,
              rep_category: outcome.rep_category ?? null,
              amount: amount
            };
          }
        })
        .filter((prize) => prize !== null) as WaveDecisionWinnerPrize[];
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
