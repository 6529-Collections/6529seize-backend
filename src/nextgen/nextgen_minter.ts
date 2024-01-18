import { ethers } from 'ethers';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  SortingOrder
} from 'alchemy-sdk';
import { Logger } from '../logging';
import { NEXTGEN_MINTER_IFACE } from '../abis/nextgen';
import { NextGenLog } from '../entities/INextGen';
import { Time } from '../time';
import { weiToEth } from '../helpers';
import {
  fetchNextGenCollection,
  persistNextGenCollection,
  persistNextGenLogs
} from './nextgen.db';
import { EntityManager } from 'typeorm';
import {
  NEXTGEN_MINTER_CONTRACT,
  getNextgenNetwork
} from './nextgen_constants';

const logger = Logger.get('NEXTGEN_MINTER');

export async function findMinterTransactions(
  entityManager: EntityManager,
  alchemy: Alchemy,
  startBlock: number,
  endBlock: number,
  pageKey?: string
) {
  logger.info(
    `[FINDING TRANSACTIONS] : [START BLOCK ${startBlock}] : [END BLOCK ${endBlock}] : [PAGE KEY ${pageKey}]`
  );
  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.EXTERNAL],
    excludeZeroValue: false,
    maxCount: 100,
    fromBlock: `0x${startBlock.toString(16)}`,
    toBlock: `0x${endBlock.toString(16)}`,
    pageKey: pageKey,
    toAddress: NEXTGEN_MINTER_CONTRACT[getNextgenNetwork()],
    withMetadata: true,
    order: SortingOrder.ASCENDING
  };
  const response = await alchemy.core.getAssetTransfers(settings);

  const logs: NextGenLog[] = [];
  for (const transfer of response.transfers) {
    const receipt = await alchemy.core.getTransaction(transfer.hash);
    if (receipt) {
      const parsedReceipt = NEXTGEN_MINTER_IFACE.parseTransaction({
        data: receipt.data,
        value: 0
      });
      const methodName = parsedReceipt.name;
      const args = parsedReceipt.args;
      const processedLogs = await processLog(entityManager, methodName, args);
      const timestamp = new Date(transfer.metadata.blockTimestamp);
      processedLogs.forEach((processedLog, index) => {
        const l: NextGenLog = {
          id: `${transfer.hash}-${index}`,
          transaction: transfer.hash,
          block: parseInt(transfer.blockNum, 16),
          block_timestamp: timestamp.getTime() / 1000,
          collection_id: processedLog.id,
          log: processedLog.description,
          source: 'minter'
        };
        logs.push(l);
      });
    }
  }

  await persistNextGenLogs(entityManager, logs);

  if (response.pageKey) {
    await findMinterTransactions(
      entityManager,
      alchemy,
      startBlock,
      endBlock,
      response.pageKey
    );
  }
}

async function processLog(
  entityManager: EntityManager,
  methodName: string,
  args: ethers.utils.Result
): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  switch (methodName) {
    case 'initializeBurn':
      return await initializeBurn(entityManager, args);
    case 'initializeExternalBurnOrSwap':
      return await initializeExternalBurnOrSwap(args);
    case 'setCollectionCosts':
      return await setCollectionCosts(args);
    case 'setCollectionPhases':
      return await setCollectionPhases(entityManager, args);
    case 'mint':
    case 'airDropTokens':
      // skip - handled by core_events
      return [];
    case 'burnOrSwapExternalToMint':
    case 'burnToMint':
      // skip - handled by Transfer
      return [];
  }

  let methodNameParts = methodName
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .split(' ');
  methodNameParts[0] =
    methodNameParts[0].charAt(0).toUpperCase() + methodNameParts[0].slice(1);

  return [
    {
      id: 0,
      description: methodNameParts.join(' ')
    }
  ];
}

async function initializeBurn(
  entityManager: EntityManager,
  args: ethers.utils.Result
): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const burnCollectionId = parseInt(args[0]);
  const mintCollectionId = parseInt(args[1]);
  const status: boolean = args[2];

  const burnCollection = await fetchNextGenCollection(
    entityManager,
    burnCollectionId
  );
  const mintCollection = await fetchNextGenCollection(
    entityManager,
    mintCollectionId
  );

  if (!burnCollection || !mintCollection) {
    logger.info(
      `[METHOD NAME INITIALIZE BURN] : [COLLECTION ID ${burnCollectionId} OR ${mintCollectionId} NOT FOUND]`
    );
    return [];
  }

  let description = 'Burn';
  if (status) {
    description += ` Initialized`;
  } else {
    description += ` Deactivated`;
  }
  description += ` for Collection #${burnCollectionId} - ${burnCollection.name} for Mint Collection #${mintCollectionId} - ${mintCollection.name}`;

  return [
    {
      id: mintCollectionId,
      description: description
    }
  ];
}

async function initializeExternalBurnOrSwap(args: ethers.utils.Result): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const burnCollection = args[0];
  const burnCollectionId = parseInt(args[1]);
  const mintCollectionId = parseInt(args[2]);
  const tokenMin = parseInt(args[3]);
  const tokenMax = parseInt(args[4]);
  const burnAddress = args[5];
  const status: boolean = args[6];

  let description = 'External Burn or Swap';
  if (status) {
    description += ` Initialized`;
  } else {
    description += ` Deactivated`;
  }
  description += ` for Collection ${burnCollection} ${
    burnCollectionId ? `(ID ${burnCollectionId})` : ''
  } for tokens ${tokenMin} - ${tokenMax} (Burn Address ${burnAddress})`;

  return [
    {
      id: mintCollectionId,
      description: description
    }
  ];
}

async function setCollectionCosts(args: ethers.utils.Result): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const mintCost = parseInt(args[1]);
  const endMintCost = parseInt(args[2]);
  const rate = parseInt(args[3]);
  const timePeriod = parseInt(args[4]);
  const salesOption = parseInt(args[5]);
  //   const delAddress = args[6];

  let salesOptionDescription = '';

  const timePeriodTime = Time.seconds(timePeriod);
  const timePeriodDescription = timePeriodTime.formatAsDuration();

  switch (salesOption) {
    case 1:
      salesOptionDescription = 'Fixed Price';
      break;
    case 2:
      if (rate === 0) {
        salesOptionDescription = `Exponential Descending (Time Period: ${timePeriodDescription})`;
      } else {
        salesOptionDescription = `Linear Descending (Time Period: ${timePeriodDescription})`;
      }
      break;
    case 3:
      salesOptionDescription = `Periodic Sale (Time Period: ${timePeriodDescription})`;
      break;
    default:
      salesOptionDescription = `${salesOption}`;
  }

  const mintCostDescription = `Mint Cost: ${
    mintCost > 0 ? `${weiToEth(mintCost)} ETH` : 'Free'
  }`;
  const endMintCosetDescription = `End Mint Cost: ${
    endMintCost > 0 ? `${weiToEth(endMintCost)} ETH` : 'Free'
  }`;

  return [
    {
      id: collectionId,
      description: `Collection Costs Set - Sales Model: ${salesOptionDescription}, ${mintCostDescription}, ${endMintCosetDescription}`
    }
  ];
}

async function setCollectionPhases(
  entityManager: EntityManager,
  args: ethers.utils.Result
): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const id = parseInt(args[0]);
  const alStart = parseInt(args[1]);
  const alEnd = parseInt(args[2]);
  const publicStart = parseInt(args[3]);
  const publicEnd = parseInt(args[4]);
  const merkleRoot = args[5];

  const collection = await fetchNextGenCollection(entityManager, id);
  if (!collection) {
    logger.info(
      `[METHOD NAME SET COLLECTION PHASES] : [COLLECTION ID ${id} NOT FOUND]`
    );
    return [];
  }
  collection.allowlist_start = alStart;
  collection.allowlist_end = alEnd;
  collection.public_start = publicStart;
  collection.public_end = publicEnd;
  collection.merkle_root = merkleRoot;

  await persistNextGenCollection(entityManager, collection);

  return [
    {
      id: id,
      description: 'Collection Phases Set'
    }
  ];
}
