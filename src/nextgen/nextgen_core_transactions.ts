import { ethers } from 'ethers';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  Network,
  SortingOrder
} from 'alchemy-sdk';
import { Logger } from '../logging';
import { NEXTGEN_CORE_IFACE } from '../abis/nextgen';
import { NextGenCollection, NextGenLog } from '../entities/INextGen';
import {
  fetchNextGenCollection,
  fetchNextGenCollectionIndex,
  persistNextGenCollection,
  persistNextGenLogs,
  wasTransactionLogProcessed
} from './nextgen.db';
import { EntityManager } from 'typeorm';
import {
  getNextgenNetwork,
  NEXTGEN_CF_BASE_PATH,
  NEXTGEN_CORE_CONTRACT
} from './nextgen_constants';
import { CLOUDFRONT_LINK } from '@/constants';
import { getEns } from '../alchemy';
import { getSourceCodeForContract } from '../etherscan';

const logger = Logger.get('NEXTGEN_CORE_TRANSACTIONS');

export async function findCoreTransactions(
  entityManager: EntityManager,
  alchemy: Alchemy,
  startBlock: number,
  endBlock: number,
  pageKey?: string
) {
  const network = getNextgenNetwork();
  logger.info(
    `[NETWORK ${network}] : [FINDING TRANSACTIONS] : [START BLOCK ${startBlock}] : [END BLOCK ${endBlock}] : [PAGE KEY ${pageKey}]`
  );
  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.EXTERNAL],
    excludeZeroValue: false,
    maxCount: 100,
    fromBlock: `0x${startBlock.toString(16)}`,
    toBlock: `0x${endBlock.toString(16)}`,
    pageKey: pageKey,
    toAddress: NEXTGEN_CORE_CONTRACT[network],
    withMetadata: true,
    order: SortingOrder.ASCENDING
  };
  const response = await alchemy.core.getAssetTransfers(settings);

  const logs: NextGenLog[] = [];
  for (const transfer of response.transfers) {
    const wasProcessed = await wasTransactionLogProcessed(
      entityManager,
      transfer.hash
    );
    if (wasProcessed) {
      logger.info(
        `[TRANSACTION ALREADY PROCESSED] : [TRANSACTION HASH ${transfer.hash}]`
      );
      continue;
    }
    const receipt = await alchemy.core.getTransaction(transfer.hash);
    if (receipt) {
      const parsedReceipt = NEXTGEN_CORE_IFACE.parseTransaction({
        data: receipt.data,
        value: 0
      })!;
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
          heading: processedLog.title,
          log: processedLog.description,
          source: 'transactions'
        };
        if (processedLog.token_id) {
          l.token_id = processedLog.token_id;
        }
        logs.push(l);
      });
    }
  }

  await persistNextGenLogs(entityManager, logs);

  if (response.pageKey) {
    await findCoreTransactions(
      entityManager,
      alchemy,
      startBlock,
      endBlock,
      response.pageKey
    );
  }
}

export async function processLog(
  entityManager: EntityManager,
  methodName: string,
  args: ethers.Result
): Promise<
  {
    id: number;
    token_id?: number;
    title: string;
    description: string;
  }[]
> {
  switch (methodName) {
    case 'createCollection':
      return await createCollection(entityManager, args);
    case 'updateCollectionInfo':
      return await updateCollectionInfo(entityManager, args);
    case 'artistSignature':
      return await artistSignature(entityManager, args);
    case 'setCollectionData':
      return await setCollectionData(entityManager, args);
    case 'changeMetadataView':
      return await changeMetadataView(entityManager, args);
    case 'updateImagesAndAttributes':
      return await updateImagesAndAttributes(entityManager, args);
    case 'addRandomizer':
      return await addRandomizer(args);
    case 'changeTokenData':
      return await changeTokenData(args);
    case 'setApprovalForAll':
    case 'safeTransferFrom':
    case 'transferFrom':
    case 'transferOwnership':
      logger.info(`[METHOD NAME ${methodName}] : [SKIPPING...]`);
      return [];
    case 'updateContracts':
      return await updateContracts(args);
  }

  const methodNameParts = methodName
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .split(' ');
  methodNameParts[0] =
    methodNameParts[0].charAt(0).toUpperCase() + methodNameParts[0].slice(1);

  return [
    {
      id: 0,
      title: methodNameParts.join(' '),
      description: ''
    }
  ];
}

async function createCollection(
  entityManager: EntityManager,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const name = args[0];
  const artist = args[1];
  const collectionId = await fetchNextGenCollectionIndex(
    entityManager,
    name,
    artist
  );
  const image = getCollectionImage(collectionId);
  const banner = getCollectionBanner(collectionId);
  const distributionPlan = getCollectionDistribution(collectionId);
  const collection: NextGenCollection = {
    id: collectionId,
    name: name,
    artist: artist,
    description: args[2],
    website: args[3],
    licence: args[4],
    base_uri: args[5],
    library: args[6],
    dependency_script: args[7],
    image: image,
    banner: banner,
    distribution_plan: distributionPlan,
    mint_count: 0
  };
  await persistNextGenCollection(entityManager, collection);

  const log = getCollectionLog(collection);
  return [
    {
      id: collectionId,
      title: log.title,
      description: log.log
    }
  ];
}

async function updateCollectionInfo(
  entityManager: EntityManager,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const image = getCollectionImage(collectionId);
  const banner = getCollectionBanner(collectionId);
  const distributionPlan = getCollectionDistribution(collectionId);
  const collection: NextGenCollection = {
    id: collectionId,
    name: args[1],
    artist: args[2],
    description: args[3],
    website: args[4],
    licence: args[5],
    base_uri: args[6],
    library: args[7],
    dependency_script: args[8],
    image: image,
    banner: banner,
    distribution_plan: distributionPlan,
    mint_count: 0
  };
  const scriptIndex = parseInt(args[9]);
  const newScript = args[10];
  let title: string;
  let description: string;
  if (scriptIndex === 1000000) {
    const log = getCollectionLog(collection, true);
    title = log.title;
    description = log.log;
  } else if (scriptIndex === 999999) {
    title = 'Collection Base URI Updated';
    description = `Base URI updated to: ${collection.base_uri}`;
  } else {
    title = `Script at index ${scriptIndex} Updated`;
    description = `Script at index ${scriptIndex} updated to: ${newScript}`;
  }
  await persistNextGenCollection(entityManager, collection);
  return [
    {
      id: collectionId,
      title: title,
      description: description
    }
  ];
}

async function artistSignature(
  entityManager: EntityManager,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const id = parseInt(args[0]);
  const signature = args[1];
  const collection = await fetchNextGenCollection(entityManager, id);
  if (!collection) {
    logger.info(
      `[METHOD NAME ARTIST SIGNATURE] : [COLLECTION ID ${id} NOT FOUND]`
    );
    return [];
  }
  collection.artist_signature = signature;
  await persistNextGenCollection(entityManager, collection);
  const artistAddress = collection.artist_address ?? '';

  let artistEns;
  try {
    artistEns = await getEns(artistAddress);
    logger.info(
      `[LOOKUP ARTIST ADDRESS] : [ADDRESS ${artistAddress}] : [ENS ${artistEns}]`
    );
  } catch (error) {
    logger.error(`[LOOKUP ARTIST ADDRESS ERROR] : [ADDRESS ${artistAddress}]`);
  }

  const artistDisplay = `${
    artistEns ? `${artistEns} (${artistAddress})` : artistAddress
  }`;

  return [
    {
      id: id,
      title: 'Artist Signature Added',
      description: `By: ${artistDisplay} - Signature: ${signature}`
    }
  ];
}

async function setCollectionData(
  entityManager: EntityManager,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const id = parseInt(args[0]);
  const artistAddress = args[1];
  const maxPurchases = parseInt(args[2]);
  const totalSupply = parseInt(args[3]);
  const finalSupplyAfterMint = parseInt(args[4]);

  const collection = await fetchNextGenCollection(entityManager, id);
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
  await persistNextGenCollection(entityManager, collection);

  const artistEns = await getEns(artistAddress);
  const finalSupplyDisplay =
    finalSupplyAfterMint > 0
      ? ` - Final Supply After Mint: ${finalSupplyAfterMint.toLocaleString()}`
      : '';

  return [
    {
      id: id,
      title: 'Collection Data Set',
      description: `Artist Address: ${
        artistEns ? `${artistEns} (${artistAddress})` : artistAddress
      } - Max Purchases: ${maxPurchases.toLocaleString()} - Total Supply: ${totalSupply.toLocaleString()}${finalSupplyDisplay}`
    }
  ];
}

async function changeMetadataView(
  entityManager: EntityManager,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const id = parseInt(args[0]);
  const onChain: boolean = args[1];

  const collection = await fetchNextGenCollection(entityManager, id);
  if (!collection) {
    logger.info(
      `[METHOD NAME CHANGE METADATA VIEW] : [COLLECTION ID ${id} NOT FOUND]`
    );
    return [];
  }
  collection.on_chain = onChain;
  await persistNextGenCollection(entityManager, collection);

  return [
    {
      id: id,
      title: 'Metadata View Changed',
      description: `Metadata View Changed to: ${
        onChain ? 'On-Chain' : 'Off-Chain'
      }`
    }
  ];
}

async function updateImagesAndAttributes(
  entityManager: EntityManager,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const tokenIds: any[] = args[0];
  const logs: any[] = [];
  for (const tokenId of tokenIds) {
    const tokenIdInt = parseInt(tokenId);
    const collectionId = Math.round(tokenId / 10000000000);
    const collection = await fetchNextGenCollection(
      entityManager,
      collectionId
    );
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

async function addRandomizer(args: ethers.Result): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const randomizer = args[1];
  const randomizerSource: any = await getSourceCodeForContract(randomizer);
  const randomizerName = randomizerSource?.result[0]?.ContractName;
  return [
    {
      id: collectionId,
      title: 'Randomizer Added',
      description: `Randomizer Added - ${
        randomizerName ? `${randomizerName} (${randomizer})` : randomizer
      }`
    }
  ];
}

async function changeTokenData(args: ethers.Result): Promise<
  {
    id: number;
    token_id: number;
    title: string;
    description: string;
  }[]
> {
  const tokenId = parseInt(args[0]);
  const newData = args[1];
  const collectionId = Math.round(tokenId / 10000000000);
  const normalisedTokenId = tokenId - collectionId * 10000000000;

  return [
    {
      id: collectionId,
      token_id: tokenId,
      title: 'Token Data Changed',
      description: `Token data for token #${normalisedTokenId} changed to: ${newData}`
    }
  ];
}

async function updateContracts(args: ethers.Result): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const _opt = parseInt(args[0]);
  const contract = args[1];
  let optLog = '';
  if (_opt === 1) {
    optLog = 'Admin ';
  } else if (_opt === 2) {
    optLog = 'Minter ';
  } else if (_opt === 3) {
    optLog = 'Dependency Registry ';
  }
  const log = `${optLog}Contract Updated to: ${contract}`;

  return [
    {
      id: 0,
      title: `${optLog}Contract Updated`,
      description: log
    }
  ];
}

function getCollectionImage(collectionId: number): string {
  const network = getNextgenNetwork();
  return `${NEXTGEN_CF_BASE_PATH}/${
    network === Network.ETH_SEPOLIA || network === Network.ETH_GOERLI
      ? 'testnet'
      : 'mainnet'
  }/png/${collectionId * 10000000000}`;
}

function getCollectionBanner(collectionId: number): string {
  return `${CLOUDFRONT_LINK}/nextgen/assets/${collectionId}/banner.jpg`;
}

function getCollectionDistribution(collectionId: number): string {
  return `${CLOUDFRONT_LINK}/nextgen/assets/${collectionId}/distribution.pdf`;
}

function getCollectionLog(
  collection: NextGenCollection,
  isUpdate?: boolean
): {
  title: string;
  log: string;
} {
  const scriptLog =
    collection.dependency_script.split('0x')[1].replace(/0/g, '').length === 0
      ? 'None'
      : collection.dependency_script;
  const title = `Collection ${isUpdate ? 'Updated' : 'Created'}`;
  const log = `#${collection.id} ${collection.name} by ${collection.artist} - Website: ${collection.website} - Licence: ${collection.licence} - Base URI: ${collection.base_uri} - Library: ${collection.library} - Dependency Script: ${scriptLog} `;
  return {
    title,
    log
  };
}
