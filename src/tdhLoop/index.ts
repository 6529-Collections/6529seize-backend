import { fetchLatestTDHBDate } from '../db';
import { getLastTDH } from '../helpers';
import { findNftTDH } from './nft_tdh';
import { updateTDH } from './tdh';
import { consolidateTDH } from './tdh_consolidation';
import { ConsolidatedTDHUpload } from '../entities/IUpload';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  NftTDH,
  TDH,
  TDHBlock,
  TDHMemes
} from '../entities/ITDH';
import { NFT } from '../entities/INFT';
import * as notifier from '../notifier';
import { Logger } from '../logging';
import { Time } from '../time';
import * as sentryContext from '../sentry.context';
import { NextGenTokenTDH } from '../entities/INextGen';
import { MemesSeason } from '../entities/ISeason';
import { NFTOwner } from '../entities/INFTOwner';
import { uploadTDH } from './tdh_upload';
import {
  ConsolidatedOwnerBalances,
  OwnerBalances
} from '../entities/IOwnerBalances';
import { doInDbContext } from '../secrets';

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
        TDHBlock
      ]
    }
  );
});

export async function tdhLoop(force?: boolean) {
  // const block = await tdh(force);
  await findNftTDH();
  // await uploadTDH(block, false, force);
  // await uploadTDH(block, true, force);
  // await notifier.notifyTdhCalculationsDone();
}

async function tdh(force?: boolean) {
  const lastTDHCalc = getLastTDH();

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
