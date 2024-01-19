import { Alchemy, Log } from 'alchemy-sdk';
import { NULL_ADDRESS, NULL_ADDRESS_DEAD } from '../constants';
import { Logger } from '../logging';
import { NEXTGEN_CORE_IFACE } from '../abis/nextgen';
import {
  NextGenCollection,
  NextGenLog,
  NextGenToken,
  NextGenTokenTrait,
  NextGenTransaction
} from '../entities/INextGen';
import { LogDescription } from 'ethers/lib/utils';
import { areEqualAddresses } from '../helpers';
import { findTransactionValues } from '../transaction_values';
import {
  fetchNextGenCollection,
  persistNextGenCollection,
  persistNextGenLogs,
  persistNextGenToken,
  persistNextGenTraits,
  persistNextgenTransactions
} from './nextgen.db';
import { EntityManager } from 'typeorm';
import { NEXTGEN_CORE_CONTRACT, getNextgenNetwork } from './nextgen_constants';

const logger = Logger.get('NEXTGEN_CORE_EVENTS');

let alchemy: Alchemy;

export async function findCoreEvents(
  entityManager: EntityManager,
  a: Alchemy,
  startBlock: number,
  endBlock: number,
  pageKey?: string
) {
  alchemy = a;
  logger.info(
    `[FINDING EVENTS] : [START BLOCK ${startBlock}] : [END BLOCK ${endBlock}] : [PAGE KEY ${pageKey}]`
  );

  const response = await alchemy.core.getLogs({
    address: NEXTGEN_CORE_CONTRACT[getNextgenNetwork()],
    fromBlock: `0x${startBlock.toString(16)}`,
    toBlock: `0x${endBlock.toString(16)}`
  });

  const logs: NextGenLog[] = [];
  for (const log of response) {
    const processedLog = await processLog(entityManager, log);
    if (processedLog) {
      const blockTimestamp = (await alchemy.core.getBlock(log.blockNumber))
        .timestamp;
      const l: NextGenLog = {
        id: `${log.transactionHash}-${log.logIndex}`,
        transaction: log.transactionHash,
        block: log.blockNumber,
        block_timestamp: blockTimestamp,
        collection_id: processedLog.id,
        log: processedLog.description,
        source: 'events'
      };
      logs.push(l);
    }
  }
  await persistNextGenLogs(entityManager, logs);
}

async function processLog(
  entityManager: EntityManager,
  log: Log
): Promise<{
  id: number;
  description: string;
} | null> {
  const parsedLog = NEXTGEN_CORE_IFACE.parseLog(log);

  switch (parsedLog.name) {
    case 'OwnershipTransferred':
      const previousOwner = parsedLog.args.previousOwner;
      if (areEqualAddresses(NULL_ADDRESS, previousOwner)) {
        return {
          id: 0,
          description: 'NextGen Contract Deployed'
        };
      } else {
        return {
          id: 0,
          description: 'Ownership Transferred'
        };
      }
    case 'Transfer':
      return await processTransfer(entityManager, log, parsedLog);
  }

  return null;
}

async function processTransfer(
  entityManager: EntityManager,
  log: Log,
  logInfo: LogDescription
): Promise<{
  id: number;
  description: string;
}> {
  const network = getNextgenNetwork();

  const blockTimestamp = (await alchemy.core.getBlock(log.blockNumber))
    .timestamp;

  const tokenId = parseInt(logInfo.args.tokenId);
  const collectionId = Math.round(tokenId / 10000000000);
  const normalisedTokenId = tokenId - collectionId * 10000000000;

  const collection = await fetchNextGenCollection(entityManager, collectionId);
  if (!collection) {
    logger.info(`[UPSERT TOKEN] : [COLLECTION ID ${collectionId} NOT FOUND]`);
  }

  const transaction: NextGenTransaction = {
    created_at: new Date(),
    transaction: log.transactionHash,
    block: log.blockNumber,
    transaction_date: new Date(blockTimestamp * 1000),
    from_address: logInfo.args.from,
    to_address: logInfo.args.to,
    contract: NEXTGEN_CORE_CONTRACT[network],
    token_id: parseInt(logInfo.args.tokenId),
    token_count: 1,
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0
  };

  const transactionWithValue: NextGenTransaction = (
    await findTransactionValues([transaction], network)
  )[0];

  const isMint = areEqualAddresses(logInfo.args.from, NULL_ADDRESS);
  const isSale = transactionWithValue.value > 0;
  let description = 'Transfer';

  if (isMint) {
    description = 'Mint';
  } else if (
    areEqualAddresses(logInfo.args.to, NULL_ADDRESS) ||
    areEqualAddresses(logInfo.args.to, NULL_ADDRESS_DEAD)
  ) {
    description = 'Burn';
  } else if (isSale) {
    description = `Sale`;
  }
  description += ` of ${
    collection?.name ?? collectionId
  } #${normalisedTokenId}`;

  if (transactionWithValue.value) {
    description += ` for ${transactionWithValue.value} ETH`;
  }

  await persistNextgenTransactions(entityManager, [transactionWithValue]);

  if (collection) {
    await upsertToken(
      entityManager,
      collection,
      tokenId,
      normalisedTokenId,
      logInfo.args.to,
      isMint
    );
  }

  return {
    id: collectionId,
    description: description
  };
}

export async function upsertToken(
  entityManager: EntityManager,
  collection: NextGenCollection,
  tokenId: number,
  normalisedTokenId: number,
  owner: string,
  isMint: boolean
) {
  const metadataLink = `${collection.base_uri}${tokenId}`;
  try {
    const metadataResponse: any = await (await fetch(metadataLink)).json();
    const pending = metadataResponse.name.toLowerCase().startsWith('pending');

    const nextGenToken: NextGenToken = {
      id: tokenId,
      normalised_id: normalisedTokenId,
      name: metadataResponse.name,
      collection_id: collection.id,
      collection_name: collection.name,
      metadata_url: metadataLink,
      image_url: metadataResponse.image,
      animation_url: metadataResponse.animation_url,
      generator_url: metadataResponse.generator_url,
      owner: owner.toLowerCase(),
      pending: pending
    };

    if (isMint) {
      logger.info(
        `[TOKEN ID ${tokenId}] : [MINTED] : [COLLECTION MINT COUNT ${collection.mint_count}] : [UPDATING COLLECTION MINT COUNT...]`
      );
      collection.mint_count += 1;
      await persistNextGenCollection(entityManager, collection);
    }
    await persistNextGenToken(entityManager, nextGenToken);

    if (metadataResponse.attributes) {
      await processTraits(
        entityManager,
        tokenId,
        collection.id,
        metadataResponse.attributes
      );
    }
  } catch (e) {
    logger.info(
      `[TOKEN ID ${tokenId}] : [ERROR FETCHING METADATA] : [METADATA LINK ${metadataLink}] : [ERROR ${e}]`
    );
  }
}

export async function processTraits(
  entityManager: EntityManager,
  tokenId: number,
  collectionId: number,
  attributes: { trait_type: string; value: string }[]
) {
  const tokenTraits: NextGenTokenTrait[] = [];
  for (const attribute of attributes) {
    const tokenTrait: NextGenTokenTrait = {
      token_id: tokenId,
      collection_id: collectionId,
      trait: attribute.trait_type,
      value: attribute.value
    };
    tokenTraits.push(tokenTrait);
  }

  await persistNextGenTraits(entityManager, tokenTraits);
}
