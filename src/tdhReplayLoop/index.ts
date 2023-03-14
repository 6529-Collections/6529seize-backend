import { fetchTdhReplayTimestamp } from '../db';
import { findTDH } from './tdh_replay';
import { uploadTDH } from './tdh_replay_upload';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING TDH REPLAY LOOP]');
  await loadEnv();
  await tdhLoop();
  await unload();
  console.log(new Date(), '[TDH REPLAY LOOP COMPLETE]');
};

export async function tdhLoop() {
  const tdhResponse = await tdh();
  if (tdhResponse) {
    await uploadTDH(tdhResponse);
  }
}

async function tdh() {
  let tdhDate: Date = new Date(Date.UTC(2023, 1, 23));
  const replayLatest = await fetchTdhReplayTimestamp(tdhDate);

  if (replayLatest) {
    console.log(`[REPLAY LATEST ${replayLatest}]`);
    const previousDate: Date = new Date(new Date(replayLatest).getTime());
    previousDate.setUTCHours(0, 0, 0, 0);
    tdhDate = previousDate;
  }

  if (new Date(Date.UTC(2021, 9, 5)) > tdhDate) {
    console.log('[TDH EXHAUSTED]');
    return;
  }

  const response = await findTDH(tdhDate);
  return { tdhDate, ...response };
}
