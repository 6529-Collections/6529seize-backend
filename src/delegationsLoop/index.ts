import {
  fetchLatestNftDelegationBlock,
  persistConsolidations,
  persistDelegations,
  persistNftDelegationBlock
} from '../db';
import { findDelegationTransactions } from '../delegations';
import {
  Consolidation,
  ConsolidationEvent,
  Delegation,
  DelegationEvent,
  NFTDelegationBlock
} from '../entities/IDelegation';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import { discoverEnsConsolidations, discoverEnsDelegations } from '../ens';
import { Time } from '../time';
import { getLastTDH } from '../helpers';
import { consolidateTDH } from '../tdhLoop/tdh_consolidation';
import { sqlExecutor } from '../sql-executor';
import { CONSOLIDATIONS_TABLE } from '../constants';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  NftTDH,
  TDH,
  TDHMemes
} from '../entities/ITDH';
import { Profile } from '../entities/IProfile';
import * as sentryContext from '../sentry.context';
import { NextGenTokenTDH } from '../entities/INextGen';
import { consolidateOwnerBalances } from '../ownersBalancesLoop/owners_balances';
import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import { consolidateNftOwners } from '../nftOwnersLoop/nft_owners';
import { CommunityMember } from '../entities/ICommunityMember';
import { updateTDH } from '../tdhLoop/tdh';
import { MemesSeason } from '../entities/ISeason';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';
import {
  AggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivity,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import { consolidateSubscriptions } from '../subscriptionsDaily/subscriptions';

const logger = Logger.get('DELEGATIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  const start = Time.now();
  await loadEnv([
    Delegation,
    Consolidation,
    CommunityMember,
    NFTDelegationBlock,
    TDH,
    ConsolidatedTDH,
    NextGenTokenTDH,
    TDHMemes,
    ConsolidatedTDHMemes,
    Profile,
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
    NftTDH
  ]);
  const startBlockEnv = process.env.DELEGATIONS_RESET_BLOCK;
  const startBlock =
    startBlockEnv && Number.isInteger(Number(startBlockEnv))
      ? parseInt(startBlockEnv, 10)
      : undefined;

  logger.info(`[RUNNING] [START_BLOCK ${startBlock}]`);
  const delegationsResponse = await handleDelegations(startBlock);
  await persistNftDelegationBlock(
    delegationsResponse.block,
    delegationsResponse.blockTimestamp
  );
  await unload();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
});

async function handleDelegations(startBlock: number | undefined) {
  const delegationsResponse = await findNewDelegations(startBlock);

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
  const wallets = new Set<string>();
  events.forEach((c) => {
    wallets.add(c.wallet1);
    wallets.add(c.wallet2);
  });

  const query = `
    SELECT * FROM ${CONSOLIDATIONS_TABLE}
    WHERE wallet1 IN (:wallets)
    OR wallet2 IN (:wallets)
`;
  const distinctWalletConsolidations = await sqlExecutor.execute(query, {
    wallets: Array.from(wallets)
  });

  const distinctWallets = new Set<string>();
  distinctWalletConsolidations.forEach((c: Consolidation) => {
    distinctWallets.add(c.wallet1);
    distinctWallets.add(c.wallet2);
  });

  if (distinctWallets.size > 0) {
    logger.info(
      `[RECONSOLIDATING FOR ${distinctWallets.size} DISTINCT WALLETS]`
    );

    const lastTDHCalc = getLastTDH();
    const walletsArray = Array.from(distinctWallets);

    await updateTDH(lastTDHCalc, walletsArray);
    await consolidateTDH(lastTDHCalc, walletsArray);

    await consolidateNftOwners(distinctWallets);
    await consolidateOwnerBalances(distinctWallets);
    await consolidateActivity(distinctWallets);
    await consolidateSubscriptions(distinctWallets);
  } else {
    logger.info(`[NO WALLETS TO RECONSOLIDATE]`);
  }
}
