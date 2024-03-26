import { Alchemy, Network } from 'alchemy-sdk';
import { sepolia } from '@wagmi/chains';
import { Logger } from '../logging.ts';
import { WALLETS_CONSOLIDATION_KEYS_VIEW } from '../constants.ts';
import { getAllSubscriptionTopUps } from './alchemy.subscriptions.ts';
import { SubscriptionTopUp } from '../entities/ISubscription.ts.ts';
import { sqlExecutor } from '../sql-executor.ts';
import {
  getMaxSubscriptionTopUpBlock,
  persistTopUps
} from './db.subscriptions_topup.ts';
import { getAlchemyInstance } from '../alchemy.ts';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP');

export function getSubscriptionsnetwork(): Network {
  const chain = process.env.SUBSCRIPTIONS_CHAIN_ID;
  if (chain === sepolia.id.toString()) {
    return Network.ETH_SEPOLIA;
  }
  return Network.ETH_MAINNET;
}

export async function findTopUps(reset?: boolean) {
  const network = getSubscriptionsnetwork();
  logger.info(`[NETWORK: ${network}]`);
  const alchemy: Alchemy = getAlchemyInstance(network);

  let fromBlock: number;
  if (reset) {
    fromBlock = 0;
  } else {
    fromBlock = await getMaxSubscriptionTopUpBlock();
    if (fromBlock) {
      fromBlock = fromBlock + 1;
    }
  }

  const toBlock = await alchemy.core.getBlockNumber();

  const subscriptions = await getAllSubscriptionTopUps(
    alchemy,
    fromBlock,
    toBlock
  );

  logger.info(
    `[FROM BLOCK ${fromBlock}] [FOUND ${subscriptions.length} NEW TOP UPS]`
  );

  await processTopUps(subscriptions);
}

async function processTopUps(topUps: SubscriptionTopUp[]) {
  for (const topUp of topUps) {
    let consolidationKey = topUp.from_wallet;
    const consolidation = await sqlExecutor.execute(
      `SELECT * FROM ${WALLETS_CONSOLIDATION_KEYS_VIEW} WHERE wallet = :wallet`,
      { wallet: topUp.from_wallet }
    );
    if (consolidation.length === 1) {
      consolidationKey = consolidation[0].consolidation_key;
    }
  }

  await persistTopUps(topUps);
}
