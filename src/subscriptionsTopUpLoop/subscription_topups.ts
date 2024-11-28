import { Alchemy, Network } from 'alchemy-sdk';
import { sepolia } from '@wagmi/chains';
import { Logger } from '../logging';
import { getAllSubscriptionTopUps } from './alchemy.subscriptions';
import {
  getMaxSubscriptionTopUpBlock,
  persistTopUps
} from './db.subscriptions_topup';
import { getAlchemyInstance } from '../alchemy';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP');

export function getSubscriptionsNetwork(): Network {
  const chain = process.env.SUBSCRIPTIONS_CHAIN_ID;
  if (chain === sepolia.id.toString()) {
    return Network.ETH_SEPOLIA;
  }
  return Network.ETH_MAINNET;
}

export async function discoverTopUps(reset?: boolean) {
  const network = getSubscriptionsNetwork();
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

  logger.info(
    `[NETWORK: ${network}] : [FROM BLOCK ${fromBlock}] : [TO BLOCK ${toBlock}]`
  );

  const chunkSize = 250;
  let currentFromBlock = fromBlock;

  while (currentFromBlock <= toBlock) {
    const currentToBlock = Math.min(currentFromBlock + chunkSize - 1, toBlock);

    logger.info(
      `[NETWORK: ${network}] : [FROM BLOCK ${currentFromBlock}] : [TO BLOCK ${currentToBlock}]`
    );

    const subscriptions = await getAllSubscriptionTopUps(
      alchemy,
      currentFromBlock,
      currentToBlock
    );

    logger.info(
      `[FROM BLOCK ${currentFromBlock} TO BLOCK ${currentToBlock}] [FOUND ${subscriptions.length} NEW TOP UPS]`
    );

    await persistTopUps(subscriptions);

    currentFromBlock = currentToBlock + 1;
  }
}
