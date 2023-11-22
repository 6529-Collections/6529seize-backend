import { fetchLatestTDHBDate } from '../db';
import { getLastTDH } from '../helpers';
import { findNftTDH } from '../nft_tdh';
import { findTDH } from '../tdh';
import { consolidateTDH } from '../tdh_consolidation';
import { uploadConsolidatedTDH, uploadTDH } from '../tdh_upload';
import { loadEnv, unload } from '../secrets';
import { ConsolidatedTDHUpload } from '../entities/IUpload';
import {
  ConsolidatedTDH,
  GlobalTDHHistory,
  TDH,
  TDHHistory
} from '../entities/ITDH';
import { NFT } from '../entities/INFT';
import { OwnerMetric } from '../entities/IOwner';
import * as notifier from '../notifier';
import { Logger } from '../logging';
import { Time } from '../time';

const logger = Logger.get('TDH_LOOP');

export const handler = async () => {
  await loadEnv([
    TDH,
    ConsolidatedTDH,
    ConsolidatedTDHUpload,
    NFT,
    OwnerMetric,
    TDHHistory,
    GlobalTDHHistory
  ]);
  const force = process.env.TDH_RESET == 'true';
  logger.info(`[RUNNING force=${force}]`);
  await tdhLoop(force);
  await unload();
  logger.info('[COMPLETE]');
};

export async function tdhLoop(force?: boolean) {
  await tdh(force);
  await findNftTDH();
  await uploadTDH(force);
  await uploadConsolidatedTDH(force);
  await notifier.notifyTdhCalculationsDone();
}

async function tdh(force?: boolean) {
  const lastTDHCalc = getLastTDH();

  const lastTdhDB = await fetchLatestTDHBDate();
  const lastTdhFromNow = lastTdhDB.diffFromNow();

  if (lastTdhFromNow.gt(Time.hours(24)) || force) {
    await findTDH(lastTDHCalc);
    await consolidateTDH(lastTDHCalc);
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
  }
}
