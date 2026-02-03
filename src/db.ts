import 'reflect-metadata';
import {
  DataSource,
  EntityManager,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  QueryRunner
} from 'typeorm';
import { consolidationTools } from './consolidation-tools';
import {
  ADDRESS_CONSOLIDATION_KEY,
  ARTISTS_TABLE,
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_UPLOADS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  CONSOLIDATIONS_TABLE,
  ENS_TABLE,
  MEME_LAB_ROYALTIES_TABLE,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  PROFILES_TABLE,
  TDH_BLOCKS_TABLE,
  TRANSACTIONS_TABLE,
  UPLOADS_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';
import { DbQueryOptions } from './db-query.options';
import { revokeTdhBasedDropWavesOverVotes } from './drops/participation-drops-over-vote-revocation';
import { Artist } from './entities/IArtist';
import {
  Consolidation,
  ConsolidationEvent,
  Delegation,
  DelegationEvent,
  EventType,
  NFTDelegationBlock,
  WalletConsolidationKey
} from './entities/IDelegation';
import { ENS } from './entities/IENS';
import { NextGenTokenTDH } from './entities/INextGen';
import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from './entities/INFT';
import {
  NFTHistory,
  NFTHistoryBlock,
  NFTHistoryClaim
} from './entities/INFTHistory';
import { Profile } from './entities/IProfile';
import { Rememe, RememeUpload } from './entities/IRememe';
import { RoyaltiesUpload } from './entities/IRoyalties';
import { MemesSeason } from './entities/ISeason';
import {
  ConsolidatedTDH,
  ConsolidatedTDHEditions,
  ConsolidatedTDHMemes,
  HistoricConsolidatedTDH,
  NftTDH,
  TDH,
  TDHBlock,
  TDHEditions,
  TDHMemes
} from './entities/ITDH';
import {
  GlobalTDHHistory,
  LatestGlobalTDHHistory,
  LatestTDHHistory,
  RecentTDHHistory,
  TDHHistory
} from './entities/ITDHHistory';
import { Team } from './entities/ITeam';
import { BaseTransaction, Transaction } from './entities/ITransaction';
import { env } from './env';
import { ethTools } from './eth-tools';
import {
  syncIdentitiesMetrics,
  syncIdentitiesWithTdhConsolidations
} from './identity';
import { Logger } from './logging';
import { metricsRecorder } from './metrics/MetricsRecorder';
import { deleteAll, insertWithoutUpdate, resetRepository } from './orm_helpers';
import {
  ConnectionWrapper,
  dbSupplier,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor
} from './sql-executor';
import { getConsolidationsSql, parseTdhDataFromDB } from './sql_helpers';
import { equalIgnoreCase } from './strings';
import { computeMerkleRoot } from './tdhLoop/tdh_merkle';
import { Time } from './time';
import { recalculateXTdhUseCase } from './xtdh/recalculate-xtdh.use-case';

const mysql = require('mysql');

const logger = Logger.get('DB');

let AppDataSource: DataSource;

export async function connect(entities: any[] = [], syncEntities = false) {
  logger.info(
    `[DB HOST ${process.env.DB_HOST}] [SYNC ENTITIES ${syncEntities}]`
  );

  AppDataSource = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT!),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    entities: entities,
    synchronize: syncEntities,
    logging: false,
    charset: 'utf8mb4',
    timezone: 'Etc/UTC'
  });

  await AppDataSource.initialize().catch((error) =>
    logger.error(`DB INIT ERROR: ${error}`)
  );
  class DbImpl extends SqlExecutor {
    async execute(
      sql: string,
      params?: Record<string, any>,
      options?: DbQueryOptions
    ) {
      return execSQLWithParams(sql, params, options);
    }

    async executeNativeQueriesInTransaction<T>(
      executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>
    ) {
      return execNativeTransactionally(executable);
    }
  }

  setSqlExecutor(new DbImpl());
  logger.info(
    `[CONNECTION CREATED] [APP DATA SOURCE ${
      !AppDataSource.isInitialized ? 'NOT ' : ''
    }INITIALIZED]`
  );
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

export async function fetchLatestNftHistoryBlockNumber() {
  const block = await AppDataSource.getRepository(NFTHistoryBlock)
    .createQueryBuilder()
    .select('MAX(block)', 'maxBlock')
    .getRawOne();
  return block.maxBlock;
}

export async function retrieveWalletConsolidations(wallet: string) {
  const sql = getConsolidationsSql();
  const consolidations: any[] = await sqlExecutor.execute(sql, {
    wallet: wallet
  });
  return consolidationTools.extractConsolidationWallets(consolidations, wallet);
}

export async function retrieveConsolidationsForWallets(
  wallets: string[]
): Promise<Record<string, string>> {
  if (!wallets.length) {
    return {};
  }
  const uniqueWallets = Array.from(
    new Set(wallets.map((w) => w.toLowerCase()))
  );
  const walletPlaceholders = uniqueWallets
    .map((_, i) => `:wallet${i}`)
    .join(', ');
  const walletParams = uniqueWallets.reduce(
    (acc, w, i) => {
      acc[`wallet${i}`] = w;
      return acc;
    },
    {} as Record<string, string>
  );

  const sql = `
    WITH RECURSIVE wallet_cluster AS (
      SELECT 
        LOWER(wallet1) AS wallet1, 
        LOWER(wallet2) AS wallet2
      FROM ${CONSOLIDATIONS_TABLE}
      WHERE confirmed = true
        AND (LOWER(wallet1) IN (${walletPlaceholders}) OR LOWER(wallet2) IN (${walletPlaceholders}))

      UNION

      SELECT 
        LOWER(c.wallet1) AS wallet1, 
        LOWER(c.wallet2) AS wallet2
      FROM ${CONSOLIDATIONS_TABLE} c
      INNER JOIN wallet_cluster wc
        ON LOWER(c.wallet1) = wc.wallet2
        OR LOWER(c.wallet2) = wc.wallet1
        OR LOWER(c.wallet1) = wc.wallet1
        OR LOWER(c.wallet2) = wc.wallet2
      WHERE c.confirmed = true
    )

    SELECT DISTINCT
      LOWER(wallet1) AS wallet1,
      LOWER(wallet2) AS wallet2,
      block
    FROM ${CONSOLIDATIONS_TABLE}
    WHERE confirmed = true
      AND (
        LOWER(wallet1) IN (
          SELECT wallet1 FROM wallet_cluster
          UNION
          SELECT wallet2 FROM wallet_cluster
        )
        OR
        LOWER(wallet2) IN (
          SELECT wallet1 FROM wallet_cluster
          UNION
          SELECT wallet2 FROM wallet_cluster
        )
      )
    ORDER BY block DESC;
  `;

  const consolidations = await sqlExecutor.execute<Consolidation>(
    sql,
    walletParams
  );

  const clusters = consolidationTools.extractConsolidations(consolidations);

  const walletToKey: Record<string, string> = {};
  for (const cluster of clusters) {
    const key = consolidationTools.buildConsolidationKey(cluster);
    for (const w of cluster) {
      walletToKey[w.toLowerCase()] = key;
    }
  }

  const results: Record<string, string> = {};
  for (const wallet of uniqueWallets) {
    results[wallet] = walletToKey[wallet] ?? wallet;
  }

  return results;
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

export async function fetchLatestTDHBDate(): Promise<{
  block: number;
  timestamp: Time;
}> {
  const sql = `SELECT block_number, timestamp FROM ${TDH_BLOCKS_TABLE} order by block_number desc limit 1;`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0
    ? {
        block: +r[0].block_number,
        timestamp: Time.fromString(r[0].timestamp)
      }
    : { block: 0, timestamp: Time.millis(0) };
}

export async function fetchLatestTDHBlockNumber(): Promise<number> {
  const sql = `SELECT block_number FROM ${TDH_BLOCKS_TABLE} order by block_number desc limit 1;`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0 ? r[0].block_number : 0;
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
  const results = await sqlExecutor.execute(sql, params);
  results.map((r: any) => {
    r.metadata = JSON.parse(r.metadata);
  });
  return results;
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

export async function fetchAllTDH(block: number, wallets?: string[]) {
  let sql = `SELECT ${ENS_TABLE}.display as ens, ${WALLETS_TDH_TABLE}.* FROM ${WALLETS_TDH_TABLE} LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet WHERE block=:block `;
  if (wallets && wallets.length > 0) {
    sql += `AND ${WALLETS_TDH_TABLE}.wallet IN (:wallets)`;
  }
  const results = await sqlExecutor.execute(sql, { block, wallets });
  return results.map(parseTdhDataFromDB);
}

function shortFormatIfAddress(address: string): string {
  if (!address || !ethTools.isEthAddress(address)) {
    return address;
  }
  return `${address.substring(0, 5)}...${address.substring(
    address.length - 3
  )}`;
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
    const result = results.find((r: any) => equalIgnoreCase(r.wallet, w));
    if (result?.display && !result.display.includes('?')) {
      displayArray.push(result.display);
    } else {
      displayArray.push(w);
    }
  });

  if (displayArray.length == 1) {
    return displayArray[0];
  }
  return displayArray.map((d) => shortFormatIfAddress(d)).join(' - ');
}

export async function fetchConsolidationDisplays(
  consolidationKeys: string[]
): Promise<Record<string, string>> {
  const sql = `SELECT * FROM ${ENS_TABLE} WHERE wallet IN (:wallets)`;
  const wallets = consolidationKeys
    .flatMap((it) => it.split('-'))
    .map((it) => it.toLowerCase());
  const sliceMaxSize = 500;
  const allRelatedDisplays: Record<string, string> = {};
  for (let i = 0; i < wallets.length; i += sliceMaxSize) {
    const chunk = wallets.slice(i, i + sliceMaxSize);
    if (!chunk.length) {
      break;
    }
    const results = await sqlExecutor.execute<ENS>(sql, {
      wallets: chunk
    });
    for (const ens of results) {
      const display = ens.display;
      if (display && !display.includes('?')) {
        allRelatedDisplays[ens.wallet.toLowerCase()] = display;
      }
    }
  }
  for (const wallet of wallets) {
    if (!allRelatedDisplays[wallet]) {
      allRelatedDisplays[wallet] = wallet;
    }
  }
  return consolidationKeys.reduce(
    (acc, key) => {
      const displays = key
        .split('-')
        .map((wallet) => allRelatedDisplays[wallet.toLowerCase()]!);
      if (displays.length === 1) {
        acc[key] = displays[0];
      } else {
        acc[key] = displays.map((it) => shortFormatIfAddress(it)).join(' - ');
      }
      return acc;
    },
    {} as Record<string, string>
  );
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

export async function fetchMaxTransactionByBlockNumber(): Promise<Transaction | null> {
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
  if (ethTools.isNullOrDeadAddress(wallet)) {
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
  const batchSize = env.getIntOrNull('ENS_LOOP_MAX_BATCH_SIZE') ?? 100;
  const sql = `SELECT * FROM ${ENS_TABLE} WHERE created_at < DATE_SUB(NOW(), INTERVAL 6 HOUR) ORDER BY created_at ASC LIMIT :batchSize`;
  return sqlExecutor.execute<ENS>(sql, { batchSize });
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

export async function persistMemesExtendedData(data: MemesExtendedData[]) {
  await AppDataSource.getRepository(MemesExtendedData).save(data);
}

export async function findVolume(
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
    FROM ${TRANSACTIONS_TABLE}
    WHERE token_id =:token_id and contract =:contract;`;
  const results = await sqlExecutor.execute(sql, {
    token_id: nft_id,
    contract: contract
  });
  return results[0];
}

export async function persistNFTs(nfts: NFT[]) {
  await AppDataSource.getRepository(NFT).save(nfts);
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
    tdh = :tdh,
    timestamp = :timestamp`;
  await sqlExecutor.execute(sql, {
    date: dateString,
    block: block,
    tdh: location,
    timestamp: Time.fromYyyyMmDdDateOnlyToUtcMidnight(dateString).toMillis()
  });

  logger.info(`[TDH UPLOAD IN ${table} PERSISTED]`);
}

export async function persistTDH(
  block: number,
  tdh: TDH[],
  memesTdh: TDHMemes[],
  tdhEditions: TDHEditions[],
  wallets?: string[]
) {
  logger.info(
    `[TDH] [PERSISTING WALLETS TDH ${tdh.length}] : [MEMES TDH ${memesTdh.length}]`
  );

  await AppDataSource.transaction(async (manager) => {
    const tdhRepo = manager.getRepository(TDH);
    const tdhMemesRepo = manager.getRepository(TDHMemes);
    const tdhEditionsRepo = manager.getRepository(TDHEditions);
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
          await tdhMemesRepo
            .createQueryBuilder()
            .delete()
            .where('LOWER(wallet) = :wallet ', {
              wallet: wallet.toLowerCase()
            })
            .execute();
          await tdhEditionsRepo
            .createQueryBuilder()
            .delete()
            .where('wallet = :wallet ', {
              wallet: wallet.toLowerCase()
            })
            .execute();
        })
      );
      await tdhRepo.save(tdh);
      await tdhMemesRepo.save(memesTdh);
      await tdhEditionsRepo.save(tdhEditions);
    } else {
      logger.info(`[TDH] [DELETING ALL WALLETS FOR BLOCK ${block}]`);
      await tdhRepo.delete({ block: block });
      await deleteAll(tdhMemesRepo);
      await deleteAll(tdhEditionsRepo);
      logger.info(`[TDH AND TDH_MEMES CLEARED]`);
      await insertWithoutUpdate(tdhRepo, tdh);
      await insertWithoutUpdate(tdhMemesRepo, memesTdh);
      await insertWithoutUpdate(tdhEditionsRepo, tdhEditions);
    }
  });

  logger.info(`[TDH] PERSISTED ALL WALLETS TDH [${tdh.length}]`);
}

export async function persistTDHBlock(
  block: number,
  timestamp: Date,
  tdh: ConsolidatedTDH[]
) {
  logger.info(`[TDH BLOCK] PERSISTING BLOCK [${block}]`);

  const merkleRoot = await computeMerkleRoot(block);

  logger.info(`[TDH BLOCK] MERKLE ROOT [${merkleRoot}]`);

  const repo = AppDataSource.getRepository(TDHBlock);

  await repo.delete({ block_number: block });
  await repo.insert({
    block_number: block,
    timestamp,
    merkle_root: merkleRoot
  });
}

export async function persistConsolidatedTDH(
  block: number,
  tdh: ConsolidatedTDH[],
  memesTdh: ConsolidatedTDHMemes[],
  tdhEditions: ConsolidatedTDHEditions[],
  wallets?: string[]
) {
  logger.info(`[CONSOLIDATED TDH] PERSISTING WALLETS TDH [${tdh.length}]`);
  await sqlExecutor.executeNativeQueriesInTransaction(async (qrHolder) => {
    const queryRunner = qrHolder.connection as QueryRunner;
    const manager = queryRunner.manager;
    const tdhRepo = manager.getRepository(ConsolidatedTDH);
    const tdhMemesRepo = manager.getRepository(ConsolidatedTDHMemes);
    const tdhEditionsRepo = manager.getRepository(ConsolidatedTDHEditions);

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
          await tdhMemesRepo
            .createQueryBuilder()
            .delete()
            .where('consolidation_key like :walletPattern', {
              walletPattern
            })
            .execute();
          await tdhEditionsRepo
            .createQueryBuilder()
            .delete()
            .where('consolidation_key like :walletPattern', {
              walletPattern
            })
            .execute();
        })
      );
      await tdhRepo.save(tdh);

      await tdhMemesRepo.save(memesTdh);
      await tdhEditionsRepo.save(tdhEditions);
    } else {
      logger.info(`[CONSOLIDATED TDH] [DELETING ALL WALLETS]`);
      await deleteAll(tdhRepo);
      await deleteAll(tdhMemesRepo);
      await deleteAll(tdhEditionsRepo);

      logger.info(
        `[CONSOLIDATED TDH] [TDH AND TDH_MEMES CLEARED, PERSISTING NEW TDH]`
      );
      await insertWithoutUpdate(tdhRepo, tdh);
      await insertWithoutUpdate(tdhMemesRepo, memesTdh);
      await insertWithoutUpdate(tdhEditionsRepo, tdhEditions);
    }

    await updateBoostedTdhRates(qrHolder);
    await syncIdentitiesWithTdhConsolidations(qrHolder);
    await syncIdentitiesMetrics(qrHolder);
    await revokeTdhBasedDropWavesOverVotes(qrHolder);

    await persistHistoricConsolidatedTDH(manager, block, tdh, wallets);
  });

  await recalculateXTdhUseCase.activateLoop({});
  logger.info(`[CONSOLIDATED TDH] PERSISTED ALL WALLETS TDH [${tdh.length}]`);
}

async function updateBoostedTdhRates(connection: ConnectionWrapper<any>) {
  const sql = `
      UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} cw
      LEFT JOIN (
        SELECT
          c.consolidation_key,
          SUM(e.hodl_rate) * COALESCE(MAX(c.boost), 1.0) AS boosted_tdh_rate
        FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} c
        LEFT JOIN ${CONSOLIDATED_TDH_EDITIONS_TABLE} e
          ON e.consolidation_key = c.consolidation_key
        GROUP BY c.consolidation_key
      ) x
        ON x.consolidation_key = cw.consolidation_key
      SET cw.boosted_tdh_rate = COALESCE(x.boosted_tdh_rate, 0)
    `;
  await dbSupplier().execute(sql, undefined, {
    wrappedConnection: connection
  });
}

export async function persistHistoricConsolidatedTDH(
  entityManager: EntityManager,
  block: number,
  tdh: ConsolidatedTDH[],
  wallets?: string[]
) {
  logger.info(`[HISTORIC CONSOLIDATED TDH] PERSISTING BLOCK [${block}]`);
  const historicTdhRepo = entityManager.getRepository(HistoricConsolidatedTDH);
  if (wallets) {
    await Promise.all(
      wallets.map(async (wallet) => {
        const walletPattern = `%${wallet}%`;
        await historicTdhRepo
          .createQueryBuilder()
          .delete()
          .where('consolidation_key like :walletPattern and block = :block', {
            walletPattern,
            block
          })
          .execute();
      })
    );
    await historicTdhRepo.save(tdh);
  } else {
    await historicTdhRepo.delete({ block: block });
    await insertWithoutUpdate(historicTdhRepo, tdh);
  }
  logger.info(`[HISTORIC CONSOLIDATED TDH] PERSISTED BLOCK [${block}]`);
}

export async function persistNftTdh(nftTdh: NftTDH[], wallets?: string[]) {
  logger.info(`[NFT TDH] PERSISTING [${nftTdh.length} RESULTS]`);
  await sqlExecutor.executeNativeQueriesInTransaction(async (qrHolder) => {
    const queryRunner = qrHolder.connection as QueryRunner;
    const manager = queryRunner.manager;
    const nftTdhRepo = manager.getRepository(NftTDH);
    if (wallets) {
      logger.info(`[NFT TDH] [DELETING ${wallets.length} WALLETS]`);
      await Promise.all(
        wallets.map(async (wallet) => {
          const walletPattern = `%${wallet}%`;
          await nftTdhRepo
            .createQueryBuilder()
            .delete()
            .where('consolidation_key like :walletPattern', {
              walletPattern
            })
            .execute();
        })
      );
      await nftTdhRepo.save(nftTdh);
    } else {
      logger.info(`[NFT TDH] [DELETING ALL WALLETS]`);
      await deleteAll(nftTdhRepo);
      logger.info(`[NFT TDH] [TDH AND TDH_MEMES CLEARED]`);
      await insertWithoutUpdate(nftTdhRepo, nftTdh);
    }
  });

  logger.info(`[NFT TDH] PERSISTED ALL NFT TDH [${nftTdh.length}]`);
}

export async function persistNextGenTokenTDH(nextgenTdh: NextGenTokenTDH[]) {
  logger.info(`[NEXTGEN TOKEN TDH] : [${nextgenTdh.length}]`);
  await AppDataSource.getRepository(NextGenTokenTDH).save(nextgenTdh);
}

export async function persistENS(ens: ENS[]) {
  logger.info(`[ENS] PERSISTING ENS [${ens.length}]`);
  const sql = `REPLACE INTO ${ENS_TABLE} SET
            wallet = :wallet,
                display = :display`;
  await Promise.all(
    ens.map(async (t) => {
      if ((t.display && t.display.length < 150) || !t.display) {
        try {
          await sqlExecutor.execute(sql, {
            wallet: t.wallet,
            display: t.display
          });
        } catch (e) {
          await sqlExecutor.execute(sql, {
            wallet: t.wallet,
            display: null
          });
        }
      } else {
        await sqlExecutor.execute(sql, {
          wallet: t.wallet,
          display: null
        });
      }
    })
  );

  logger.info(`[ENS] PERSISTED ALL [${ens.length}]`);
}

export async function persistLabNFTS(labnfts: LabNFT[]) {
  const repo = AppDataSource.getRepository(LabNFT);
  await Promise.all(
    labnfts.map(async (lnft) => {
      if (lnft.supply > 0) {
        await repo.save(lnft);
      } else {
        await repo.remove(lnft);
      }
    })
  );
}

export async function persistLabNFTRoyalties() {
  const labNfts = await fetchAllMemeLabNFTs();

  const labRoyalties: {
    id: number;
    primary_royalty_split: number;
    secondary_royalty_split: number;
  }[] = [];
  labNfts.forEach((labNft: LabNFT) => {
    labRoyalties.push({
      id: labNft.id,
      primary_royalty_split: 0,
      secondary_royalty_split: 0
    });
  });

  await AppDataSource.createQueryBuilder()
    .insert()
    .into(MEME_LAB_ROYALTIES_TABLE)
    .values(
      labRoyalties.map((labR) => ({
        token_id: labR.id,
        primary_royalty_split: labR.primary_royalty_split,
        secondary_royalty_split: labR.secondary_royalty_split
      }))
    )
    .orIgnore()
    .execute();
}

export async function persistLabExtendedData(labMeta: LabExtendedData[]) {
  await AppDataSource.getRepository(LabExtendedData).save(labMeta);
}

function constructFilters(f: string, newF: string) {
  if (f.trim().toUpperCase().startsWith('WHERE')) {
    return ` ${f} AND ${newF} `;
  }
  return ` WHERE ${newF} `;
}

export async function replaceTeam(team: Team[]) {
  const repo = AppDataSource.getRepository(Team);
  await deleteAll(repo);
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

export async function persistRoyaltiesUpload(date: Date, url: string) {
  const upload = new RoyaltiesUpload();
  upload.date = date;
  upload.url = url;
  const repository = AppDataSource.getRepository(RoyaltiesUpload);
  const query = repository
    .createQueryBuilder()
    .insert()
    .into(RoyaltiesUpload)
    .values(upload)
    .orUpdate(['url']);
  await query.execute();
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

export async function persistNftHistory(nftHistory: NFTHistory[]) {
  await AppDataSource.getRepository(NFTHistory).upsert(nftHistory, [
    'nft_id',
    'contract',
    'uri'
  ]);
}

export async function persistNftClaims(claims: NFTHistoryClaim[]) {
  await AppDataSource.getRepository(NFTHistoryClaim).upsert(claims, [
    'contract',
    'location',
    'claimIndex'
  ]);
}

export async function findClaim(claimIndex: number, nftId?: number) {
  let condition;
  if (nftId != undefined) {
    condition = { claimIndex: claimIndex, nft_id: nftId };
  } else {
    condition = { claimIndex: claimIndex };
  }
  const claims = await AppDataSource.getRepository(NFTHistoryClaim).find({
    where: condition,
    order: { created_at: 'desc' }
  });
  return claims;
}

export async function persistNftHistoryBlock(block: number) {
  await AppDataSource.getRepository(NFTHistoryBlock).upsert(
    {
      block
    },
    ['block']
  );
}

export async function fetchLatestNftUri(
  tokenId: number,
  contract: string,
  block: number
) {
  const latestHistory = await AppDataSource.getRepository(NFTHistory).findOne({
    where: {
      nft_id: tokenId,
      contract: contract,
      block: LessThan(block)
    },
    order: { block: 'DESC' }
  });
  return latestHistory ? latestHistory.uri : null;
}

export async function fetchHasEns(wallets: string[]) {
  const sql = `SELECT COUNT(*) as ens_count FROM ${ENS_TABLE} WHERE wallet IN (:wallets) AND display IS NOT NULL`;

  const results = await sqlExecutor.execute(sql, {
    wallets: wallets
  });
  return parseInt(results[0].ens_count) === wallets.length;
}

export async function fetchAllProfiles(): Promise<Profile[]> {
  return await sqlExecutor.execute<Profile>(`select * from ${PROFILES_TABLE}`);
}

export async function deleteRememes(rememes: Rememe[]) {
  await AppDataSource.getRepository(Rememe).remove(rememes);
}

export async function persistRememes(rememes: Rememe[]) {
  await AppDataSource.getRepository(Rememe).save(rememes);
}

export async function persistRememesUpload(url: string) {
  await AppDataSource.getRepository(RememeUpload).save({
    url
  });
}

export async function fetchRememes() {
  return await AppDataSource.getRepository(Rememe).find();
}

export async function fetchMissingS3Rememes() {
  return await AppDataSource.getRepository(Rememe).find({
    where: {
      s3_image_original: IsNull()
    }
  });
}

export async function persistTDHHistory(date: Date, tdhHistory: TDHHistory[]) {
  await AppDataSource.transaction(async (transactionalEntityManager) => {
    const dateObject = new Date(date);
    dateObject.setUTCHours(0, 0, 0, 0);
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 30);
    cutoffDate.setUTCHours(0, 0, 0, 0);

    const tdhHistoryRepo = transactionalEntityManager.getRepository(TDHHistory);
    const recentTdhHistoryRepo =
      transactionalEntityManager.getRepository(RecentTDHHistory);

    await tdhHistoryRepo.delete({
      date: dateObject
    });
    await recentTdhHistoryRepo
      .createQueryBuilder()
      .delete()
      .where('date = :exactDate OR date <= :cutoff', {
        exactDate: dateObject,
        cutoff: cutoffDate
      })
      .execute();
    await tdhHistoryRepo.upsert(tdhHistory, [
      'date',
      'consolidation_key',
      'block'
    ]);
    await recentTdhHistoryRepo.upsert(tdhHistory, [
      'date',
      'consolidation_key',
      'block'
    ]);

    await resetRepository(
      transactionalEntityManager.getRepository(LatestTDHHistory),
      tdhHistory
    );
  });
}

export async function persistGlobalTDHHistory(globalHistory: GlobalTDHHistory) {
  await AppDataSource.transaction(async (transactionalEntityManager) => {
    await transactionalEntityManager
      .getRepository(GlobalTDHHistory)
      .upsert(globalHistory, ['date', 'block']);

    await resetRepository(
      transactionalEntityManager.getRepository(LatestGlobalTDHHistory),
      [globalHistory]
    );
  });

  await metricsRecorder.recordNetworkTdh(
    { tdh: globalHistory.total_boosted_tdh },
    {}
  );
}
export async function persistMemesSeasons(seasons: MemesSeason[]) {
  await AppDataSource.getRepository(MemesSeason).save(seasons);
}

export async function fetchAllSeasons() {
  return AppDataSource.getRepository(MemesSeason).find();
}

export async function fetchWalletConsolidationKeysViewForWallet(
  addresses: string[]
): Promise<WalletConsolidationKey[]> {
  const sql = `SELECT * FROM ${ADDRESS_CONSOLIDATION_KEY} WHERE address IN (:addresses)`;
  return await sqlExecutor.execute(sql, { addresses });
}
