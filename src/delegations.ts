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
import {
  Event,
  EventType,
  ConsolidationEvent,
  DelegationEvent
} from './entities/IDelegation';

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

  const allDelegations = await getAllDelegations(startingBlock, latestBlock);

  console.log(
    '[DELEGATIONS]',
    `[FOUND ${allDelegations.length} NEW TRANSACTIONS]`
  );

  if (allDelegations.length == 0) {
    return {
      latestBlock: latestBlock,
      latestBlockTimestamp: new Date(timestamp * 1000),
      consolidations: [],
      delegations: []
    };
  }

  const consolidations: ConsolidationEvent[] = [];
  const delegations: DelegationEvent[] = [];

  await Promise.all(
    allDelegations.map(async (d) => {
      const delResult = DELEGATIONS_IFACE.parseLog(d);
      const collection = delResult.args.collectionAddress;
      const from = delResult.args.delegator
        ? delResult.args.delegator
        : delResult.args.from;
      const to = delResult.args.delegationAddress;
      const useCase = delResult.args.useCase.toNumber();

      if (!areEqualAddresses(from, to)) {
        if (
          [
            'RegisterDelegation',
            'RegisterDelegationUsingSubDelegation'
          ].includes(delResult.name)
        ) {
          const e: Event = {
            block: d.blockNumber,
            type: EventType.REGISTER,
            wallet1: from,
            wallet2: to
          };
          if (useCase == USE_CASE_CONSOLIDATION) {
            if ([MEMES_CONTRACT, DELEGATION_ALL_ADDRESS].includes(collection)) {
              consolidations.push(e);
            }
          } else {
            delegations.push({
              ...e,
              use_case: useCase,
              collection: collection
            });
          }
        } else if (
          ['RevokeDelegation', 'RevokeDelegationUsingSubDelegation'].includes(
            delResult.name
          )
        ) {
          const e: Event = {
            block: d.blockNumber,
            type: EventType.REVOKE,
            wallet1: from,
            wallet2: to
          };
          if (useCase == USE_CASE_CONSOLIDATION) {
            if ([MEMES_CONTRACT, DELEGATION_ALL_ADDRESS].includes(collection)) {
              consolidations.push(e);
            }
          } else {
            delegations.push({
              ...e,
              use_case: useCase,
              collection: collection
            });
          }
        }
      }
    })
  );

  return {
    latestBlock: latestBlock,
    latestBlockTimestamp: new Date(timestamp * 1000),
    consolidations: consolidations,
    delegations: delegations
  };
};
