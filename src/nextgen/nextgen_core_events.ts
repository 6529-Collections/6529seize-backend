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
import { areEqualAddresses, isNullAddress } from '../helpers';
import { findTransactionValues } from '../transaction_values';
import {
  fetchNextGenCollection,
  fetchNextgenToken,
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
      if (processedLog.token_id) {
        l.token_id = processedLog.token_id;
      }
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
  token_id?: number;
  description: string;
} | null> {
  const parsedLog = NEXTGEN_CORE_IFACE.parseLog(log);

  switch (parsedLog.name) {
    case 'OwnershipTransferred':
      if (areEqualAddresses(NULL_ADDRESS, parsedLog.args.previousOwner)) {
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
  token_id: number;
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
  const isBurn = isNullAddress(logInfo.args.to);
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
    let hodlRate = 0;
    let mintDate: Date;
    let mintPrice;
    let burnDate: Date | undefined;
    if (isMint) {
      mintDate = transactionWithValue.transaction_date;
      mintPrice = transactionWithValue.value;
    } else {
      const dbToken = await fetchNextgenToken(entityManager, tokenId);
      hodlRate = dbToken?.hodl_rate ?? 0;
      mintDate = dbToken?.mint_date ?? new Date();
      mintPrice = dbToken?.mint_price ?? 0;
      if (isBurn) {
        burnDate = transactionWithValue.transaction_date;
      } else {
        burnDate = dbToken?.burnt_date;
      }
    }
    await upsertToken(
      entityManager,
      collection,
      tokenId,
      normalisedTokenId,
      logInfo.args.to,
      mintDate,
      mintPrice,
      burnDate,
      hodlRate
    );
  }

  return {
    id: collectionId,
    token_id: tokenId,
    description: description
  };
}

export async function upsertToken(
  entityManager: EntityManager,
  collection: NextGenCollection,
  tokenId: number,
  normalisedTokenId: number,
  owner: string,
  mintDate: Date,
  mintPrice: number,
  burnDate: Date | undefined,
  hodlRate: number
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
      mint_date: mintDate,
      mint_price: mintPrice,
      metadata_url: metadataLink,
      image_url: metadataResponse.image,
      animation_url:
        metadataResponse.image?.replace('/png/', '/html/') ??
        metadataResponse.animation_url ??
        metadataResponse.generator?.html ??
        null,
      generator: metadataResponse.generator,
      owner: owner.toLowerCase(),
      pending: pending,
      burnt: !!burnDate,
      burnt_date: burnDate,
      hodl_rate: hodlRate
    };

    if (mintDate) {
      const newMintCount = normalisedTokenId + 1;
      logger.info(
        `[TOKEN ID ${tokenId}] : [MINTED] : [COLLECTION MINT COUNT ${collection.mint_count}] : [UPDATING COLLECTION MINT COUNT TO ${newMintCount}...]`
      );
      collection.mint_count = newMintCount;
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
      value: attribute.value,
      rarity: 0,
      rarity_score: 0,
      rarity_score_rank: 0,
      rarity_score_normalised: 0,
      rarity_score_normalised_rank: 0,
      token_count: 0,
      trait_count: 0
    };
    tokenTraits.push(tokenTrait);
  }

  await persistNextGenTraits(entityManager, tokenTraits);
}
