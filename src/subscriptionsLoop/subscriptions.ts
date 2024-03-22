import { Alchemy, Network } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';
import { sepolia } from '@wagmi/chains';
import { Logger } from '../logging';
import { WALLETS_CONSOLIDATION_KEYS_VIEW } from '../constants';
import { getAllSubscriptionTopUps } from './alchemy.subscriptions';
import { SubscriptionTopUp } from '../entities/ISubscription.ts';
import { sqlExecutor } from '../sql-executor';
import {
  getMaxSubscriptionTopUpBlock,
  persistTopUps
} from './db.subscriptions';

const logger = Logger.get('SUBSCRIPTIONS');

export function getSubscriptionsnetwork(): Network {
  const chain = process.env.SUBSCRIPTIONS_CHAIN_ID;
  if (chain === sepolia.id.toString()) {
    return Network.ETH_SEPOLIA;
  }
  return Network.ETH_MAINNET;
}

export async function findSubscriptions(reset?: boolean) {
  const network = getSubscriptionsnetwork();
  logger.info(`[NETWORK: ${network}]`);
  const alchemy: Alchemy = getAlchemyInstance(network);

  let fromBlock;
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
    `[FROM BLOCK ${fromBlock}] [FOUND ${subscriptions.length} NEW SUBSCRIPTIONS]`
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
