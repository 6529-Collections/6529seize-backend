import {
  persistConsolidations,
  persistDelegations,
  fetchLatestNftDelegationBlock,
  persistNftDelegationBlock
} from '../db';
import { findDelegationTransactions } from '../delegations';
import {
  Delegation,
  Consolidation,
  ConsolidationEvent,
  DelegationEvent,
  NFTDelegationBlock
} from '../entities/IDelegation';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import { discoverEnsConsolidations, discoverEnsDelegations } from '../ens';
import { Time } from '../time';
import { getLastTDH } from '../helpers';
import { consolidateTDH } from '../tdh_consolidation';
import { consolidateOwnerMetrics } from '../owner_metrics';
import { sqlExecutor } from '../sql-executor';
import { CONSOLIDATIONS_TABLE } from '../constants';
import { ConsolidatedTDH } from '../entities/ITDH';
import { ConsolidatedOwnerMetric, OwnerMetric } from '../entities/IOwner';

const logger = Logger.get('DELEGATIONS_LOOP');

export const handler = async (event?: any, context?: any) => {
  const start = Time.now();
  await loadEnv([
    Delegation,
    Consolidation,
    NFTDelegationBlock,
    ConsolidatedTDH,
    ConsolidatedOwnerMetric,
    OwnerMetric
  ]);
  const force = process.env.DELEGATIONS_RESET == 'true';
  logger.info(`[RUNNING] [FORCE ${force}]`);
  const delegationsResponse = await handleDelegations(force);
  await persistNftDelegationBlock(
    delegationsResponse.block,
    delegationsResponse.blockTimestamp
  );
  await unload();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function handleDelegations(force: boolean) {
  const delegationsResponse = await findNewDelegations(force ? 0 : undefined);
  await persistConsolidations(force, delegationsResponse.consolidations);
  await persistDelegations(
    force,
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

  logger.info(`[RECONSOLIDATING FOR ${distinctWallets.size} DISTINCT WALLETS]`);

  const lastTDHCalc = getLastTDH();
  await consolidateTDH(lastTDHCalc, Array.from(distinctWallets));
  await consolidateOwnerMetrics(Array.from(distinctWallets));
}
