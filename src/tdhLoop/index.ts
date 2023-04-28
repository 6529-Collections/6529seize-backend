import { fetchLatestTDHBDate } from '../db';
import { getHoursAgo, getLastTDH } from '../helpers';
import { findNftTDH } from '../nft_tdh';
import { findTDH } from '../tdh';
import { consolidateTDH } from '../tdh_consolidation';
import { uploadTDH } from '../tdh_upload';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING TDH LOOP]');
  await loadEnv();
  await tdhLoop();
  await unload();
  console.log(new Date(), '[TDH LOOP COMPLETE]');
};

export async function tdhLoop(force?: boolean) {
  await tdh(force);
  await findNftTDH();
  await uploadTDH(force);
}

async function tdh(force?: boolean) {
  const lastTDHCalc = getLastTDH();

  const lastTdhDB = await fetchLatestTDHBDate();
  const hoursAgo = getHoursAgo(new Date(lastTdhDB));

  if (hoursAgo > 24 || force) {
    await findTDH(lastTDHCalc);
    await consolidateTDH(lastTDHCalc);
  } else {
    console.log(
      new Date(),
      `[TDH]`,
      `[TODAY'S TDH ALREADY CALCULATED ${Math.floor(hoursAgo)} hrs ago]`,
      `[SKIPPING...]`
    );
  }
}
