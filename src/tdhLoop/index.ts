import { fetchLatestTDHBDate } from '../db';
import { NextGenTokenTDH } from '../entities/INextGen';
import { NFT } from '../entities/INFT';
import { NFTOwner } from '../entities/INFTOwner';
import {
  ConsolidatedOwnerBalances,
  OwnerBalances
} from '../entities/IOwnerBalances';
import { MemesSeason } from '../entities/ISeason';
import {
  ConsolidatedTDH,
  ConsolidatedTDHEditions,
  ConsolidatedTDHMemes,
  HistoricConsolidatedTDH,
  NftTDH,
  TDH,
  TDHBlock,
  TDHEditions,
  TDHMemes
} from '../entities/ITDH';
import { ConsolidatedTDHUpload } from '../entities/IUpload';
import { DROP_VOTER_STATE_TABLE } from '../constants';
import { env } from '../env';
import { Logger } from '../logging';
import { metricsRecorder } from '../metrics/MetricsRecorder';
import { numbers } from '../numbers';
import * as notifier from '../notifier';
import * as priorityAlertsContext from '../priority-alerts.context';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { dbSupplier } from '../sql-executor';
import { Time } from '../time';
import { findNftTDH } from './nft_tdh';
import { updateTDH } from './tdh';
import { consolidateAndPersistTDH } from './tdh_consolidation';
import { uploadTDH } from './tdh_upload';

const logger = Logger.get('TDH_LOOP');
const ALERT_TITLE = 'TDH Loop';

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
      const force = process.env.TDH_RESET == 'true';
      logger.info(`[force=${force}]`);
      await tdhLoop(force);
    }),
    {
      logger,
      entities: [
        TDH,
        ConsolidatedTDH,
        TDHMemes,
        ConsolidatedTDHMemes,
        NextGenTokenTDH,
        ConsolidatedTDHUpload,
        NFT,
        MemesSeason,
        NFTOwner,
        NftTDH,
        OwnerBalances,
        ConsolidatedOwnerBalances,
        TDHBlock,
        TDHEditions,
        ConsolidatedTDHEditions,
        HistoricConsolidatedTDH
      ]
    }
  );
});

export async function tdhLoop(force?: boolean) {
  await tdh(force);
  await findNftTDH();
  await notifier.notifyTdhCalculationsDone();
}

async function recordMetrics() {
  const mainStageWaveId = env.getStringOrNull(`MAIN_STAGE_WAVE_ID`);
  if (mainStageWaveId) {
    const totalVotes = await dbSupplier().oneOrNull<{
      total_votes: number;
    }>(
      `select sum(abs(votes)) as total_votes from ${DROP_VOTER_STATE_TABLE} where wave_id = :wave_id`,
      { wave_id: mainStageWaveId }
    );
    const tdhOnMainStageSubmissions = numbers.parseNumberOrThrow(
      totalVotes?.total_votes ?? 0
    );
    await metricsRecorder.recordTdhOnMainStageSubmissions(
      { tdhOnMainStageSubmissions },
      {}
    );
    const consolidationsFormedRow = await dbSupplier().oneOrNull<{
      cnt: number;
    }>(
      `select count(*) as cnt from tdh_consolidation where consolidation_key like ('%-%')`
    );
    const consolidationsFormed = numbers.parseNumberOrThrow(
      consolidationsFormedRow?.cnt ?? 0
    );
    await metricsRecorder.recordConsolidationsFormed(
      { consolidationsFormed },
      {}
    );
  }
}

async function tdh(force?: boolean) {
  const lastTDHCalc = Time.latestUtcMidnight().toDate();

  const lastTdhDB = await fetchLatestTDHBDate();
  const lastTdhFromNow = lastTdhDB.timestamp.diffFromNow();

  if (lastTdhFromNow.gt(Time.hours(24)) || force) {
    const { block, blockTimestamp } = await updateTDH(lastTDHCalc);
    const consolidatedTdh = await consolidateAndPersistTDH(
      block,
      blockTimestamp
    );
    await recordMetrics();
    // Disabled for now
    // await uploadTDH(block, blockTimestamp, tdh, false, true);
    await uploadTDH(block, blockTimestamp, consolidatedTdh, true, true);
    return block;
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
    return lastTdhDB.block;
  }
}
