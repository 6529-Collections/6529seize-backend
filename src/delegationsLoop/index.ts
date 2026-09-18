import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import {
  NFTDELEGATION_BLOCKS_TABLE,
  USE_CASE_PRIMARY_ADDRESS
} from '@/constants';
import {
  fetchAllConsolidatedTdh,
  fetchLatestNftDelegationBlock,
  hasConsolidationsFromBlock,
  persistConsolidations,
  persistDelegations,
  persistNftDelegationBlock
} from '../db';
import { findDelegationTransactions } from '../delegations';
import { discoverEnsConsolidations, discoverEnsDelegations } from '../ens';
import {
  AggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivity,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import {
  Consolidation,
  ConsolidationEvent,
  Delegation,
  DelegationEvent,
  NFTDelegationBlock
} from '../entities/IDelegation';
import { NextGenTokenTDH } from '../entities/INextGen';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
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
import { Logger } from '../logging';
import { consolidateNftOwners } from '../nftOwnersLoop/nft_owners';
import { consolidateOwnerBalances } from '../ownersBalancesLoop/owners_balances';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { consolidateSubscriptions } from '../subscriptionsDaily/subscriptions';
import { updateTDH } from '../tdhLoop/tdh';
import {
  consolidateAndPersistTDH,
  enqueuePartialTdhUniverseRecalculation
} from '../tdhLoop/tdh_consolidation';
import { isMembershipSourceTrackingActive } from '@/membership/membership-producer-policy';
import {
  checkpointMembershipTdhInputs,
  failMembershipTdhCycle,
  findActiveMembershipTdhCycle,
  getMembershipTdhCycleState,
  membershipTdhCycleId,
  startMembershipTdhCycle
} from '@/membership/membership-tdh-cycle';
import { membershipQueryOptions } from '@/membership/membership-primary';
import { dbSupplier } from '@/sql-executor';
import { Time } from '../time';
import { getAffectedWallets } from './reconsolidation';

const logger = Logger.get('DELEGATIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const startBlockEnv = process.env.DELEGATIONS_RESET_BLOCK;
      const startBlock =
        startBlockEnv && Number.isInteger(Number(startBlockEnv))
          ? parseInt(startBlockEnv, 10)
          : undefined;

      logger.info(`[START_BLOCK ${startBlock}]`);
      const active = isMembershipSourceTrackingActive()
        ? await findActiveMembershipTdhCycle()
        : null;
      if (
        active &&
        !active.cycleId.startsWith('delegation:') &&
        !active.cycleId.startsWith('delegation-no-ownership:')
      )
        throw new Error('Another tracked TDH source cycle is still active');
      if (active?.state.progress.stage === 'STARTED')
        // Consolidation registrations/revocations are procedural writes. A
        // crashed attempt may have removed a row from before startBlock, so
        // replaying that suffix cannot prove the same result. Keep the source
        // barrier until an operator rebuilds and repairs the cycle.
        throw new Error(
          'Incomplete delegation source inputs require operator repair'
        );
      const effectiveStartBlock =
        startBlock ?? (await fetchLatestNftDelegationBlock());
      if (!isMembershipSourceTrackingActive()) {
        const response = await handleDelegations(effectiveStartBlock);
        await persistNftDelegationBlock(
          response.block,
          response.blockTimestamp
        );
        return;
      }
      // Read the chain before claiming a source job so a no-consolidation
      // cycle never holds OWNERSHIP while the independent NFT owner loop runs.
      // The chosen response is also the one persisted under that job.
      const pending = active
        ? null
        : await findNewDelegations(effectiveStartBlock);
      // The source range is inclusive. A chain reorg can remove an earlier
      // consolidation even when the new response has no events, so deleting
      // its old row must still retain the ownership barrier.
      const touchesConsolidations = pending
        ? pending.consolidations.length > 0 ||
          (await hasConsolidationsFromBlock(effectiveStartBlock))
        : false;
      const cycleId =
        active?.cycleId ??
        membershipTdhCycleId(
          touchesConsolidations ? 'delegation' : 'delegation-no-ownership',
          [effectiveStartBlock]
        );
      const existing =
        active?.state ?? (await getMembershipTdhCycleState(cycleId));
      if (existing?.status === 'COMPLETED') return;
      const state = await startMembershipTdhCycle(cycleId);
      if (state?.progress.stage === 'STARTED') {
        try {
          const response = await handleDelegations(
            effectiveStartBlock,
            pending!
          );
          await checkpointMembershipTdhInputs(cycleId, {}, async (primary) => {
            await dbSupplier().execute(
              `INSERT INTO ${NFTDELEGATION_BLOCKS_TABLE} (block, timestamp)
               VALUES (:block, :timestamp)
               ON DUPLICATE KEY UPDATE timestamp = VALUES(timestamp)`,
              { block: response.block, timestamp: response.blockTimestamp },
              membershipQueryOptions(primary)
            );
          });
        } catch (error) {
          await failMembershipTdhCycle(cycleId);
          throw error;
        }
      }
      await enqueuePartialTdhUniverseRecalculation(cycleId);
    },
    {
      logger,
      entities: [
        Delegation,
        Consolidation,
        NFTDelegationBlock,
        TDH,
        ConsolidatedTDH,
        HistoricConsolidatedTDH,
        NextGenTokenTDH,
        TDHMemes,
        ConsolidatedTDHMemes,
        MemesSeason,
        NFTOwner,
        ConsolidatedNFTOwner,
        OwnerBalances,
        OwnerBalancesMemes,
        ConsolidatedOwnerBalances,
        ConsolidatedOwnerBalancesMemes,
        AggregatedActivity,
        ConsolidatedAggregatedActivity,
        AggregatedActivityMemes,
        ConsolidatedAggregatedActivityMemes,
        NftTDH,
        TDHBlock,
        TDHEditions,
        ConsolidatedTDHEditions
      ]
    }
  );
});

async function handleDelegations(
  startBlock: number | undefined,
  prefetched?: Awaited<ReturnType<typeof findNewDelegations>>
) {
  const delegationsResponse =
    prefetched ?? (await findNewDelegations(startBlock));
  await persistConsolidations(startBlock, delegationsResponse.consolidations);
  await persistDelegations(
    startBlock,
    delegationsResponse.registrations,
    delegationsResponse.revocation
  );

  await handleENS();

  if (delegationsResponse.consolidations.length > 0) {
    await reconsolidateWallets(delegationsResponse.consolidations);
  }

  const primaryAddressEvents = [
    ...delegationsResponse.registrations,
    ...delegationsResponse.revocation
  ].filter((e) => e.use_case === USE_CASE_PRIMARY_ADDRESS);
  await updatePrimaryAddresses(primaryAddressEvents);

  return delegationsResponse;
}

async function handleENS() {
  await discoverEnsDelegations();
  await discoverEnsConsolidations();
}

async function findNewDelegations(
  startingBlock?: number,
  latestBlock?: number
): Promise<{
  block: number;
  blockTimestamp: number;
  consolidations: ConsolidationEvent[];
  registrations: DelegationEvent[];
  revocation: DelegationEvent[];
}> {
  try {
    if (startingBlock == undefined) {
      startingBlock = await fetchLatestNftDelegationBlock();
    }

    logger.info(`[STARTING BLOCK ${startingBlock}]`);

    const response = await findDelegationTransactions(
      startingBlock,
      latestBlock
    );

    return {
      block: response.latestBlock,
      blockTimestamp: response.latestBlockTimestamp,
      consolidations: response.consolidations,
      registrations: response.registrations,
      revocation: response.revocation
    };
  } catch (e: any) {
    logger.error(`[ETIMEDOUT!] [RETRYING PROCESS] [${e}]`);
    return await findNewDelegations(startingBlock, latestBlock);
  }
}

async function reconsolidateWallets(events: ConsolidationEvent[]) {
  const currentConsolidations = await fetchAllConsolidatedTdh();
  const affectedWallets = await getAffectedWallets(
    events,
    currentConsolidations
  );

  if (affectedWallets.size > 0) {
    logger.info(
      `[RECONSOLIDATING FOR ${affectedWallets.size} DISTINCT WALLETS]`
    );

    const lastTDHCalc = Time.latestUtcMidnight().toDate();
    const walletsArray = Array.from(affectedWallets);

    const { block, blockTimestamp } = await updateTDH(
      lastTDHCalc,
      walletsArray
    );
    // Keep the pre-update snapshot for old-membership discovery, but use a
    // fresh snapshot to choose the exact rows replaced during persistence.
    const replacementConsolidations = await fetchAllConsolidatedTdh();
    await consolidateAndPersistTDH(block, blockTimestamp, {
      mode: 'PARTIAL',
      wallets: walletsArray,
      currentConsolidatedTdh: replacementConsolidations
    });
    await consolidateNftOwners(affectedWallets);
    await consolidateOwnerBalances(affectedWallets);
    await consolidateActivity(affectedWallets);
    await consolidateSubscriptions(affectedWallets);
  } else {
    logger.info(`[NO WALLETS TO RECONSOLIDATE]`);
  }
}

async function updatePrimaryAddresses(events: DelegationEvent[]) {
  const wallets = new Set<string>();
  events.forEach((c) => {
    wallets.add(c.wallet1.toLowerCase());
  });

  await identitiesService.updatePrimaryAddresses(wallets, 'delegations-cycle');
  logger.info(`[UPDATED PRIMARY ADDRESSES FOR ${wallets.size} WALLETS]`);
}
