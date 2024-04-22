import { fetchLatestTDHBDate } from '../db';
import { getLastTDH } from '../helpers';
import { updateTDH } from './tdh';
import { consolidateTDH } from './tdh_consolidation';
import { loadEnv, unload } from '../secrets';
import { ConsolidatedTDHUpload } from '../entities/IUpload';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  GlobalTDHHistory,
  NftTDH,
  TDH,
  TDHBlock,
  TDHHistory,
  TDHMemes
} from '../entities/ITDH';
import { NFT } from '../entities/INFT';
import { Logger } from '../logging';
import { Time } from '../time';
import { Profile } from '../entities/IProfile';
import { MemesSeason } from '../entities/ISeason';
import { NFTOwner } from '../entities/INFTOwner';
import { CommunityMember } from '../entities/ICommunityMember';
import {
  ConsolidatedOwnerBalances,
  OwnerBalances
} from '../entities/IOwnerBalances';

const logger = Logger.get('TDH_LOOP');

export const handler = async () => {
  await loadEnv([
    TDH,
    ConsolidatedTDH,
    TDHMemes,
    ConsolidatedTDHMemes,
    ConsolidatedTDHUpload,
    NFT,
    TDHHistory,
    GlobalTDHHistory,
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
  await tdh(force);
  await unload();
  logger.info('[COMPLETE]');
};

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
