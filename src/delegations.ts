import { Alchemy, Network } from 'alchemy-sdk';
import {
  DELEGATION_ALL_ADDRESS,
  DELEGATION_CONTRACT,
  MEMES_CONTRACT,
  USE_CASE_CONSOLIDATION,
  USE_CASE_PRIMARY_ADDRESS,
  USE_CASE_SUB_DELEGATION
} from './constants';
import { DELEGATIONS_IFACE } from './abis/delegations';
import { areEqualAddresses } from './helpers';
import {
  Event,
  EventType,
  ConsolidationEvent,
  DelegationEvent
} from './entities/IDelegation';
import { Logger } from './logging';
import { getAlchemyInstance } from './alchemy';
import { sepolia } from '@wagmi/chains';

let alchemy: Alchemy;

const logger = Logger.get('DELEGATIONS');

async function getAllDelegations(startingBlock: number, latestBlock: number) {
  const startingBlockHex = `0x${startingBlock.toString(16)}`;
  const latestBlockHex = `0x${latestBlock.toString(16)}`;

  logger.info(`[FROM BLOCK ${startingBlockHex}] [TO BLOCK ${latestBlockHex}]`);

  const response = await alchemy.core.getLogs({
    address: DELEGATION_CONTRACT.contract,
    fromBlock: startingBlockHex,
    toBlock: latestBlockHex
  });
  return response;
}

const getDelegationDetails = async (txHash: string) => {
  const tx = await alchemy.core.getTransaction(txHash);
  if (tx) {
    const data = tx.data;
    try {
      const parsed = DELEGATIONS_IFACE.parseTransaction({ data, value: 0 });
      if (parsed.args._expiryDate) {
        return {
          expiry: parsed.args._expiryDate.toNumber(),
          allTokens: parsed.args._allTokens,
          tokenId: parsed.args._tokenId.toNumber()
        };
      }
    } catch (e) {
      return null;
    }
  }
  return null;
};

const getNetwork = () => {
  if (DELEGATION_CONTRACT.chain_id == sepolia.id) {
    return Network.ETH_SEPOLIA;
  }
  return Network.ETH_MAINNET;
};

export const findDelegationTransactions = async (
  startingBlock: number,
  latestBlock?: number
) => {
  const network = getNetwork();
  alchemy = getAlchemyInstance(network);

  if (!latestBlock) {
    latestBlock = await alchemy.core.getBlockNumber();
    logger.info(
      `[STARTING BLOCK ${startingBlock}] [LATEST BLOCK ON CHAIN ${latestBlock}]`
    );
  }

  const timestamp = (await alchemy.core.getBlock(latestBlock)).timestamp;

  const allDelegations = await getAllDelegations(startingBlock, latestBlock);

  logger.info(`[FOUND ${allDelegations.length} NEW TRANSACTIONS]`);

  const consolidations: ConsolidationEvent[] = [];
  const registrations: DelegationEvent[] = [];
  const revocation: DelegationEvent[] = [];

  await Promise.all(
    allDelegations.map(async (d) => {
      const delResult = DELEGATIONS_IFACE.parseLog(d);
      const collection = delResult.args.collectionAddress;
      const from = delResult.args.delegator
        ? delResult.args.delegator
        : delResult.args.from;
      const to = delResult.args.delegationAddress;
      const useCase = delResult.args.useCase.toNumber();

      if (
        !areEqualAddresses(from, to) ||
        useCase === USE_CASE_PRIMARY_ADDRESS
      ) {
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
          } else if (useCase == USE_CASE_SUB_DELEGATION) {
            registrations.push({
              ...e,
              use_case: useCase,
              collection: collection
            });
          } else {
            const delegationDetails = await getDelegationDetails(
              d.transactionHash
            );
            registrations.push({
              ...e,
              use_case: useCase,
              collection: collection,
              expiry: delegationDetails?.expiry,
              all_tokens: delegationDetails?.allTokens,
              token_id: delegationDetails?.tokenId
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
            revocation.push({
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
    latestBlockTimestamp: timestamp,
    consolidations: consolidations,
    registrations: registrations,
    revocation: revocation
  };
};
