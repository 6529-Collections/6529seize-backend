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
  DelegationEvent
} from '../entities/IDelegation';
import { loadEnv } from '../secrets';
import { Logger } from '../logging';
import { Time } from '../time';
import { getLastTDH } from '../helpers';
import { sqlExecutor } from '../sql-executor';
import { CONSOLIDATIONS_TABLE } from '../constants';
import { updateTDH } from '../tdhLoop/tdh';

const logger = Logger.get('DELEGATIONS_LOOP');

export const handler = async (startBlock?: number) => {
  const start = Time.now();
  logger.info(`[RUNNING] [START_BLOCK ${startBlock}]`);

  await loadEnv();

  const delegationsResponse = await handleDelegations(startBlock);
  await persistNftDelegationBlock(
    delegationsResponse.block,
    delegationsResponse.blockTimestamp
  );

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function handleDelegations(startBlock: number | undefined) {
  const delegationsResponse = await findNewDelegations(startBlock);
  await persistConsolidations(startBlock, delegationsResponse.consolidations);
  await persistDelegations(
    startBlock,
    delegationsResponse.registrations,
    delegationsResponse.revocation
  );

  if (delegationsResponse.consolidations.length > 0) {
    await reconsolidateWallets(delegationsResponse.consolidations);
  }

  return delegationsResponse;
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
  } else {
    logger.info(`[NO WALLETS TO RECONSOLIDATE]`);
  }
}
