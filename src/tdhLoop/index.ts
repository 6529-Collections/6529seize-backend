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
import { Logger } from '../logging';
import * as notifier from '../notifier';
import * as priorityAlertsContext from '../priority-alerts.context';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { Time } from '../time';
import { findNftTDH } from './nft_tdh';
import { updateTDH } from './tdh';
import { consolidateAndPersistTDH } from './tdh_consolidation';
// TODO: add back in when ready
// import { uploadTDH } from './tdh_upload';

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
    // Disabled for now
    // await uploadTDH(block, blockTimestamp, tdh, false, true);
    // TODO: add back in when ready
    // await uploadTDH(block, blockTimestamp, consolidatedTdh, true, true);
    return block;
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
    return lastTdhDB.block;
  }
}
