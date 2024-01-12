import { ethers } from 'ethers';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  Network,
  SortingOrder
} from 'alchemy-sdk';
import {
  NEXTGEN_CF_BASE_PATH,
  NEXTGEN_CORE_CONTRACT,
  NEXTGEN_NETWORK
} from '../constants';
import { Logger } from '../logging';
import { NEXTGEN_CORE_IFACE } from '../abis/nextgen';
import { NextGenCollection, NextGenLog } from '../entities/INextGen';
import {
  fetchNextGenCollection,
  fetchNextGenCollectionIndex,
  persistNextGenCollection,
  persistNextGenLogs
} from '../db';
import { Time } from '../time';

const logger = Logger.get('NEXTGEN_CORE_TRANSACTIONS');

export async function findCoreTransactions(
  alchemy: Alchemy,
  startBlock: number,
  endBlock: number,
  pageKey: string | undefined
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
    toAddress: NEXTGEN_CORE_CONTRACT[NEXTGEN_NETWORK],
    withMetadata: true,
    order: SortingOrder.ASCENDING
  };
  const response = await alchemy.core.getAssetTransfers(settings);

  const logs: NextGenLog[] = [];
  for (const transfer of response.transfers) {
    const receipt = await alchemy.core.getTransaction(transfer.hash);
    if (receipt) {
      const parsedReceipt = NEXTGEN_CORE_IFACE.parseTransaction({
        data: receipt.data,
        value: 0
      });
      const methodName = parsedReceipt.name;
      const args = parsedReceipt.args;
      const processedLogs = await processLog(methodName, args);
      const timestamp = new Date(transfer.metadata.blockTimestamp);
      processedLogs.forEach((processedLog) => {
        const l: NextGenLog = {
          transaction: transfer.hash,
          block: parseInt(transfer.blockNum, 16),
          block_timestamp: timestamp.getTime() / 1000,
          collection_id: processedLog.id,
          log: processedLog.description,
          source: 'transactions'
        };
        logs.push(l);
      });
    }
  }

  await persistNextGenLogs(logs);

  if (response.pageKey) {
    await findCoreTransactions(alchemy, startBlock, endBlock, response.pageKey);
  }
}

async function processLog(
  methodName: string,
  args: ethers.utils.Result
): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  switch (methodName) {
    case 'createCollection':
      return await createCollection(args);
    case 'updateCollectionInfo':
      return await updateCollectionInfo(args);
    case 'artistSignature':
      return await artistSignature(args);
    case 'setCollectionData':
      return await setCollectionData(args);
    case 'changeMetadataView':
      return await changeMetadataView(args);
    case 'updateImagesAndAttributes':
      return await updateImagesAndAttributes(args);
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

async function createCollection(args: ethers.utils.Result): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const latestId = await fetchNextGenCollectionIndex();
  const newId = latestId + 1;
  const image = getCollectionImage(newId);
  const collection: NextGenCollection = {
    id: newId,
    name: args[0],
    artist: args[1],
    description: args[2],
    website: args[3],
    licence: args[4],
    base_uri: args[5],
    library: args[6],
    image: image,
    mint_count: 0
  };
  await persistNextGenCollection(collection);
  return [
    {
      id: newId,
      description: 'Collection Created'
    }
  ];
}

async function updateCollectionInfo(args: ethers.utils.Result): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const image = getCollectionImage(collectionId);
  const collection: NextGenCollection = {
    id: collectionId,
    name: args[1],
    artist: args[2],
    description: args[3],
    website: args[4],
    licence: args[5],
    base_uri: args[6],
    library: args[7],
    image: image,
    mint_count: 0
  };
  const scriptIndex = parseInt(args[8]);
  let description: string;
  if (scriptIndex === 1000000) {
    description = 'Collection Info Updated';
  } else if (scriptIndex === 999999) {
    description = 'Collection Base URI Updated';
  } else {
    description = `Script at index ${scriptIndex} updated`;
  }
  await persistNextGenCollection(collection);
  return [
    {
      id: collectionId,
      description: description
    }
  ];
}

async function artistSignature(args: ethers.utils.Result): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const id = parseInt(args[0]);
  const signature = args[1];
  const collection = await fetchNextGenCollection(id);
  if (!collection) {
    logger.info(
      `[METHOD NAME ARTIST SIGNATURE] : [COLLECTION ID ${id} NOT FOUND]`
    );
    return [];
  }
  collection.artist_signature = signature;
  await persistNextGenCollection(collection);
  return [
    {
      id: id,
      description: 'Artist Signature Added'
    }
  ];
}

async function setCollectionData(args: ethers.utils.Result): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const id = parseInt(args[0]);
  const artistAddress = args[1];
  const maxPurchases = parseInt(args[2]);
  const totalSupply = parseInt(args[3]);
  const finalSupplyAfterMint = parseInt(args[4]);

  const collection = await fetchNextGenCollection(id);
  if (!collection) {
    logger.info(
      `[METHOD NAME SET COLLECTION DATA] : [COLLECTION ID ${id} NOT FOUND]`
    );
    return [];
  }
  collection.artist_address = artistAddress;
  collection.max_purchases = maxPurchases;
  collection.total_supply = totalSupply;
  collection.final_supply_after_mint = finalSupplyAfterMint;
  await persistNextGenCollection(collection);

  return [
    {
      id: id,
      description: 'Collection Data Set'
    }
  ];
}

async function changeMetadataView(args: ethers.utils.Result): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const id = parseInt(args[0]);
  const onChain: boolean = args[1];

  const collection = await fetchNextGenCollection(id);
  if (!collection) {
    logger.info(
      `[METHOD NAME CHANGE METADATA VIEW] : [COLLECTION ID ${id} NOT FOUND]`
    );
    return [];
  }
  collection.on_chain = onChain;
  await persistNextGenCollection(collection);

  return [
    {
      id: id,
      description: `Metadata View Changed to ${
        onChain ? 'On-Chain' : 'Off-Chain'
      }`
    }
  ];
}

async function updateImagesAndAttributes(args: ethers.utils.Result): Promise<
  {
    id: number;
    description: string;
  }[]
> {
  const tokenIds: any[] = args[0];
  const logs: any[] = [];
  for (const tokenId of tokenIds) {
    const tokenIdInt = parseInt(tokenId);
    const collectionId = Math.round(tokenId / 10000000000);
    const collection = await fetchNextGenCollection(collectionId);
    if (!collection) {
      logger.info(
        `[METHOD NAME UPDATE IMAGES AND ATTRIBUTES] : [COLLECTION ID ${collectionId} NOT FOUND]`
      );
    } else {
      const normalisedTokenId = tokenIdInt - collectionId;
      logs.push({
        id: collectionId,
        description: `Image and Attributes Updated for ${collection.name} #${normalisedTokenId}`
      });
    }
  }
  return logs;
}

function getCollectionImage(collectionId: number): string {
  return `${NEXTGEN_CF_BASE_PATH}${
    NEXTGEN_NETWORK === Network.ETH_GOERLI ? 'testnet' : 'mainnet'
  }/png/${collectionId * 10000000000}`;
}
