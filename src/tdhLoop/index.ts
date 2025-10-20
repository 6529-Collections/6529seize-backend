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
  NftTDH,
  TDH,
  TDHBlock,
  TDHEditions,
  TDHMemes
} from '../entities/ITDH';
import { ConsolidatedTDHUpload } from '../entities/IUpload';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { Time } from '../time';
import { updateTDH } from './tdh';
import { consolidateTDH } from './tdh_consolidation';

const logger = Logger.get('TDH_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const force = process.env.TDH_RESET == 'true';
      logger.info(`[force=${force}]`);
      await tdhLoop(force);
    },
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
        ConsolidatedTDHEditions
      ]
    }
  );
});

export async function tdhLoop(force?: boolean) {
  const block = await tdh(force);
  // await findNftTDH();
  // await uploadTDH(block, false, force);
  // await uploadTDH(block, true, force);
  // await notifier.notifyTdhCalculationsDone();
}

async function tdh(force?: boolean) {
  const lastTDHCalc = Time.latestUtcMidnight().toDate();

  const lastTdhDB = await fetchLatestTDHBDate();
  const lastTdhFromNow = lastTdhDB.timestamp.diffFromNow();

  if (lastTdhFromNow.gt(Time.hours(24)) || force) {
    const { block, timestamp } = await updateTDH(lastTDHCalc);
    await consolidateTDH(lastTDHCalc, block, timestamp);
    return block;
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
    return lastTdhDB.block;
  }
}
