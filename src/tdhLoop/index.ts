import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  DROP_VOTER_STATE_TABLE,
  IDENTITIES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE
} from '@/constants';
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
import { env } from '../env';
import { Logger } from '../logging';
import { metricsRecorder } from '../metrics/MetricsRecorder';
import * as notifier from '../notifier';
import { numbers } from '../numbers';
import * as priorityAlertsContext from '../priority-alerts.context';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { dbSupplier } from '../sql-executor';
import { Time } from '../time';
import { findNftTDH } from './nft_tdh';
import { updateTDH } from './tdh';
import { consolidateAndPersistTDH } from './tdh_consolidation';
import { uploadTDH } from './tdh_upload';
import { isMembershipSourceTrackingActive } from '@/membership/membership-producer-policy';
import {
  checkpointMembershipTdhInputs,
  failMembershipTdhCycle,
  findActiveMembershipTdhCycle,
  getMembershipTdhCycleState,
  membershipTdhCycleCalculationDate,
  membershipTdhCycleId,
  startMembershipTdhCycle
} from '@/membership/membership-tdh-cycle';

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
  const result = await tdh(force);
  if (isMembershipSourceTrackingActive() && !result.cycleId) return;
  if (result.sourceWritesNeeded || !isMembershipSourceTrackingActive()) {
    try {
      await findNftTDH();
      if (result.cycleId) await checkpointMembershipTdhInputs(result.cycleId);
    } catch (error) {
      if (result.cycleId) await failMembershipTdhCycle(result.cycleId);
      throw error;
    }
  }
  await notifier.notifyTdhCalculationsDone(result.cycleId ?? undefined);
}

async function recordMetrics() {
  const mainStageWaveId = env.getStringOrNull(`MAIN_STAGE_WAVE_ID`);
  if (mainStageWaveId) {
    const db = dbSupplier();
    await Promise.all([
      db
        .oneOrNull<{
          total_votes: number;
        }>(
          `
            select sum(abs(votes)) as total_votes
            from ${DROP_VOTER_STATE_TABLE} v
            left join ${WAVES_DECISION_WINNER_DROPS_TABLE} w on w.drop_id = v.drop_id
            where v.wave_id = :wave_id and w.drop_id is null
          `,
          { wave_id: mainStageWaveId }
        )
        .then(async (totalVotes) => {
          const tdhOnMainStageSubmissions = numbers.parseNumberOrThrow(
            totalVotes?.total_votes ?? 0
          );
          await metricsRecorder.recordTdhOnMainStageSubmissions(
            { tdhOnMainStageSubmissions },
            {}
          );
        }),
      db
        .oneOrNull<{
          cnt: number;
        }>(
          `select count(*) as cnt from ${CONSOLIDATED_WALLETS_TDH_TABLE} where consolidation_key like ('%-%')`
        )
        .then(async (consolidationsFormedRow) => {
          const consolidationsFormed = numbers.parseNumberOrThrow(
            consolidationsFormedRow?.cnt ?? 0
          );
          await metricsRecorder.recordConsolidationsFormed(
            { consolidationsFormed },
            {}
          );
        }),
      db
        .oneOrNull<{
          cnt: number;
        }>(
          `select count(*) as cnt from ${IDENTITIES_TABLE} where normalised_handle is not null and normalised_handle not like 'id-0x%'`
        )
        .then(async (profileCountRow) => {
          const profileCount = numbers.parseNumberOrThrow(
            profileCountRow?.cnt ?? 0
          );
          await metricsRecorder.recordProfileCount({ profileCount }, {});
        })
    ]);
  }
}

async function resolveTdhSourceCycle(
  calculationDate: Date,
  force: boolean | undefined,
  tracking: boolean
) {
  if (!tracking) return { active: null, cycleId: null, prior: null };
  const active = await findActiveMembershipTdhCycle();
  if (active && !active.cycleId.startsWith('tdh-full:'))
    throw new Error('Another tracked TDH source cycle is still active');
  const cycleId =
    active?.cycleId ??
    membershipTdhCycleId('tdh-full', [
      calculationDate.toISOString(),
      force ? 'force' : 'daily'
    ]);
  const prior = active?.state ?? (await getMembershipTdhCycleState(cycleId));
  return { active, cycleId, prior };
}

async function tdh(force?: boolean): Promise<{
  block: number;
  cycleId: string | null;
  sourceWritesNeeded: boolean;
}> {
  const lastTDHCalc = Time.latestUtcMidnight().toDate();

  const lastTdhDB = await fetchLatestTDHBDate();
  const lastTdhFromNow = lastTdhDB.timestamp.diffFromNow();

  const tracking = isMembershipSourceTrackingActive();
  const { active, cycleId, prior } = await resolveTdhSourceCycle(
    lastTDHCalc,
    force,
    tracking
  );
  if (tracking && prior?.status === 'COMPLETED')
    return { block: lastTdhDB.block, cycleId: null, sourceWritesNeeded: false };
  const due = lastTdhFromNow.gt(Time.hours(24)) || !!force;
  if (!due && !prior && tracking)
    return { block: lastTdhDB.block, cycleId: null, sourceWritesNeeded: false };
  if (prior && prior.progress.stage !== 'STARTED')
    return { block: lastTdhDB.block, cycleId, sourceWritesNeeded: false };
  if (due || prior) {
    if (cycleId) await startMembershipTdhCycle(cycleId);
    try {
      const calculationDate = active
        ? membershipTdhCycleCalculationDate(active.cycleId)
        : lastTDHCalc;
      const { block, blockTimestamp, tdh } = await updateTDH(calculationDate);
      const consolidatedTdh = await consolidateAndPersistTDH(
        block,
        blockTimestamp,
        { mode: 'FULL' }
      );
      await recordMetrics();
      await uploadTDH(block, blockTimestamp, tdh, false, true);
      await uploadTDH(block, blockTimestamp, consolidatedTdh, true, true);
      return { block, cycleId, sourceWritesNeeded: true };
    } catch (error) {
      if (cycleId) await failMembershipTdhCycle(cycleId);
      throw error;
    }
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
    return { block: lastTdhDB.block, cycleId: null, sourceWritesNeeded: false };
  }
}
