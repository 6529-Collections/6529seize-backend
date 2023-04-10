import { Alchemy, Network } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS, DELEGATION_CONTRACT } from './constants';
import { BaseTransaction } from './entities/ITransaction';
import { DELEGATIONS_IFACE } from './abis/delegations';
import { areEqualAddresses } from './helpers';
import { ConsolidationEvent, ConsolidationType } from './entities/IDelegation';

let alchemy: Alchemy;

async function getAllTransactions(startingBlock: number, latestBlock: number) {
  const startingBlockHex = `0x${startingBlock.toString(16)}`;
  const latestBlockHex = `0x${latestBlock.toString(16)}`;

  console.log(
    new Date(),
    '[TRANSACTIONS]',
    `[FROM BLOCK ${startingBlockHex}]`,
    `[TO BLOCK ${latestBlockHex}]`
  );

  const response = await alchemy.core.getLogs({
    address: DELEGATION_CONTRACT.contract,
    fromBlock: startingBlockHex,
    toBlock: latestBlockHex
  });
  return response;
}

export const findDelegationTransactions = async (
  startingBlock: number,
  latestBlock?: number
) => {
  alchemy = new Alchemy({
    network: Network.ETH_SEPOLIA,
    maxRetries: 10,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  if (!latestBlock) {
    latestBlock = await alchemy.core.getBlockNumber();
    console.log(
      new Date(),
      '[TRANSACTIONS]',
      `[STARTING BLOCK ${startingBlock}]`,
      `[LATEST BLOCK ON CHAIN ${latestBlock}]`
    );
  }

  const timestamp = (await alchemy.core.getBlock(latestBlock)).timestamp;

  const transactions = await getAllTransactions(startingBlock, latestBlock);

  console.log(
    new Date(),
    '[TRANSACTIONS]',
    `[FOUND ${transactions.length} NEW TRANSACTIONS]`
  );

  if (transactions.length == 0) {
    return {
      latestBlock: latestBlock,
      latestBlockTimestamp: new Date(timestamp * 1000),
      consolidations: []
    };
  }

  const consolidations: ConsolidationEvent[] = [];

  await Promise.all(
    transactions.map(async (t) => {
      const delResult = DELEGATIONS_IFACE.parseLog(t);
      if (delResult.args.useCase == 99) {
        const from = delResult.args.delegator
          ? delResult.args.delegator
          : delResult.args.from;
        const to = delResult.args.delegationAddress;

        if (!areEqualAddresses(from, to)) {
          if (
            [
              'RegisterDelegation',
              'RegisterDelegationUsingSubDelegation'
            ].includes(delResult.name)
          ) {
            consolidations.push({
              block: t.blockNumber,
              type: ConsolidationType.REGISTER,
              wallet1: from,
              wallet2: to
            });
          } else if (
            ['RevokeDelegation', 'RevokeDelegationUsingSubDelegation'].includes(
              delResult.name
            )
          ) {
            consolidations.push({
              block: t.blockNumber,
              type: ConsolidationType.REVOKE,
              wallet1: from,
              wallet2: to
            });
          }
        }
      }
    })
  );

  return {
    latestBlock: latestBlock,
    latestBlockTimestamp: new Date(timestamp * 1000),
    consolidations: consolidations
  };
};
