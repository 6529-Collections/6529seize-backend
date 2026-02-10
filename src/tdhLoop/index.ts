import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  DROP_VOTER_STATE_TABLE,
  IDENTITIES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE
} from '@/constants';
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
import { env } from '../env';
import { Logger } from '../logging';
import { metricsRecorder } from '../metrics/MetricsRecorder';
import * as notifier from '../notifier';
import { numbers } from '../numbers';
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
    const db = dbSupplier();
    await Promise.all([
      db
        .oneOrNull<{
          total_votes: number;
        }>(
          `
            select sum(abs(votes)) as total_votes
            from ${DROP_VOTER_STATE_TABLE} v
            left join ${WAVES_DECISION_WINNER_DROPS_TABLE} w on w.drop_id = v.drop_id
            where v.wave_id = :wave_id and w.drop_id is null
          `,
          { wave_id: mainStageWaveId }
        )
        .then(async (totalVotes) => {
          const tdhOnMainStageSubmissions = numbers.parseNumberOrThrow(
            totalVotes?.total_votes ?? 0
          );
          await metricsRecorder.recordTdhOnMainStageSubmissions(
            { tdhOnMainStageSubmissions },
            {}
          );
        }),
      db
        .oneOrNull<{
          cnt: number;
        }>(
          `select count(*) as cnt from ${CONSOLIDATED_WALLETS_TDH_TABLE} where consolidation_key like ('%-%')`
        )
        .then(async (consolidationsFormedRow) => {
          const consolidationsFormed = numbers.parseNumberOrThrow(
            consolidationsFormedRow?.cnt ?? 0
          );
          await metricsRecorder.recordConsolidationsFormed(
            { consolidationsFormed },
            {}
          );
        }),
      db
        .oneOrNull<{
          cnt: number;
        }>(
          `select count(*) as cnt from ${IDENTITIES_TABLE} where normalised_handle is not null and normalised_handle not like 'id-0x%'`
        )
        .then(async (profileCountRow) => {
          const profileCount = numbers.parseNumberOrThrow(
            profileCountRow?.cnt ?? 0
          );
          await metricsRecorder.recordProfileCount({ profileCount }, {});
        })
    ]);
  }
}

async function tdh(force?: boolean) {
  const lastTDHCalc = Time.latestUtcMidnight().toDate();

  const lastTdhDB = await fetchLatestTDHBDate();
  const lastTdhFromNow = lastTdhDB.timestamp.diffFromNow();

  if (lastTdhFromNow.gt(Time.hours(24)) || force) {
    const { block, blockTimestamp, tdh } = await updateTDH(lastTDHCalc);
    const consolidatedTdh = await consolidateAndPersistTDH(
      block,
      blockTimestamp
    );
    await recordMetrics();
    await uploadTDH(block, blockTimestamp, tdh, false, true);
    await uploadTDH(block, blockTimestamp, consolidatedTdh, true, true);
    return block;
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
    return lastTdhDB.block;
  }
}
