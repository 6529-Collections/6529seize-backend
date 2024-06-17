import { fetchLatestTDHBDate } from '../db';
import { getLastTDH } from '../helpers';
import { findNftTDH } from './nft_tdh';
import { updateTDH } from './tdh';
import { consolidateTDH } from './tdh_consolidation';
import { loadEnv, unload } from '../secrets';
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
import { Profile } from '../entities/IProfile';
import * as sentryContext from '../sentry.context';
import { NextGenTokenTDH } from '../entities/INextGen';
import { MemesSeason } from '../entities/ISeason';
import { NFTOwner } from '../entities/INFTOwner';
import { CommunityMember } from '../entities/ICommunityMember';
import { uploadTDH } from './tdh_upload';
import {
  ConsolidatedOwnerBalances,
  OwnerBalances
} from '../entities/IOwnerBalances';

const logger = Logger.get('TDH_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await loadEnv([
    TDH,
    ConsolidatedTDH,
    TDHMemes,
    ConsolidatedTDHMemes,
    NextGenTokenTDH,
    ConsolidatedTDHUpload,
    NFT,
    Profile,
    CommunityMember,
    MemesSeason,
    NFTOwner,
    NftTDH,
    OwnerBalances,
    ConsolidatedOwnerBalances,
    TDHBlock
  ]);
  const force = process.env.TDH_RESET == 'true';
  logger.info(`[RUNNING force=${force}]`);
  await tdhLoop(force);
  await unload();
  logger.info('[COMPLETE]');
});

export async function tdhLoop(force?: boolean) {
  await tdh(force);
  await findNftTDH();
  await uploadTDH(false, force);
  await uploadTDH(true, force);
  await notifier.notifyTdhCalculationsDone();
}

async function tdh(force?: boolean) {
  const lastTDHCalc = getLastTDH();

  const lastTdhDB = await fetchLatestTDHBDate();
  const lastTdhFromNow = lastTdhDB.diffFromNow();

  if (lastTdhFromNow.gt(Time.hours(24)) || force) {
    await updateTDH(lastTDHCalc);
    await consolidateTDH(lastTDHCalc);
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
  }
}
