import { Alchemy, Log } from 'alchemy-sdk';
import {
  NEXTGEN_CORE_CONTRACT,
  NEXTGEN_NETWORK,
  NULL_ADDRESS
} from '../constants';
import { Logger } from '../logging';
import { NEXTGEN_CORE_IFACE } from '../abis/nextgen';
import {
  NextGenCollection,
  NextGenLog,
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
  persistNextgenTransactions
} from '../db';

const logger = Logger.get('NEXTGEN_CORE_EVENTS');

let alchemy: Alchemy;

export async function findCoreEvents(
  a: Alchemy,
  startBlock: number,
  endBlock: number,
  pageKey: string | undefined
) {
  alchemy = a;
  logger.info(
    `[FINDING EVENTS] : [START BLOCK ${startBlock}] : [END BLOCK ${endBlock}] : [PAGE KEY ${pageKey}]`
  );

  const response = await alchemy.core.getLogs({
    address: NEXTGEN_CORE_CONTRACT[NEXTGEN_NETWORK],
    fromBlock: `0x${startBlock.toString(16)}`,
    toBlock: `0x${endBlock.toString(16)}`
  });

  const logs: NextGenLog[] = [];
  for (const log of response) {
    const processedLog = await processLog(log);
    if (processedLog) {
      const l: NextGenLog = {
        transaction: log.transactionHash,
        block: log.blockNumber,
        collection_id: processedLog.id,
        log: processedLog.description,
        source: 'transactions'
      };
      logs.push(l);
    }
  }
  await persistNextGenLogs(logs);
}

async function processLog(log: Log): Promise<{
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
      return await processTransfer(log, parsedLog);
  }

  return null;
}

async function processTransfer(
  log: Log,
  logInfo: LogDescription
): Promise<{
  id: number;
  description: string;
}> {
  const blockTimestamp = (await alchemy.core.getBlock(log.blockNumber))
    .timestamp;

  const tokenId = parseInt(logInfo.args.tokenId);
  const collectionId = Math.round(tokenId / 10000000000);
  const normalisedTokenId = tokenId - collectionId * 10000000000;

  const collection = await fetchNextGenCollection(collectionId);
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
    contract: NEXTGEN_CORE_CONTRACT[NEXTGEN_NETWORK],
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
    await findTransactionValues([transaction], NEXTGEN_NETWORK)
  )[0];

  const isMint = areEqualAddresses(logInfo.args.from, NULL_ADDRESS);
  let description = 'Transfer';

  if (isMint) {
    description = 'Mint';
  } else if (areEqualAddresses(logInfo.args.to, NULL_ADDRESS)) {
    description = 'Burn';
  } else if (transactionWithValue.value > 0) {
    description += `Sale`;
  }
  description += ` of ${
    collection?.name ?? collectionId
  } #${normalisedTokenId}`;

  await persistNextgenTransactions([transactionWithValue]);

  if (collection) {
    await upsertToken(
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
  collection: NextGenCollection,
  tokenId: number,
  normalisedTokenId: number,
  owner: string,
  isMint: boolean
) {
  const metadataLink = `${collection.base_uri}${tokenId}`;
  const metadataResponse: any = await (await fetch(metadataLink)).json();
  const nextGenToken = {
    id: tokenId,
    normalised_id: normalisedTokenId,
    collection_id: collection.id,
    name: metadataResponse.name,
    metadata_url: metadataLink,
    image_url: metadataResponse.image,
    animation_url: metadataResponse.animation_url,
    generator_url: metadataResponse.generator_url,
    owner: owner
  };

  if (isMint) {
    collection.mint_count += 1;
    await persistNextGenCollection(collection);
  }
  await persistNextGenToken(nextGenToken);
}
