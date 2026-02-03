import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  USE_CASE_PRIMARY_ADDRESS
} from '@/constants';
import {
  fetchLatestNftDelegationBlock,
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
import { sqlExecutor } from '../sql-executor';
import { consolidateSubscriptions } from '../subscriptionsDaily/subscriptions';
import { updateTDH } from '../tdhLoop/tdh';
import { consolidateAndPersistTDH } from '../tdhLoop/tdh_consolidation';
import { Time } from '../time';

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
      const delegationsResponse = await handleDelegations(startBlock);
      await persistNftDelegationBlock(
        delegationsResponse.block,
        delegationsResponse.blockTimestamp
      );
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
  const wallets = new Set<string>();
  events.forEach((c) => {
    wallets.add(c.wallet1.toLowerCase());
    wallets.add(c.wallet2.toLowerCase());
  });

  const affectedWallets = await getAffectedWallets(wallets);

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
    await consolidateAndPersistTDH(block, blockTimestamp, walletsArray);
    await consolidateNftOwners(affectedWallets);
    await consolidateOwnerBalances(affectedWallets);
    await consolidateActivity(affectedWallets);
    await consolidateSubscriptions(affectedWallets);
  } else {
    logger.info(`[NO WALLETS TO RECONSOLIDATE]`);
  }
}

async function getConsolidationsContainingAddress(
  wallets: Set<string>
): Promise<ConsolidatedTDH[]> {
  const likeConditions = Array.from(wallets)
    .map((wallet) => `consolidation_key LIKE '%${wallet.toLowerCase()}%'`)
    .join(' OR ');

  const query = `
    SELECT * FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
    WHERE ${likeConditions}
  `;

  return await sqlExecutor.execute<ConsolidatedTDH>(query);
}

async function getAffectedWallets(wallets: Set<string>) {
  const allConsolidations = await getConsolidationsContainingAddress(wallets);
  allConsolidations.map((c) => {
    const cWallets = JSON.parse(c.wallets);
    cWallets.forEach((w: string) => wallets.add(w.toLowerCase()));
  });

  return wallets;
}

async function updatePrimaryAddresses(events: DelegationEvent[]) {
  const wallets = new Set<string>();
  events.forEach((c) => {
    wallets.add(c.wallet1.toLowerCase());
  });

  await identitiesService.updatePrimaryAddresses(wallets);
  logger.info(`[UPDATED PRIMARY ADDRESSES FOR ${wallets.size} WALLETS]`);
}
