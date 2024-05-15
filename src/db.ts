import 'reflect-metadata';
import { DataSource, LessThan, MoreThanOrEqual, QueryRunner } from 'typeorm';
import {
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NFTS_TABLE,
  TDH_BLOCKS_TABLE,
  TRANSACTIONS_TABLE,
  WALLETS_TDH_TABLE
} from './constants';

import { NFT } from './entities/INFT';
import { ConsolidatedTDH, TDH, TDHBlock } from './entities/ITDH';
import { BaseTransaction, Transaction } from './entities/ITransaction';
import {
  Consolidation,
  ConsolidationEvent,
  Delegation,
  DelegationEvent,
  EventType,
  NFTDelegationBlock
} from './entities/IDelegation';
import { extractConsolidationWallets, isNullAddress } from './helpers';
import { getConsolidationsSql, parseTdhDataFromDB } from './sql_helpers';
import { ConnectionWrapper, setSqlExecutor, sqlExecutor } from './sql-executor';
import { Logger } from './logging';
import { DbQueryOptions } from './db-query.options';
import { Time } from './time';
import { insertWithoutUpdate, resetRepository } from './orm_helpers';
import { NFTOwner } from './entities/INFTOwner';

const mysql = require('mysql');

const logger = Logger.get('DB');

let AppDataSource: DataSource;

export async function connect() {
  if (AppDataSource?.isInitialized) {
    logger.info('[DB CONNECTION ALREADY ESTABLISHED]');
    return;
  }

  logger.info(`[DB HOST ${process.env.DB_HOST}]`);

  if (
    !process.env.DB_HOST ||
    !process.env.DB_PORT ||
    !process.env.DB_USER ||
    !process.env.DB_PASS ||
    !process.env.DB_NAME
  ) {
    logger.error('[MISSING CONFIGURATION FOR READ DB] [EXITING]');
    process.exit(1);
  }

  const host = process.env.DB_HOST;
  const port = parseInt(process.env.DB_PORT);
  const user = process.env.DB_USER;
  const password = process.env.DB_PASS;
  const database = process.env.DB_NAME;

  AppDataSource = await createDataSource(host, port, user, password, database, [
    Transaction,
    TDH,
    ConsolidatedTDH,
    NFT,
    NFTOwner,
    TDHBlock,
    Delegation,
    Consolidation,
    NFTDelegationBlock
  ]);

  setSqlExecutor({
    execute: (
      sql: string,
      params?: Record<string, any>,
      options?: DbQueryOptions
    ) => execSQLWithParams(sql, params, options),
    executeNativeQueriesInTransaction(executable) {
      return execNativeTransactionally(executable);
    }
  });
  logger.info(
    `[CONNECTION CREATED] [APP DATA SOURCE ${
      !AppDataSource.isInitialized ? 'NOT ' : ''
    }INITIALIZED] : [HOST ${host}:${port}] : [DB ${database}]`
  );
}

export async function createDataSource(
  host: string,
  port: number,
  username: string,
  password: string,
  database?: string,
  entities?: any[]
) {
  const source = new DataSource({
    type: 'mysql',
    host,
    port,
    username,
    password,
    database,
    entities: entities,
    synchronize: true,
    logging: false
  });

  await source.initialize().catch((error) => logger.error(error));
  return source;
}

export function getDataSource() {
  return AppDataSource;
}

export async function disconnect() {
  await AppDataSource.destroy();
  logger.info('[DISCONNECTED]');
}

export function consolidateTransactions(
  transactions: BaseTransaction[]
): BaseTransaction[] {
  const consolidatedTransactions: BaseTransaction[] = Object.values(
    transactions.reduce((acc: any, transaction) => {
      const primaryKey = `${transaction.transaction}_${transaction.from_address}_${transaction.to_address}_${transaction.contract}_${transaction.token_id}`;

      if (!acc[primaryKey]) {
        acc[primaryKey] = transaction;
      }

      return acc;
    }, {})
  );
  return consolidatedTransactions;
}

async function execNativeTransactionally<T>(
  executable: (connectionHolder: ConnectionWrapper<QueryRunner>) => Promise<T>
): Promise<T> {
  const queryRunner = AppDataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    const result = await executable({ connection: queryRunner });
    await queryRunner.commitTransaction();
    return result;
  } catch (err: any) {
    logger.error(`Database transaction failed [${err}]`);
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw err;
  } finally {
    queryRunner.release();
  }
}

function prepareStatement(
  sql: string,
  params: { [p: string]: any } | Record<string, any> | undefined
) {
  return sql.replace(/:(\w+)/g, function (txt: string, key: string) {
    if (params?.hasOwnProperty(key)) {
      const val = params[key];
      if (Array.isArray(val)) {
        return val.map((v) => mysql.escape(v)).join(', ');
      }
      return mysql.escape(val);
    }
    return txt;
  });
}

export async function execSQLWithParams(
  sql: string,
  params?: Record<string, any>,
  options?: { wrappedConnection?: ConnectionWrapper<QueryRunner> }
): Promise<any> {
  const givenConnection = options?.wrappedConnection?.connection;
  const preparedStatement = prepareStatement(sql, params);
  if (givenConnection) {
    return givenConnection
      .query(preparedStatement)
      .then((result) => Object.values(JSON.parse(JSON.stringify(result))));
  }
  return AppDataSource.manager
    .query(preparedStatement)
    .then((result) => Object.values(JSON.parse(JSON.stringify(result))));
}

export async function findTransactionsByHash(
  table: string,
  hashes: string[]
): Promise<Transaction[]> {
  const sql = `SELECT * FROM ${table} WHERE transaction in (${mysql.escape(
    hashes
  )}) ORDER BY transaction_date DESC;`;
  const results = await sqlExecutor.execute(sql);
  return results;
}

export async function retrieveWalletConsolidations(wallet: string) {
  const sql = getConsolidationsSql();
  const consolidations: any[] = await sqlExecutor.execute(sql, {
    wallet: wallet
  });
  return extractConsolidationWallets(consolidations, wallet);
}

export async function fetchLatestConsolidationsBlockNumber() {
  const block = await AppDataSource.getRepository(Consolidation)
    .createQueryBuilder()
    .select('MAX(block)', 'maxBlock')
    .getRawOne();
  return block.maxBlock;
}

export async function fetchLatestNftDelegationBlock(): Promise<number> {
  const repo = AppDataSource.getRepository(NFTDelegationBlock);
  const block = await repo
    .createQueryBuilder()
    .select('MAX(block)', 'maxBlock')
    .getRawOne();
  return block.maxBlock ?? 0;
}

export async function persistNftDelegationBlock(
  blockNo: number,
  timestamp: number
) {
  const block = new NFTDelegationBlock();
  block.block = blockNo;
  block.timestamp = timestamp;
  await AppDataSource.getRepository(NFTDelegationBlock).save(block);
}

export async function fetchLatestTransactionsBlockNumber(
  beforeDate?: Date
): Promise<number> {
  let sql = `SELECT block FROM ${TRANSACTIONS_TABLE}`;
  const params: any = {};
  if (beforeDate) {
    sql += ` WHERE UNIX_TIMESTAMP(transaction_date) <= :date`;
    params.date = beforeDate.getTime() / 1000;
  } else {
    sql += ` WHERE contract in (:contracts)`;
    params.contracts = [MEMES_CONTRACT, GRADIENT_CONTRACT];
  }
  sql += ` order by block desc limit 1;`;
  const r = await sqlExecutor.execute(sql, params);
  return r.length > 0 ? r[0].block : 0;
}

export async function fetchLatestTDHBDate(): Promise<Time> {
  const sql = `SELECT timestamp FROM ${TDH_BLOCKS_TABLE} order by block desc limit 1;`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0 ? Time.millis(r[0].timestamp) : Time.millis(0);
}

export async function fetchLatestTDHBlockNumber(): Promise<number> {
  const sql = `SELECT block FROM ${TDH_BLOCKS_TABLE} order by block desc limit 1;`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0 ? r[0].block : 0;
}

export async function fetchAllTransactions() {
  const sql = `SELECT * FROM ${TRANSACTIONS_TABLE} ORDER BY transaction_date ASC;`;
  const results = await sqlExecutor.execute(sql);
  return results;
}

export async function fetchNftsForContract(contract: string, orderBy?: string) {
  let sql = `SELECT * from ${NFTS_TABLE} WHERE contract=:contract`;
  const params = {
    contract: contract
  };

  if (orderBy) {
    sql += ` order by ${orderBy}`;
  }
  return await sqlExecutor.execute(sql, params);
}

export async function fetchAllNFTs() {
  const sql = `SELECT * FROM ${NFTS_TABLE};`;
  const results = await sqlExecutor.execute(sql);
  results.map((r: any) => (r.metadata = JSON.parse(r.metadata)));
  return results;
}

export async function fetchAllTDH(wallets?: string[]) {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  let sql = `SELECT * FROM ${WALLETS_TDH_TABLE} WHERE block=:block `;
  if (wallets && wallets.length > 0) {
    sql += `AND ${WALLETS_TDH_TABLE}.wallet IN (:wallets)`;
  }
  const results = await sqlExecutor.execute(sql, { block: tdhBlock, wallets });
  return results.map(parseTdhDataFromDB);
}

export async function fetchAllConsolidatedOwnerMetrics() {
  const metrics = await AppDataSource.getRepository(ConsolidatedTDH).find();
  return metrics;
}

export async function fetchAllConsolidatedOwnerMetricsCount() {
  const count = await AppDataSource.getRepository(ConsolidatedTDH).count();
  return count;
}

export async function fetchAllConsolidatedTdh() {
  const tdh = await AppDataSource.getRepository(ConsolidatedTDH).find();
  return tdh;
}

export async function fetchMaxTransactionsBlockNumber(): Promise<number> {
  const sql = `SELECT MAX(block) as max_block FROM ${TRANSACTIONS_TABLE};`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0 ? r[0].max_block : 0;
}

export async function fetchMaxTransactionByBlockNumber(): Promise<Transaction> {
  const sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE block = (SELECT MAX(block) FROM ${TRANSACTIONS_TABLE});`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0 ? r[0] : null;
}

export async function fetchTransactionAddressesFromBlock(
  contracts: string[],
  fromBlock: number,
  toBlock?: number
) {
  return await sqlExecutor.execute(
    `SELECT from_address, to_address FROM ${TRANSACTIONS_TABLE} WHERE block > :fromBlock and contract in (:contracts) ${
      toBlock ? 'AND block <= :toBlock' : ''
    }`,
    {
      contracts: contracts.map((it) => it.toLowerCase()),
      fromBlock: fromBlock,
      toBlock: toBlock
    }
  );
}

export async function fetchTransactionsAfterBlock(
  contracts: string[],
  fromBlock: number,
  toBlock?: number
): Promise<Transaction[]> {
  return await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE block > :fromBlock and contract in (:contracts) ${
      toBlock ? 'AND block <= :toBlock' : ''
    }`,
    {
      contracts: contracts.map((it) => it.toLowerCase()),
      fromBlock: fromBlock,
      toBlock: toBlock
    }
  );
}

export async function fetchAllConsolidationAddresses() {
  const sql = `SELECT wallet FROM (
      SELECT wallet1 AS wallet FROM consolidations WHERE confirmed = 1
      UNION
      SELECT wallet2 AS wallet FROM consolidations WHERE confirmed = 1
  ) AS unique_wallets;`;

  const results = await sqlExecutor.execute(sql);
  return results;
}

export async function fetchWalletTransactions(
  contracts: string[],
  wallet: string,
  block?: number
) {
  const sql = `SELECT * FROM ${TRANSACTIONS_TABLE}`;
  const params: any = {
    contracts: contracts.map((it) => it.toLowerCase())
  };

  let filters;
  if (isNullAddress(wallet)) {
    filters = constructFilters('filters', `to_address = :wallet`);
    params.wallet = wallet;
  } else {
    filters = constructFilters(
      'filters',
      `(from_address = :from_address OR to_address = :to_address)`
    );
    params.from_address = wallet;
    params.to_address = wallet;
  }

  if (block) {
    filters = constructFilters(filters, `block <= :block`);
    params.block = block;
  }

  filters = constructFilters(filters, `contract in (:contracts)`);

  const fullSql = `${sql} ${filters}`;

  return await sqlExecutor.execute(fullSql, params);
}

export async function persistNFTs(nfts: NFT[]) {
  await AppDataSource.transaction(async (manager) => {
    const nftRepo = manager.getRepository(NFT);
    await resetRepository(nftRepo, nfts);
  });
}

export async function persistTDH(
  block: number,
  tdh: TDH[],
  wallets?: string[]
) {
  logger.info(`[TDH] [PERSISTING WALLETS TDH ${tdh.length}]`);

  await AppDataSource.transaction(async (manager) => {
    const tdhRepo = manager.getRepository(TDH);
    if (wallets) {
      logger.info(`[TDH] [DELETING ${wallets.length} WALLETS]`);
      await Promise.all(
        wallets.map(async (wallet) => {
          await tdhRepo
            .createQueryBuilder()
            .delete()
            .where('LOWER(wallet) = :wallet AND block = :block ', {
              wallet: wallet.toLowerCase(),
              block: block
            })
            .execute();
        })
      );
      await tdhRepo.save(tdh);
    } else {
      logger.info(`[TDH] [DELETING ALL WALLETS FOR BLOCK ${block}]`);
      await tdhRepo.delete({ block: block });
      logger.info(`[TDH] [CLEARED]`);
      await insertWithoutUpdate(tdhRepo, tdh);
    }
  });

  logger.info(`[TDH] [PERSISTED ALL WALLETS TDH [${tdh.length}]`);
}

export async function persistTDHBlock(block: number, timestamp: Date) {
  await getDataSource()
    .getRepository(TDHBlock)
    .upsert([{ block: block, timestamp: timestamp.getTime() }], ['block']);
}

export async function persistConsolidatedTDH(
  tdh: ConsolidatedTDH[],
  wallets?: string[]
) {
  logger.info(`[CONSOLIDATED TDH] [PERSISTING WALLETS TDH ${tdh.length}]`);
  await sqlExecutor.executeNativeQueriesInTransaction(async (qrHolder) => {
    const queryRunner = qrHolder.connection as QueryRunner;
    const manager = queryRunner.manager;
    const tdhRepo = manager.getRepository(ConsolidatedTDH);
    if (wallets) {
      logger.info(`[CONSOLIDATED TDH] [DELETING ${wallets.length} WALLETS]`);
      await Promise.all(
        wallets.map(async (wallet) => {
          const walletPattern = `%${wallet}%`;
          await tdhRepo
            .createQueryBuilder()
            .delete()
            .where('consolidation_key like :walletPattern', {
              walletPattern
            })
            .execute();
        })
      );
      await tdhRepo.save(tdh);
    } else {
      logger.info(`[CONSOLIDATED TDH] [DELETING ALL WALLETS]`);
      await tdhRepo.clear();
      logger.info(`[CONSOLIDATED TDH] [CLEARED]`);
      await insertWithoutUpdate(tdhRepo, tdh);
    }
  });

  logger.info(`[CONSOLIDATED TDH] [PERSISTED ALL WALLETS TDH ${tdh.length}]`);
}

function constructFilters(f: string, newF: string) {
  if (f.trim().toUpperCase().startsWith('WHERE')) {
    return ` ${f} AND ${newF} `;
  }
  return ` WHERE ${newF} `;
}

export async function fetchRoyalties(startDate: Date, endDate: Date) {
  const sql = `
  SELECT t.contract, t.token_id, SUM(t.royalties) AS total_royalties,
      COUNT(DISTINCT t.transaction, t.contract, t.token_id) AS transactions_count,
      SUM(t.token_count) AS token_count, nfts.artist
  FROM (
      SELECT * FROM ${TRANSACTIONS_TABLE} 
      WHERE royalties > 0 AND transaction_date >= :start_date AND transaction_date <= :end_date
      ORDER BY transaction_date desc
  ) t
  JOIN ${NFTS_TABLE} ON nfts.id = t.token_id and nfts.contract = t.contract
  GROUP BY t.contract, t.token_id, nfts.artist;`;

  const results = await sqlExecutor.execute(sql, {
    start_date: startDate,
    end_date: endDate
  });
  return results;
}

export async function persistConsolidations(
  startBlock: number | undefined,
  consolidations: ConsolidationEvent[]
) {
  logger.info(
    `[CONSOLIDATIONS] [START_BLOCK ${startBlock}] [PERSISTING ${consolidations.length} RESULTS]`
  );

  const repo = AppDataSource.getRepository(Consolidation);

  if (startBlock) {
    //delete all with block >= startBlock
    await repo.delete({
      block: MoreThanOrEqual(startBlock)
    });
  }

  for (const consolidation of consolidations) {
    if (consolidation.type == EventType.REGISTER) {
      const r = await repo.findOne({
        where: {
          wallet1: consolidation.wallet1,
          wallet2: consolidation.wallet2
        }
      });
      if (r) {
        // do nothing
      } else {
        const r2 = await repo.findOne({
          where: {
            wallet1: consolidation.wallet2,
            wallet2: consolidation.wallet1
          }
        });
        if (r2) {
          await repo.remove(r2);
          const updatedConsolidation = new Consolidation();
          updatedConsolidation.block = consolidation.block;
          updatedConsolidation.wallet1 = consolidation.wallet2;
          updatedConsolidation.wallet2 = consolidation.wallet1;
          updatedConsolidation.confirmed = true;
          await repo.save(updatedConsolidation);
        } else {
          const newConsolidation = new Consolidation();
          newConsolidation.block = consolidation.block;
          newConsolidation.wallet1 = consolidation.wallet1;
          newConsolidation.wallet2 = consolidation.wallet2;
          await repo.save(newConsolidation);
        }
      }
    } else if (consolidation.type == EventType.REVOKE) {
      const r = await repo.findOne({
        where: {
          wallet1: consolidation.wallet1,
          wallet2: consolidation.wallet2
        }
      });
      if (r) {
        if (r.confirmed) {
          await repo.remove(r);
          const newConsolidation = new Consolidation();
          newConsolidation.block = consolidation.block;
          newConsolidation.wallet1 = consolidation.wallet2;
          newConsolidation.wallet2 = consolidation.wallet1;
          await repo.save(newConsolidation);
        } else {
          await repo.remove(r);
        }
      } else {
        const r2 = await repo.findOne({
          where: {
            wallet1: consolidation.wallet2,
            wallet2: consolidation.wallet1
          }
        });
        if (r2) {
          await repo.remove(r2);
          const updatedConsolidation = new Consolidation();
          updatedConsolidation.block = consolidation.block;
          updatedConsolidation.wallet1 = consolidation.wallet2;
          updatedConsolidation.wallet2 = consolidation.wallet1;
          updatedConsolidation.confirmed = false;
          await repo.save(updatedConsolidation);
        }
      }
    }
  }

  logger.info(
    `[CONSOLIDATIONS] [ALL ${consolidations.length} RESULTS PERSISTED]`
  );
}

export async function persistDelegations(
  startBlock: number | undefined,
  registrations: DelegationEvent[],
  revocations: DelegationEvent[]
) {
  logger.info(
    `[DELEGATIONS] [START_BLOCK ${startBlock}] [PERSISTING ${registrations.length} REGISTRATIONS] [PERSISTING ${revocations.length} REVOCATIONS]`
  );

  const repo = AppDataSource.getRepository(Delegation);

  if (startBlock) {
    //delete all with block >= startBlock
    await repo.delete({
      block: MoreThanOrEqual(startBlock)
    });
  }

  for (const registration of registrations) {
    const newDelegation = new Delegation();
    newDelegation.block = registration.block;
    newDelegation.from_address = registration.wallet1;
    newDelegation.to_address = registration.wallet2;
    newDelegation.collection = registration.collection;
    newDelegation.use_case = registration.use_case;
    if (registration.expiry) {
      newDelegation.expiry = registration.expiry;
    }
    if (registration.all_tokens) {
      newDelegation.all_tokens = registration.all_tokens;
    }
    if (registration.token_id) {
      newDelegation.token_id = registration.token_id;
    }
    await repo.save(newDelegation);
  }

  for (const revocation of revocations) {
    const r = await repo.find({
      where: {
        from_address: revocation.wallet1,
        to_address: revocation.wallet2,
        use_case: revocation.use_case,
        collection: revocation.collection,
        block: LessThan(revocation.block)
      }
    });

    if (r) {
      await repo.remove(r);
    }
  }

  logger.info(
    `[DELEGATIONS] [${registrations.length} REGISTRATIONS PERSISTED] [${revocations.length} REVOCATIONS PERSISTED]`
  );
}
export async function fetchTDHForBlock(block: number) {
  const sql = `SELECT ${WALLETS_TDH_TABLE}.* FROM ${WALLETS_TDH_TABLE} WHERE block=:block;`;
  const results = await sqlExecutor.execute(sql, {
    block: block
  });
  const parsed = results.map((r: any) => parseTdhDataFromDB(r));
  return parsed;
}

export async function persistOwners(owners: NFTOwner[]) {
  const repo = AppDataSource.getRepository(NFTOwner);
  await resetRepository(repo, owners);
  logger.info(`[OWNERS] [PERSISTED ${owners.length} OWNERS]`);
}

export async function fetchMintDate(contract: string, tokenId: number) {
  const firstTransaction = await sqlExecutor.execute(
    `SELECT transaction_date FROM ${TRANSACTIONS_TABLE} WHERE contract=:contract AND token_id=:tokenId ORDER BY transaction_date ASC LIMIT 1`,
    { contract, tokenId }
  );
  return firstTransaction[0]?.transaction_date;
}
