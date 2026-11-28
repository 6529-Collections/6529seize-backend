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
import { identityTdhSyncStateDb } from '../identity-tdh-sync-state.db';
import { uploadTDH } from './tdh_upload';
import { recordTdhMetrics } from './tdh-metrics';
import { appFeatures } from '@/app-features';
import { TdhChainDayEntity } from '@/entities/ITdhChainDay';
import { tdhChainDaysDb } from '@/tdhChain/tdh-chain-days.db';
import { sitePollerDeps } from '@/tdhChain/chain-tdh-ingest.deps';
import { pollChainDays } from '@/tdhChain/tdh-chain-day-poller';
import { refreshTdhChainSettings } from '@/tdhChain/tdh-chain-flags';

const logger = Logger.get('TDH_LOOP');
const ALERT_TITLE = 'TDH Loop';

/**
 * The daily 00:01 event computes 6529.io's own TDH day as before, in every
 * mode. With FEATURE_TDH_FROM_CHAIN on it is the fallback: the site has its
 * day on time whatever the chain does, and the chain's day replaces it, at
 * the same midnight block, once a `chainPoll` event can read and verify it.
 * The `chainPoll` events, every few minutes, read the 6529 chain's TDH days
 * when FEATURE_TDH_CHAIN_SHADOW or FEATURE_TDH_FROM_CHAIN is on, and do
 * nothing otherwise. One function, so the two never run at once.
 */
export const handler = sentryContext.wrapLambdaHandler(
  async (event?: { chainPoll?: boolean }) => {
    await doInDbContext(
      priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
        await refreshTdhChainSettings();
        if (event?.chainPoll) {
          await pollChainDays(sitePollerDeps());
          return;
        }
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
          HistoricConsolidatedTDH,
          TdhChainDayEntity
        ]
      }
    );
  }
);

export async function tdhLoop(force?: boolean) {
  const fromChain = appFeatures.isTdhFromChainEnabled();
  if (fromChain) {
    const today = Math.floor(Time.latestUtcMidnight().toMillis() / 86_400_000);
    if (await tdhChainDaysDb.chainWroteDay(today)) {
      // A retry or a manual run must not undo the chain's day.
      logger.info(
        `[TDH FROM THE 6529 CHAIN] [DAY ${today} IS THE CHAIN'S] [SKIPPING]`
      );
      return;
    }
    // The site's own day, interim until the chain's day replaces it: no
    // announcement and no dated uploads until the chain's write, or the
    // poller's own-day point 4 hours past the boundary.
    logger.info(
      `[TDH FROM THE 6529 CHAIN] [COMPUTING THE SITE'S OWN DAY ${today}, INTERIM]`
    );
  }
  const computed = await tdh(force, fromChain);
  await findNftTDH();
  if (fromChain) return;
  if (computed) {
    // The identities sync for this TDH runs in delegationsLoop, which
    // announces "TDH calculations done" once identities reflect it.
    logger.info(
      `[TDH CALCULATIONS DONE] [ANNOUNCED AFTER THE IDENTITIES SYNC]`
    );
    return;
  }
  if (await identityTdhSyncStateDb.hasPendingFullAnnouncement()) {
    logger.info(
      `[TDH CALCULATIONS DONE] [STILL WAITING FOR THE IDENTITIES SYNC]`
    );
    return;
  }
  await notifier.notifyTdhCalculationsDone();
}

/**
 * True when this run computed and wrote today's TDH. An interim day (TDH
 * from the 6529 chain) is written without its announcement or its uploads.
 */
async function tdh(force?: boolean, interim = false): Promise<boolean> {
  const lastTDHCalc = Time.latestUtcMidnight().toDate();

  const lastTdhDB = await fetchLatestTDHBDate();
  const lastTdhFromNow = lastTdhDB.timestamp.diffFromNow();

  if (lastTdhFromNow.gt(Time.hours(24)) || force) {
    const { block, blockTimestamp, tdh } = await updateTDH(lastTDHCalc);
    const consolidatedTdh = await consolidateAndPersistTDH(
      block,
      blockTimestamp,
      interim ? { mode: 'FULL', interim: true } : { mode: 'FULL' }
    );
    await recordTdhMetrics();
    if (interim) return true;
    await uploadTDH(block, blockTimestamp, tdh, false, true);
    await uploadTDH(block, blockTimestamp, consolidatedTdh, true, true);
    return true;
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
    return false;
  }
}
