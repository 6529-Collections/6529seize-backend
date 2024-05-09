import 'reflect-metadata';
import { DataSource, LessThan, MoreThanOrEqual, QueryRunner } from 'typeorm';
import {
  ARTISTS_TABLE,
  CONSOLIDATED_UPLOADS_TABLE,
  CONSOLIDATIONS_TABLE,
  ENS_TABLE,
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  TDH_BLOCKS_TABLE,
  TRANSACTIONS_TABLE,
  UPLOADS_TABLE,
  WALLETS_CONSOLIDATION_KEYS_VIEW,
  WALLETS_TDH_TABLE
} from './constants';
import { Artist } from './entities/IArtist';

import { NFT } from './entities/INFT';
import { ConsolidatedTDH, TDH, TDHBlock } from './entities/ITDH';
import { Team } from './entities/ITeam';
import { BaseTransaction, Transaction } from './entities/ITransaction';
import {
  Consolidation,
  ConsolidationEvent,
  Delegation,
  DelegationEvent,
  EventType,
  NFTDelegationBlock,
  WalletConsolidationKey
} from './entities/IDelegation';
import {
  areEqualAddresses,
  extractConsolidationWallets,
  formatAddress,
  isNullAddress
} from './helpers';
import { getConsolidationsSql, parseTdhDataFromDB } from './sql_helpers';
import { ConnectionWrapper, setSqlExecutor, sqlExecutor } from './sql-executor';
import { Logger } from './logging';
import { DbQueryOptions } from './db-query.options';
import { Time } from './time';
import { MemesSeason } from './entities/ISeason';
import { insertWithoutUpdate, resetRepository } from './orm_helpers';
import { NFTOwner } from './entities/INFTOwner';

const mysql = require('mysql');

const logger = Logger.get('DB');

let AppDataSource: DataSource;

export async function connect(entities: any[] = []) {
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

  AppDataSource = await createDataSource(
    host,
    port,
    user,
    password,
    database,
    entities
  );

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
    }INITIALIZED] : [HOST ${host}:${port}] [DB ${database}]`
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

export async function fetchLastUpload(): Promise<any> {
  const sql = `SELECT * FROM ${UPLOADS_TABLE} ORDER BY date DESC LIMIT 1;`;
  const results = await sqlExecutor.execute(sql);
  return results ? results[0] : [];
}

export async function fetchLastConsolidatedUpload(): Promise<any> {
  const sql = `SELECT * FROM ${CONSOLIDATED_UPLOADS_TABLE} ORDER BY date DESC LIMIT 1;`;
  const results = await sqlExecutor.execute(sql);
  return results ? results[0] : [];
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

export async function fetchLatestLabTransactionsBlockNumber(beforeDate?: Date) {
  let sql = `SELECT block FROM ${TRANSACTIONS_TABLE} where contract = :contract`;
  const params: any = {
    contract: MEMELAB_CONTRACT
  };
  if (beforeDate) {
    sql += ` WHERE UNIX_TIMESTAMP(transaction_date) <= :date`;
    params.date = Math.floor(beforeDate.getTime() / 1000);
  }
  sql += ` ORDER BY block DESC LIMIT 1;`;
  const r = await sqlExecutor.execute(sql, params);
  return r.length > 0 ? r[0].block : 0;
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

export async function fetchAllMemeLabTransactions() {
  const sql = `SELECT * FROM ${TRANSACTIONS_TABLE} where contract = :memeLabContract;`;
  return await sqlExecutor.execute(sql, {
    memeLabContract: MEMELAB_CONTRACT
  });
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

export async function fetchAllMemeLabNFTs(orderBy?: string) {
  let sql = `SELECT * FROM ${NFTS_MEME_LAB_TABLE} `;
  if (orderBy) {
    sql += ` order by ${orderBy}`;
  }
  const results = await sqlExecutor.execute(sql);
  results.map((r: any) => {
    r.metadata = JSON.parse(r.metadata);
    r.meme_references = r.meme_references ? JSON.parse(r.meme_references) : [];
  });
  return results;
}

export async function fetchMemesWithSeason() {
  const sql = `SELECT * FROM ${NFTS_TABLE} LEFT JOIN ${MEMES_EXTENDED_DATA_TABLE} ON ${NFTS_TABLE}.id= ${MEMES_EXTENDED_DATA_TABLE}.id WHERE contract = :memes_contract;`;
  const results = await sqlExecutor.execute(sql, {
    memes_contract: MEMES_CONTRACT
  });
  results.map((r: any) => (r.metadata = JSON.parse(r.metadata)));
  return results;
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

export async function fetchConsolidationDisplay(
  myWallets: string[]
): Promise<string> {
  const sql = `SELECT * FROM ${ENS_TABLE} WHERE wallet IN (:wallets)`;
  const results = await sqlExecutor.execute(sql, {
    wallets: myWallets
  });
  const displayArray: string[] = [];
  myWallets.forEach((w) => {
    const result = results.find((r: any) => areEqualAddresses(r.wallet, w));
    if (result?.display && !result.display.includes('?')) {
      displayArray.push(result.display);
    } else {
      displayArray.push(w);
    }
  });

  if (displayArray.length == 1) {
    return displayArray[0];
  }
  const display = displayArray.map((d) => formatAddress(d)).join(' - ');
  return display;
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

export async function fetchAllArtists() {
  const sql = `SELECT * FROM ${ARTISTS_TABLE};`;
  const results = await sqlExecutor.execute(sql);
  results.map((a: any) => {
    a.memes = JSON.parse(a.memes);
    a.memelab = JSON.parse(a.memelab);
    a.gradients = JSON.parse(a.gradients);
    a.work = JSON.parse(a.work);
    a.social_links = JSON.parse(a.social_links);
  });
  return results;
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

export async function fetchEnsRefresh() {
  const sql = `SELECT * FROM ${ENS_TABLE} WHERE created_at < DATE_SUB(NOW(), INTERVAL 6 HOUR) ORDER BY created_at ASC LIMIT 200;`;
  const results = await sqlExecutor.execute(sql);
  return results;
}

export async function fetchBrokenEnsRefresh() {
  const sql = `SELECT * FROM ${ENS_TABLE} WHERE display LIKE '%?%' LIMIT 200;`;
  const results = await sqlExecutor.execute(sql);
  return results;
}

export async function fetchMissingEns(datetime?: Date) {
  let sql = `SELECT DISTINCT address
    FROM (
      SELECT from_address AS address
      FROM ${TRANSACTIONS_TABLE}
      WHERE from_address NOT IN (SELECT wallet FROM ${ENS_TABLE})`;
  const params: any = {};

  if (datetime) {
    sql += ` AND ${TRANSACTIONS_TABLE}.created_at > :date1`;
    params.date1 = datetime;
  }
  sql += ` UNION
      SELECT to_address AS address
      FROM ${TRANSACTIONS_TABLE}
      WHERE to_address NOT IN (SELECT wallet FROM ${ENS_TABLE})`;

  if (datetime) {
    sql += ` AND ${TRANSACTIONS_TABLE}.created_at > :date2`;
    params.date2 = datetime;
  }
  sql += `) AS addresses LIMIT 200`;

  const results = await sqlExecutor.execute(sql, params);

  const structuredResults = results.map((r: any) => r.address);
  return structuredResults;
}

export async function fetchMissingEnsNFTDelegation(table: string) {
  let address1 = 'from_address';
  let address2 = 'to_address';

  if (table === CONSOLIDATIONS_TABLE) {
    address1 = 'wallet1';
    address2 = 'wallet2';
  }

  let sql = `SELECT DISTINCT address
    FROM (
      SELECT ${address1} AS address
      FROM ${table}
      WHERE ${address1} NOT IN (SELECT wallet FROM ${ENS_TABLE})`;

  sql += ` UNION
      SELECT ${address2} AS address
      FROM ${table}
      WHERE ${address2} NOT IN (SELECT wallet FROM ${ENS_TABLE})`;

  sql += `) AS addresses LIMIT 200`;

  const results = await sqlExecutor.execute(sql);

  const structuredResults = results.map((r: any) => r.address);
  return structuredResults;
}

export async function persistTransactions(transactions: BaseTransaction[]) {
  if (transactions.length > 0) {
    const consolidatedTransactions = consolidateTransactions(transactions);
    logger.info(
      `[TRANSACTIONS] [PERSISTING ${consolidatedTransactions.length} TRANSACTIONS]`
    );
    await AppDataSource.getRepository(Transaction).upsert(
      consolidatedTransactions,
      ['transaction', 'contract', 'from_address', 'to_address', 'token_id']
    );

    logger.info(
      `[TRANSACTIONS] [ALL ${consolidatedTransactions.length} TRANSACTIONS PERSISTED]`
    );
  }
}

export async function persistArtists(artists: Artist[]) {
  if (artists.length > 0) {
    logger.info(`[ARTISTS] [PERSISTING ${artists.length} ARTISTS]`);
    await Promise.all(
      artists.map(async (artist) => {
        const sql = `REPLACE INTO ${ARTISTS_TABLE} SET name=:name, created_at=:created_at, memes=:memes, gradients=:gradients, memelab=:meme_lab, bio=:bio, pfp=:pfp, work=:work, social_links=:social`;
        const params = {
          name: artist.name,
          created_at: new Date(),
          memes: JSON.stringify(artist.memes),
          gradients: JSON.stringify(artist.gradients),
          meme_lab: JSON.stringify(artist.memelab),
          bio: artist.bio,
          pfp: artist.pfp,
          work: JSON.stringify(artist.work),
          social: JSON.stringify(artist.social_links)
        };
        await sqlExecutor.execute(sql, params);
      })
    );
    logger.info(`[ARTISTS] [ALL ${artists.length} ARTISTS PERSISTED]`);
  }
}

export async function findVolumeNFTs(nft: NFT): Promise<{
  total_volume_last_24_hours: number;
  total_volume_last_7_days: number;
  total_volume_last_1_month: number;
  total_volume: number;
}> {
  return findVolume(TRANSACTIONS_TABLE, nft.id, nft.contract);
}

async function findVolume(
  table: string,
  nft_id: number,
  contract: string
): Promise<{
  total_volume_last_24_hours: number;
  total_volume_last_7_days: number;
  total_volume_last_1_month: number;
  total_volume: number;
}> {
  const sql = `SELECT
      SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN value ELSE 0 END) AS total_volume_last_24_hours,
      SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN value ELSE 0 END) AS total_volume_last_7_days,
      SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH) THEN value ELSE 0 END) AS total_volume_last_1_month,
      SUM(value) AS total_volume
    FROM ${table}
    WHERE token_id =:token_id and contract =:contract;`;
  const results = await sqlExecutor.execute(sql, {
    token_id: nft_id,
    contract: contract
  });
  return results[0];
}

export async function persistTdhUpload(
  block: number,
  dateString: string,
  location: string
) {
  return persistTdhUploadByTable(UPLOADS_TABLE, block, dateString, location);
}

export async function persistConsolidatedTdhUpload(
  block: number,
  dateString: string,
  location: string
) {
  return persistTdhUploadByTable(
    CONSOLIDATED_UPLOADS_TABLE,
    block,
    dateString,
    location
  );
}

async function persistTdhUploadByTable(
  table: string,
  block: number,
  dateString: string,
  location: string
) {
  const sql = `REPLACE INTO ${table} SET
      date = :date,
          block = :block,
    tdh = :tdh`;
  await sqlExecutor.execute(sql, {
    date: dateString,
    block: block,
    tdh: location
  });

  logger.info(`[TDH UPLOAD IN ${table} PERSISTED]`);
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

export async function replaceTeam(team: Team[]) {
  const repo = AppDataSource.getRepository(Team);
  await repo.clear();
  await repo.save(team);
}

export async function fetchTDHForBlock(block: number) {
  const sql = `SELECT ${ENS_TABLE}.display as ens, ${WALLETS_TDH_TABLE}.* FROM ${WALLETS_TDH_TABLE} LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet WHERE block=:block;`;
  const results = await sqlExecutor.execute(sql, {
    block: block
  });
  const parsed = results.map((r: any) => parseTdhDataFromDB(r));
  return parsed;
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

export async function fetchHasEns(wallets: string[]) {
  const sql = `SELECT COUNT(*) as ens_count FROM ${ENS_TABLE} WHERE wallet IN (:wallets) AND display IS NOT NULL`;

  const results = await sqlExecutor.execute(sql, {
    wallets: wallets
  });
  return parseInt(results[0].ens_count) === wallets.length;
}

export async function persistMemesSeasons(seasons: MemesSeason[]) {
  await AppDataSource.getRepository(MemesSeason).save(seasons);
}

export async function fetchAllSeasons() {
  return AppDataSource.getRepository(MemesSeason).find();
}

export async function fetchWalletConsolidationKeysView(): Promise<
  WalletConsolidationKey[]
> {
  const sql = `SELECT * FROM ${WALLETS_CONSOLIDATION_KEYS_VIEW}`;
  return await sqlExecutor.execute(sql);
}

export async function fetchWalletConsolidationKeysViewForWallet(
  addresses: string[]
): Promise<WalletConsolidationKey[]> {
  const sql = `SELECT * FROM ${WALLETS_CONSOLIDATION_KEYS_VIEW} WHERE wallet IN (:addresses)`;
  return await sqlExecutor.execute(sql, { addresses });
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
