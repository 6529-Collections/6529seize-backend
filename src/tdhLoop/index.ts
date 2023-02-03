import { fetchLatestTDHBDate } from '../db';
import { getHoursAgo, getLastTDH } from '../helpers';
import { findNftTDH } from '../nft_tdh';
import { findTDH } from '../tdh';
import { uploadTDH } from '../tdh_upload';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING TDH LOOP]');
  await loadEnv();
  await tdhLoop();
  console.log(new Date(), '[TDH LOOP COMPLETE]');
};

export async function tdhLoop() {
  await tdh();
  await findNftTDH();
  await uploadTDH();
}

async function tdh() {
  const lastTDHCalc = getLastTDH();

  const lastTdhDB = await fetchLatestTDHBDate();
  const hoursAgo = getHoursAgo(new Date(lastTdhDB));

  if (hoursAgo > 24) {
    await findTDH(lastTDHCalc);
  } else {
    console.log(
      new Date(),
      `[TDH]`,
      `[TODAY'S TDH ALREADY CALCULATED ${Math.floor(hoursAgo)} hrs ago]`,
      `[SKIPPING...]`
    );
  }
}
