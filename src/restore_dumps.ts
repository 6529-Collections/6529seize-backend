import {
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  NFTDELEGATION_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from './constants';
import { getDataSource } from './db';
import { BlockEntity } from './entities/IBlock';
import {
  Consolidation,
  Delegation,
  NFTDelegationBlock
} from './entities/IDelegation';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';
import { Logger } from './logging';
import { insertWithoutUpdate } from './orm_helpers';
import { loadEnv } from './secrets';
import { TDH_CONTRACTS } from './tdhLoop/tdh';

const logger = Logger.get('RESTORE_DUMPS');

const BASE_PATH =
  'https://6529bucket.s3.eu-west-1.amazonaws.com/db-dumps/production';

export async function restoreDumps() {
  await loadEnv();
  await restoreTransactions();
  await restoreDelegations();
  await restoreConsolidations();
  await restoreNFTDelegationBlocks();

  logger.info(`[COMPLETE]`);
  process.exit(0);
}

async function getData(path: string) {
  const response = await fetch(`${BASE_PATH}/${path}.csv`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const csvText = await response.text();
  const rows = csvText.split('\n');
  return rows;
}

const getValue = (headers: any[], columns: any[], column: string) => {
  const index = headers.indexOf(column);
  if (index === -1) {
    return null;
  }
  return columns[index];
};

async function restoreTransactions() {
  const tableName = TRANSACTIONS_TABLE;

  logger.info(`[TABLE ${tableName}] : [DOWNLOADING...]`);

  const [headerRow, ...data] = await getData(tableName);

  logger.info(
    `[TABLE ${tableName}] : [FOUND ${data.length} ROWS] : [PARSING...]`
  );

  const headers = headerRow.split(',');

  const transactions: Transaction[] = data.map((row) => {
    const columns = row.split(',');
    return {
      created_at: getValue(headers, columns, 'created_at'),
      transaction: getValue(headers, columns, 'transaction'),
      block: getValue(headers, columns, 'block'),
      transaction_date: getValue(headers, columns, 'transaction_date'),
      from_address: getValue(headers, columns, 'from_address'),
      to_address: getValue(headers, columns, 'to_address'),
      contract: getValue(headers, columns, 'contract'),
      token_id: getValue(headers, columns, 'token_id'),
      token_count: getValue(headers, columns, 'token_count'),
      value: getValue(headers, columns, 'value'),
      primary_proceeds: getValue(headers, columns, 'primary_proceeds'),
      royalties: getValue(headers, columns, 'royalties'),
      gas_gwei: getValue(headers, columns, 'gas_gwei'),
      gas_price: getValue(headers, columns, 'gas_price'),
      gas_price_gwei: getValue(headers, columns, 'gas_price_gwei'),
      gas: getValue(headers, columns, 'gas')
    };
  });

  const filteredTransactions = transactions.filter((t) =>
    TDH_CONTRACTS.some((c: string) => areEqualAddresses(t.contract, c))
  );

  logger.info(
    `[TABLE ${tableName}] : [PARSED ${transactions.length} (${filteredTransactions.length}) TRANSACTIONS] : [RESTORING LOCAL DB]`
  );

  await restoreEntity(tableName, Transaction, filteredTransactions);

  logger.info(`[TABLE ${tableName}] : [RESTORED]`);
}

async function restoreDelegations() {
  const tableName = DELEGATIONS_TABLE;

  logger.info(`[TABLE ${tableName}] : [RESTORING...]`);

  const [headerRow, ...data] = await getData(tableName);

  logger.info(
    `[TABLE ${tableName}] : [FOUND ${data.length} ROWS] : [PARSING...]`
  );

  const headers = headerRow.split(',');

  const delegations: Delegation[] = data.map((row) => {
    const columns = row.split(',');
    return {
      created_at: getValue(headers, columns, 'created_at'),
      block: getValue(headers, columns, 'block'),
      from_address: getValue(headers, columns, 'from_address'),
      to_address: getValue(headers, columns, 'to_address'),
      collection: getValue(headers, columns, 'collection'),
      use_case: getValue(headers, columns, 'use_case'),
      expiry: getValue(headers, columns, 'expiry'),
      all_tokens: getValue(headers, columns, 'all_tokens'),
      token_id: getValue(headers, columns, 'token_id')
    };
  });

  logger.info(
    `[TABLE ${tableName}] : [PARSED ${delegations.length} DELEGATIONS] : [RESTORING LOCAL DB]`
  );

  await restoreEntity(tableName, Delegation, delegations);

  logger.info(`[TABLE ${tableName}] : [RESTORED]`);
}

async function restoreConsolidations() {
  const tableName = CONSOLIDATIONS_TABLE;

  logger.info(`[TABLE ${tableName}] : [RESTORING...]`);

  const [headerRow, ...data] = await getData(tableName);

  logger.info(
    `[TABLE ${tableName}] : [FOUND ${data.length} ROWS] : [PARSING...]`
  );

  const headers = headerRow.split(',');

  const consolidations: Consolidation[] = data.map((row) => {
    const columns = row.split(',');
    return {
      created_at: getValue(headers, columns, 'created_at'),
      block: getValue(headers, columns, 'block'),
      wallet1: getValue(headers, columns, 'wallet1'),
      wallet2: getValue(headers, columns, 'wallet2'),
      confirmed: getValue(headers, columns, 'confirmed')
    };
  });

  logger.info(
    `[TABLE ${tableName}] : [PARSED ${consolidations.length} CONSOLIDATIONS] : [RESTORING LOCAL DB]`
  );

  await restoreEntity(tableName, Consolidation, consolidations);

  logger.info(`[TABLE ${tableName}] : [RESTORED]`);
}

async function restoreNFTDelegationBlocks() {
  const tableName = NFTDELEGATION_BLOCKS_TABLE;

  logger.info(`[TABLE ${tableName}] : [RESTORING...]`);

  const [headerRow, ...data] = await getData(tableName);

  logger.info(
    `[TABLE ${tableName}] : [FOUND ${data.length} ROWS] : [PARSING...]`
  );

  const headers = headerRow.split(',');

  const blocks: BlockEntity[] = data.map((row) => {
    const columns = row.split(',');
    return {
      created_at: getValue(headers, columns, 'created_at'),
      block: getValue(headers, columns, 'block'),
      timestamp: getValue(headers, columns, 'timestamp')
    };
  });

  logger.info(
    `[TABLE ${tableName}] : [PARSED ${blocks.length} BLOCKS] : [RESTORING LOCAL DB]`
  );

  await restoreEntity(tableName, NFTDelegationBlock, blocks);

  logger.info(`[TABLE ${tableName}] : [RESTORED]`);
}

async function restoreEntity(tableName: string, entity: any, data: any) {
  await getDataSource().transaction(async (connection) => {
    const repo = connection.getRepository(entity);
    await connection.query(`TRUNCATE TABLE ${tableName}`);

    // save in chunks of 10000
    const chunkSize = 10000;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      await insertWithoutUpdate(repo, chunk);
      const percentComplete = ((i + chunk.length) / data.length) * 100;
      logger.info(
        `[TABLE ${tableName}] : [${percentComplete.toFixed()}% COMPLETE]`
      );
    }
  });
}

restoreDumps();
