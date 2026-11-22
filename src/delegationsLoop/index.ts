import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import { USE_CASE_PRIMARY_ADDRESS } from '@/constants';
import {
  fetchAllConsolidatedTdh,
  fetchLatestNftDelegationBlock,
  persistConsolidations,
  persistDelegations,
  persistNftDelegationBlock,
  persistNftDelegationLogsAfterFreeze
} from '../db';
import {
  fetchBlockTimestamp,
  fetchDelegationChainHead,
  findDelegationTransactions,
  scanDelegationLogsForRecord
} from '../delegations';
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
  NFTDelegationBlock,
  NFTDelegationLogAfterFreeze
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
import { consolidateAndPersistTDH } from '../tdhLoop/tdh_consolidation';
import { Time } from '../time';
import { createScopeBackfillDeps } from './delegation-scope-backfill.deps';
import {
  readScopeBackfillConfig,
  runDelegationScopeBackfill
} from './delegation-scope-backfill';
import {
  getAffectedWallets,
  getAffectedWalletsForAddresses
} from './reconsolidation';
import { readReconsolidationAction } from './reconsolidation-action';
import { DelegationsLoopHealth } from './delegations-loop-health';
import { collectGarbageAfter } from './heap-release';
import {
  NftDelegationFreeze,
  readNftDelegationFreeze,
  resolveFreezeBlock,
  splitAtFreeze
} from './nftdelegation-freeze';
import {
  resumePendingIdentityTdhSync,
  startIdentitySyncBudget
} from '../identity-tdh-sync';

const logger = Logger.get('DELEGATIONS_LOOP');

/**
 * Whether this invocation reconsolidated wallets, or resumed an identities
 * sync (the nightly full walk among them), so its end collects the run's
 * garbage (a sandbox runs one invocation at a time).
 */
let reconsolidated = false;
let identitiesSynced = false;

export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown) => {
    const requestedWallets = readReconsolidationAction(event);
    reconsolidated = false;
    identitiesSynced = false;
    try {
      return await doInDbContext(
        async () => {
          // Every identities sync in this invocation shares one time budget.
          startIdentitySyncBudget();
          const scopeBackfill = readScopeBackfillConfig();
          // Read before any work: a freeze setting that can't be read stops
          // the run rather than apply events past the freeze.
          const freeze = readNftDelegationFreeze();
          if (scopeBackfill && freeze.kind !== 'NONE') {
            throw new Error(
              'The scope backfill rewrites delegations up to the last processed block: remove its flag while NFTDelegation is frozen'
            );
          }
          if (requestedWallets) {
            if (scopeBackfill) {
              throw new Error(
                'Remove the scope backfill flag before reconsolidating'
              );
            }
            const health = await DelegationsLoopHealth.start(true);
            try {
              const result = await reconsolidateRequestedWallets(
                requestedWallets,
                health
              );
              health.completed();
              return result;
            } catch (error) {
              health.failed();
              throw error;
            }
          }
          if (scopeBackfill) {
            // One-off delegations re-index: it runs instead of the loop, writes
            // only non-consolidation delegation rows and leaves the checkpoint
            // alone. Remove the flag after one run.
            await runDelegationScopeBackfill(
              scopeBackfill,
              createScopeBackfillDeps()
            );
            return;
          }

          const startBlockEnv = process.env.DELEGATIONS_RESET_BLOCK;
          const startBlock =
            startBlockEnv && Number.isInteger(Number(startBlockEnv))
              ? parseInt(startBlockEnv, 10)
              : undefined;

          logger.info(`[START_BLOCK ${startBlock}]`);
          // Delegations first; then finish any identities sync left pending (a
          // tdhLoop full write, a deferred full walk, a spent budget), within
          // what is left of the invocation's sync budget.
          await thenResumePendingIdentitySync(async () => {
            const health = await DelegationsLoopHealth.start(false);
            const delegationsResponse =
              freeze.kind === 'NONE'
                ? await handleDelegations(startBlock, health)
                : await handleDelegationsWithFreeze(startBlock, freeze, health);
            await persistNftDelegationBlock(
              delegationsResponse.block,
              delegationsResponse.blockTimestamp
            );
            health.completed(delegationsResponse.blockTimestamp);
          });
        },
        {
          logger,
          entities: [
            Delegation,
            Consolidation,
            NFTDelegationBlock,
            NFTDelegationLogAfterFreeze,
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
    } finally {
      if (reconsolidated) collectGarbageAfter('RECONSOLIDATION');
      else if (identitiesSynced) collectGarbageAfter('IDENTITIES SYNC');
    }
  }
);

/**
 * Runs the delegations work, then the pending identities sync, also when the
 * work fails. The work's error wins: a resume failure after it is only
 * logged.
 */
async function thenResumePendingIdentitySync(
  work: () => Promise<void>
): Promise<void> {
  try {
    await work();
  } catch (error) {
    try {
      identitiesSynced = await resumePendingIdentityTdhSync();
    } catch (resumeError) {
      logger.error(
        `[IDENTITIES SYNC RESUME FAILED AFTER A FAILED RUN] ${resumeError}`
      );
    }
    throw error;
  }
  identitiesSynced = await resumePendingIdentityTdhSync();
}

async function handleDelegations(
  startBlock: number | undefined,
  health: DelegationsLoopHealth
) {
  // Read the reset block's time before scanning, so a failed lookup ends the
  // run before the scan rather than after it.
  const resetBlockTimestamp = startBlock
    ? await fetchBlockTimestamp(startBlock)
    : undefined;
  const delegationsResponse = await findNewDelegations(startBlock);
  await persistConsolidations(
    startBlock,
    delegationsResponse.consolidations,
    resetBlockTimestamp
  );
  await persistDelegations(
    startBlock,
    delegationsResponse.registrations,
    delegationsResponse.revocation
  );
  if (
    delegationsResponse.consolidations.length ||
    delegationsResponse.registrations.length ||
    delegationsResponse.revocation.length
  )
    health.committedStage();

  await handleENS();

  if (delegationsResponse.consolidations.length > 0) {
    await reconsolidateWallets(delegationsResponse.consolidations, health);
  }

  const primaryAddressEvents = [
    ...delegationsResponse.registrations,
    ...delegationsResponse.revocation
  ].filter((e) => e.use_case === USE_CASE_PRIMARY_ADDRESS);
  await updatePrimaryAddresses(primaryAddressEvents);

  return delegationsResponse;
}

/**
 * The delegations run while NFTDelegation is frozen for the move of
 * identities to the 6529 chain (nftdelegation-freeze.ts): events up to the
 * freeze block are applied exactly as handleDelegations applies them; events
 * after it are stored for the record and applied to nothing. The checkpoint
 * still moves to the head, so the loop keeps reading forward.
 */
async function handleDelegationsWithFreeze(
  startBlock: number | undefined,
  freeze: NftDelegationFreeze,
  health: DelegationsLoopHealth
): Promise<{ block: number; blockTimestamp: number }> {
  const resetBlockTimestamp = startBlock
    ? await fetchBlockTimestamp(startBlock)
    : undefined;
  const start = startBlock ?? (await fetchLatestNftDelegationBlock());
  const head = await fetchDelegationChainHead();
  const freezeBlock = await resolveFreezeBlock(freeze, head, (block) =>
    fetchBlockTimestamp(block)
  );
  const { apply, record } = splitAtFreeze(start, head.block, freezeBlock);
  logger.info(
    `[NFTDELEGATION FREEZE ${freeze.kind}] [FREEZE BLOCK ${freezeBlock}] [START ${start}] [HEAD ${head.block}] [APPLY ${apply ? `${apply.from}-${apply.to}` : 'NONE'}] [RECORD ${record ? `${record.from}-${record.to}` : 'NONE'}]`
  );

  if (apply) {
    const delegationsResponse = await findNewDelegations(apply.from, apply.to);
    await persistConsolidations(
      startBlock,
      delegationsResponse.consolidations,
      resetBlockTimestamp
    );
    await persistDelegations(
      startBlock,
      delegationsResponse.registrations,
      delegationsResponse.revocation
    );
    if (
      delegationsResponse.consolidations.length ||
      delegationsResponse.registrations.length ||
      delegationsResponse.revocation.length
    )
      health.committedStage();
    await handleENS();
    if (delegationsResponse.consolidations.length > 0) {
      await reconsolidateWallets(delegationsResponse.consolidations, health);
    }
    const primaryAddressEvents = [
      ...delegationsResponse.registrations,
      ...delegationsResponse.revocation
    ].filter((e) => e.use_case === USE_CASE_PRIMARY_ADDRESS);
    await updatePrimaryAddresses(primaryAddressEvents);
  } else {
    await handleENS();
  }

  if (record && freezeBlock !== null) {
    const logs = await scanDelegationLogsForRecord(record.from, record.to);
    await persistNftDelegationLogsAfterFreeze(logs, freezeBlock);
    logger.info(
      `[NFTDELEGATION FROZEN] [${logs.length} LOGS AFTER BLOCK ${freezeBlock} RECORDED, NOT APPLIED] [BLOCKS ${record.from}-${record.to}]`
    );
  }

  return { block: head.block, blockTimestamp: head.timestamp };
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

async function reconsolidateWallets(
  events: ConsolidationEvent[],
  health: DelegationsLoopHealth
) {
  const currentConsolidations = await fetchAllConsolidatedTdh();
  const affectedWallets = await getAffectedWallets(
    events,
    currentConsolidations
  );

  await reconsolidateAffectedWallets(affectedWallets, health);
}

async function reconsolidateRequestedWallets(
  wallets: string[],
  health: DelegationsLoopHealth
) {
  const currentConsolidations = await fetchAllConsolidatedTdh();
  const affectedWallets = await getAffectedWalletsForAddresses(
    wallets,
    currentConsolidations
  );
  logger.info({
    action: 'reconsolidate',
    phase: 'START',
    requested_wallets: wallets,
    affected_wallets: Array.from(affectedWallets)
  });
  const block = await reconsolidateAffectedWallets(affectedWallets, health);
  await identitiesService.updatePrimaryAddresses(affectedWallets);
  const result = {
    action: 'reconsolidate',
    status: 'completed',
    requested_wallets: wallets,
    affected_wallets: Array.from(affectedWallets),
    block
  };
  logger.info(result);
  return result;
}

async function reconsolidateAffectedWallets(
  affectedWallets: Set<string>,
  health: DelegationsLoopHealth
) {
  if (affectedWallets.size > 0) {
    reconsolidated = true;
    logger.info(
      `[RECONSOLIDATING FOR ${affectedWallets.size} DISTINCT WALLETS]`
    );

    const lastTDHCalc = Time.latestUtcMidnight().toDate();
    const walletsArray = Array.from(affectedWallets);

    const { block, blockTimestamp } = await updateTDH(
      lastTDHCalc,
      walletsArray
    );
    health.committedStage();
    // Keep the pre-update snapshot for old-membership discovery, but use a
    // fresh snapshot to choose the exact rows replaced during persistence.
    const replacementConsolidations = await fetchAllConsolidatedTdh();
    await consolidateAndPersistTDH(block, blockTimestamp, {
      mode: 'PARTIAL',
      wallets: walletsArray,
      currentConsolidatedTdh: replacementConsolidations
    });
    health.committedStage();
    await consolidateNftOwners(affectedWallets);
    health.committedStage();
    await consolidateOwnerBalances(affectedWallets);
    health.committedStage();
    await consolidateActivity(affectedWallets);
    health.committedStage();
    await consolidateSubscriptions(affectedWallets);
    health.committedStage();
    return block;
  } else {
    logger.info(`[NO WALLETS TO RECONSOLIDATE]`);
  }
}

async function updatePrimaryAddresses(events: DelegationEvent[]) {
  const wallets = new Set<string>();
  events.forEach((c) => {
    wallets.add(c.wallet1.toLowerCase());
  });

  await identitiesService.updatePrimaryAddresses(wallets);
  logger.info(`[UPDATED PRIMARY ADDRESSES FOR ${wallets.size} WALLETS]`);
}
