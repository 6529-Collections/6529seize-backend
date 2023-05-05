import { Alchemy, Network } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  DELEGATION_ALL_ADDRESS,
  DELEGATION_CONTRACT,
  MEMES_CONTRACT,
  USE_CASE_CONSOLIDATION
} from './constants';
import { DELEGATIONS_IFACE } from './abis/delegations';
import { areEqualAddresses } from './helpers';
import { ConsolidationEvent, ConsolidationType } from './entities/IDelegation';

let alchemy: Alchemy;

async function getAllDelegations(startingBlock: number, latestBlock: number) {
  const startingBlockHex = `0x${startingBlock.toString(16)}`;
  const latestBlockHex = `0x${latestBlock.toString(16)}`;

  console.log(
    '[DELEGATIONS]',
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
    ...ALCHEMY_SETTINGS,
    // network: Network.ETH_SEPOLIA,
    // maxRetries: 10,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  if (!latestBlock) {
    latestBlock = await alchemy.core.getBlockNumber();
    console.log(
      '[DELEGATIONS]',
      `[STARTING BLOCK ${startingBlock}]`,
      `[LATEST BLOCK ON CHAIN ${latestBlock}]`
    );
  }

  const timestamp = (await alchemy.core.getBlock(latestBlock)).timestamp;

  const delegations = await getAllDelegations(startingBlock, latestBlock);

  console.log(
    '[DELEGATIONS]',
    `[FOUND ${delegations.length} NEW TRANSACTIONS]`
  );

  if (delegations.length == 0) {
    return {
      latestBlock: latestBlock,
      latestBlockTimestamp: new Date(timestamp * 1000),
      consolidations: []
    };
  }

  const consolidations: ConsolidationEvent[] = [];

  await Promise.all(
    delegations.map(async (d) => {
      const delResult = DELEGATIONS_IFACE.parseLog(d);
      if (
        delResult.args.useCase == USE_CASE_CONSOLIDATION &&
        [MEMES_CONTRACT, DELEGATION_ALL_ADDRESS].includes(
          delResult.args.collectionAddress
        )
      ) {
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
              block: d.blockNumber,
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
              block: d.blockNumber,
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
