import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import { USE_CASE_PRIMARY_ADDRESS } from '@/constants';
import {
  fetchAllConsolidatedTdh,
  fetchLatestNftDelegationBlock,
  persistConsolidations,
  persistDelegations,
  persistNftDelegationBlock
} from '../db';
import {
  fetchBlockTimestamp,
  findDelegationTransactions
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
import { appFeatures } from '../app-features';
import { identityChainMirror } from '../identity-chain-mirror/identity-chain-mirror.service';
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

/** The Lambda context's clock, where the loop runs with one. */
interface LoopContext {
  getRemainingTimeInMillis?: () => number;
}

export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown, context?: LoopContext) => {
    const timeLeft = (): number =>
      typeof context?.getRemainingTimeInMillis === 'function'
        ? context.getRemainingTimeInMillis()
        : Number.POSITIVE_INFINITY;
    const requestedWallets = readReconsolidationAction(event);
    reconsolidated = false;
    identitiesSynced = false;
    try {
      return await doInDbContext(
        async () => {
          // Every identities sync in this invocation shares one time budget.
          startIdentitySyncBudget();
          const scopeBackfill = readScopeBackfillConfig();
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
          const delegationsWork = thenResumePendingIdentitySync(async () => {
            const health = await DelegationsLoopHealth.start(false);
            const delegationsResponse = await handleDelegations(
              startBlock,
              health
            );
            await persistNftDelegationBlock(
              delegationsResponse.block,
              delegationsResponse.blockTimestamp
            );
            health.completed(delegationsResponse.blockTimestamp);
          });
          if (!appFeatures.isIdentityChainMirrorEnabled()) {
            await delegationsWork;
            return;
          }
          // From switch-on the identities come from the chain: the mirror
          // runs even when NFTDelegation's work failed, and that failure
          // still fails the run afterwards.
          const delegationsFailure = await delegationsWork.then(
            () => null,
            (error: unknown) => ({ error })
          );
          try {
            await mirrorChainIdentities(timeLeft);
          } catch (error) {
            if (delegationsFailure) {
              logger.error(`[IDENTITY CHAIN MIRROR FAILED] ${error}`);
            } else {
              throw error;
            }
          }
          if (delegationsFailure) throw delegationsFailure.error;
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
  if (appFeatures.isIdentityChainMirrorEnabled()) {
    // From switch-on the identity mirror writes consolidations, delegations,
    // consolidation keys and primary addresses from the 6529 chain; this
    // contract's events (after the identity freeze) would fight it. They
    // are read so the checkpoint moves on, and not applied.
    logger.info(
      `[IDENTITIES ON THE CHAIN: NFTDELEGATION EVENTS NOT APPLIED] [${delegationsResponse.consolidations.length} CONSOLIDATIONS] [${delegationsResponse.registrations.length} REGISTRATIONS] [${delegationsResponse.revocation.length} REVOCATIONS]`
    );
    await handleENS();
    return delegationsResponse;
  }
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

/** The run's share of time for the identity mirror (a run is 15 minutes). */
const IDENTITY_MIRROR_BUDGET_MS = Time.minutes(6).toMillis();
/** The profile site followers' share, after the mirror and the re-keying. */
const IDENTITY_FOLLOWERS_BUDGET_MS = Time.minutes(4).toMillis();
/** Kept back from the Lambda's remaining time: re-keying, then the end. */
const IDENTITY_REKEY_RESERVE_MS = Time.minutes(3).toMillis();
const IDENTITY_END_RESERVE_MS = Time.minutes(1).toMillis();
/** Below this, a step isn't started. */
const IDENTITY_MIN_STEP_MS = Time.seconds(30).toMillis();
/** At most this many regrouped wallets are re-keyed a run; the rest wait. */
const IDENTITY_REGROUPS_PER_RUN = 5_000;
/**
 * What re-keying a wallet is taken to cost (TDH, owners, balances, activity
 * and subscriptions together), to size the batch to the time left.
 */
const IDENTITY_REKEY_MS_PER_WALLET = 50;

/**
 * From switch-on, 6529.io's identity tables follow the 6529 chain
 * (FEATURE_IDENTITY_CHAIN_MIRROR). Runs after the delegations work (also
 * when it failed); a mirror failure still fails the run, so it is seen.
 * Each step's time comes from what the Lambda has left: the mirror, the
 * re-keying of the wallets it regrouped (queued in its own transactions,
 * so a run cut short re-keys them next time; as many as the time left
 * allows), then the profile site followers.
 */
async function mirrorChainIdentities(timeLeft: () => number) {
  if (!appFeatures.isIdentityChainMirrorEnabled()) {
    return;
  }
  const mirrorBudget = Math.min(
    IDENTITY_MIRROR_BUDGET_MS,
    timeLeft() - IDENTITY_REKEY_RESERVE_MS - IDENTITY_END_RESERVE_MS
  );
  const report =
    mirrorBudget >= IDENTITY_MIN_STEP_MS
      ? await identityChainMirror.run({ budgetMs: mirrorBudget })
      : null;
  if (report) {
    logger.info(`[IDENTITY CHAIN MIRROR] ${JSON.stringify(report)}`);
  } else {
    logger.warn(
      '[IDENTITY CHAIN MIRROR WAITS FOR THE NEXT RUN] [NO TIME LEFT]'
    );
  }
  await rekeyRegroupedWallets(timeLeft);
  if (report?.error) {
    // Re-keyed what it regrouped before it stopped; the run still fails.
    throw new Error(`Identity chain mirror: ${report.error}`);
  }
  // Last, after the re-keying: the profile site index follows the chain,
  // when the run has time left for it.
  const followersBudget = Math.min(
    IDENTITY_FOLLOWERS_BUDGET_MS,
    timeLeft() - IDENTITY_END_RESERVE_MS
  );
  if (followersBudget < IDENTITY_MIN_STEP_MS) {
    logger.info(
      '[PROFILE SITE FOLLOWERS WAIT FOR THE NEXT RUN] [NO TIME LEFT]'
    );
    return;
  }
  const problems = await identityChainMirror.followProfileSites(
    undefined,
    followersBudget
  );
  if (problems.length) {
    logger.error(`[PROFILE SITE FOLLOWERS] ${JSON.stringify(problems)}`);
  }
}

/**
 * A join or removal on the chain changes consolidation keys, as a
 * consolidation event did: re-key TDH, owners, balances, activity and
 * subscriptions for the wallets the mirror queued, then take them off.
 */
async function rekeyRegroupedWallets(timeLeft: () => number) {
  const budget = timeLeft() - IDENTITY_END_RESERVE_MS;
  const batch = Math.min(
    IDENTITY_REGROUPS_PER_RUN,
    Math.floor(budget / IDENTITY_REKEY_MS_PER_WALLET)
  );
  if (batch < 1) {
    logger.warn('[REGROUPED WALLETS WAIT FOR THE NEXT RUN] [NO TIME LEFT]');
    return;
  }
  const before = Date.now();
  const wallets = await identityChainMirror.pendingRegroups(batch);
  if (!wallets.length) return;
  const health = await DelegationsLoopHealth.start(true);
  try {
    const affected = await getAffectedWalletsForAddresses(
      wallets,
      await fetchAllConsolidatedTdh()
    );
    await reconsolidateAffectedWallets(affected, health);
    await identityChainMirror.regroupsDone(wallets, before);
    health.completed();
  } catch (error) {
    health.failed();
    throw error;
  }
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
