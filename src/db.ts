import 'reflect-metadata';
import { DataSource, IsNull, LessThan, QueryRunner } from 'typeorm';
import {
  TDH_BLOCKS_TABLE,
  TRANSACTIONS_TABLE,
  NFTS_TABLE,
  ARTISTS_TABLE,
  MEMES_EXTENDED_DATA_TABLE,
  OWNERS_TABLE,
  WALLETS_TDH_TABLE,
  UPLOADS_TABLE,
  ENS_TABLE,
  OWNERS_METRICS_TABLE,
  NULL_ADDRESS,
  NFTS_MEME_LAB_TABLE,
  TRANSACTIONS_MEME_LAB_TABLE,
  OWNERS_MEME_LAB_TABLE,
  MEMES_CONTRACT,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  CONSOLIDATED_UPLOADS_TABLE,
  MEME_LAB_ROYALTIES_TABLE,
  CONSOLIDATIONS_TABLE
} from './constants';
import { Artist } from './entities/IArtist';
import { ENS } from './entities/IENS';
import { User } from './entities/IUser';

import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from './entities/INFT';
import { ConsolidatedTDHUpload } from './entities/IUpload';
import {
  ConsolidatedOwnerMetric,
  ConsolidatedOwnerTags,
  Owner,
  OwnerMetric,
  OwnerTags
} from './entities/IOwner';
import {
  ConsolidatedTDH,
  GlobalTDHHistory,
  TDH,
  TDHHistory
} from './entities/ITDH';
import { Team } from './entities/ITeam';
import {
  Transaction,
  LabTransaction,
  BaseTransaction
} from './entities/ITransaction';
import {
  Consolidation,
  ConsolidationEvent,
  Delegation,
  DelegationEvent,
  EventType
} from './entities/IDelegation';
import { RoyaltiesUpload } from './entities/IRoyalties';
import {
  NFTHistoryBlock,
  NFTHistory,
  NFTHistoryClaim
} from './entities/INFTHistory';
import { Rememe, RememeUpload } from './entities/IRememe';
import {
  areEqualAddresses,
  extractConsolidationWallets,
  formatAddress
} from './helpers';
import { getConsolidationsSql } from './sql_helpers';
import {
  NextGenTransactionsBlock,
  NextGenAllowlist,
  NextGenAllowlistBurn,
  NextGenCollection,
  NextGenCollectionBurn
} from './entities/INextGen';
import { ConnectionWrapper, setSqlExecutor, sqlExecutor } from './sql-executor';
import { Profile, ProfileArchived } from './entities/IProfile';
import { Logger } from './logging';
import { DbQueryOptions } from './db-query.options';
import { Time } from './time';
import { CicStatement } from './entities/ICICStatement';
import { profilesService } from './profiles/profiles.service';
import { ProfileTdh, ProfileTdhLog } from './entities/IProfileTDH';
import { ProfileActivityLog } from './entities/IProfileActivityLog';
import { Rating } from './entities/IRating';

const mysql = require('mysql');

const logger = Logger.get('DB');

let AppDataSource: DataSource;

export async function connect(entities: any[] = []) {
  logger.info(`[DB HOST ${process.env.DB_HOST}]`);

  if (process.env.NODE_ENV != 'production') {
    entities = [
      Owner,
      LabNFT,
      LabExtendedData,
      Transaction,
      OwnerMetric,
      NFT,
      Team,
      LabTransaction,
      RoyaltiesUpload,
      OwnerTags,
      TDH,
      Consolidation,
      ConsolidatedTDH,
      ConsolidatedOwnerMetric,
      ConsolidatedOwnerTags,
      ConsolidatedTDHUpload,
      Delegation,
      NFTHistory,
      NFTHistoryBlock,
      NFTHistoryClaim,
      Rememe,
      RememeUpload,
      TDHHistory,
      GlobalTDHHistory,
      ENS,
      User,
      Profile,
      ProfileArchived,
      NextGenTransactionsBlock,
      NextGenAllowlist,
      NextGenAllowlistBurn,
      NextGenCollection,
      NextGenCollectionBurn,
      ProfileTdh,
      ProfileTdhLog,
      CicStatement,
      ProfileActivityLog,
      Rating
    ];
  }

  AppDataSource = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT!),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    entities: entities,
    synchronize: true,
    logging: false
  });

  await AppDataSource.initialize().catch((error) => logger.error(error));
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
  logger.info('[CONNECTION CREATED]');
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
    logger.error('Database transaction failed', err);
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

export async function fetchLastOwnerMetrics(): Promise<any> {
  const sql = `SELECT transaction_reference FROM ${OWNERS_METRICS_TABLE} ORDER BY transaction_reference DESC LIMIT 1;`;
  const results = await sqlExecutor.execute(sql);
  return results ? results[0].transaction_reference : null;
}

export async function findReplayTransactions(): Promise<Transaction[]> {
  const sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE value=0 AND from_address != ${mysql.escape(
    NULL_ADDRESS
  )};`;
  const results = await sqlExecutor.execute(sql);
  return results;
}

export async function findDuplicateTransactionHashes(): Promise<string[]> {
  const sql = `SELECT transaction FROM ${TRANSACTIONS_TABLE} GROUP BY transaction HAVING COUNT(*) > 1;`;
  const results = await sqlExecutor.execute(sql);
  const hashes: string[] = results.map((r: Transaction) => r.transaction);
  return hashes;
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
  let sql = `SELECT block FROM ${TRANSACTIONS_MEME_LAB_TABLE}`;
  const params: any = {};
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
  return extractConsolidationWallets(consolidations, wallet);
}

export async function fetchLatestConsolidationsBlockNumber() {
  const block = await AppDataSource.getRepository(Consolidation)
    .createQueryBuilder()
    .select('MAX(block)', 'maxBlock')
    .getRawOne();
  return block.maxBlock;
}

export async function fetchLatestDelegationsBlockNumber() {
  const block = await AppDataSource.getRepository(Delegation)
    .createQueryBuilder()
    .select('MAX(block)', 'maxBlock')
    .getRawOne();
  return block.maxBlock;
}

export async function fetchLatestTransactionsBlockNumber(beforeDate?: Date) {
  let sql = `SELECT block FROM ${TRANSACTIONS_TABLE}`;
  const params: any = {};
  if (beforeDate) {
    sql += ` WHERE UNIX_TIMESTAMP(transaction_date) <= :date`;
    params.date = beforeDate.getTime() / 1000;
  }
  sql += ` order by block desc limit 1;`;
  const r = await sqlExecutor.execute(sql, params);
  return r.length > 0 ? r[0].block : 0;
}

export async function fetchLatestTDHBDate(): Promise<Time> {
  const sql = `SELECT timestamp FROM ${TDH_BLOCKS_TABLE} order by block_number desc limit 1;`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0 ? Time.fromString(r[0].timestamp) : Time.millis(0);
}

export async function fetchLatestTDHBlockNumber() {
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
  const sql = `SELECT * FROM ${TRANSACTIONS_MEME_LAB_TABLE};`;
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
  const results = await sqlExecutor.execute(sql, params);
  results.map((r: any) => {
    r.metadata = JSON.parse(r.metadata);
  });
  return results;
}

export async function fetchTransactionsWithoutValue(
  pageSize: number,
  page: number
) {
  const offset = pageSize * (page - 1);
  const sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE value=0 LIMIT :limit OFFSET :offset;`;
  const results = await sqlExecutor.execute(sql, {
    limit: pageSize,
    offset: offset
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

export async function fetchAllTDH() {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  const sql = `SELECT ${ENS_TABLE}.display as ens, ${WALLETS_TDH_TABLE}.* FROM ${WALLETS_TDH_TABLE} LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet WHERE block=:block;`;
  const results = await sqlExecutor.execute(sql, { block: tdhBlock });
  results.map((r: any) => (r.memes = JSON.parse(r.memes)));
  results.map((r: any) => (r.gradients = JSON.parse(r.gradients)));
  return results;
}

export async function fetchAllConsolidatedTDH() {
  const sql = `SELECT * FROM ${CONSOLIDATED_WALLETS_TDH_TABLE};`;
  const results = await sqlExecutor.execute(sql);
  results.map((r: any) => (r.memes = JSON.parse(r.memes)));
  results.map((r: any) => (r.gradients = JSON.parse(r.gradients)));
  return results;
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
    if (result && result.display && !result.display.includes('?')) {
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

export async function fetchAllOwnerTags() {
  const metrics = await AppDataSource.getRepository(OwnerTags)
    .createQueryBuilder('ot')
    .innerJoin(OWNERS_TABLE, 'o', 'o.wallet = ot.wallet')
    .getMany();
  return metrics;
}

export async function fetchAllOwnerMetrics() {
  const metrics = await AppDataSource.getRepository(OwnerMetric).find();
  return metrics;
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

export async function fetchAllLabOwners() {
  const sql = `SELECT * FROM ${OWNERS_MEME_LAB_TABLE};`;
  const results = await sqlExecutor.execute(sql);
  return results;
}

export async function fetchAllOwners() {
  const sql = `SELECT * FROM ${OWNERS_TABLE};`;
  const results = await sqlExecutor.execute(sql);
  return results;
}

export async function fetchDistinctOwnerWallets() {
  const sql = `SELECT DISTINCT ${OWNERS_TABLE}.wallet, 
    ${OWNERS_METRICS_TABLE}.created_at 
    FROM ${OWNERS_TABLE} LEFT JOIN ${OWNERS_METRICS_TABLE} 
    ON ${OWNERS_TABLE}.wallet = ${OWNERS_METRICS_TABLE}.wallet 
    WHERE ${OWNERS_TABLE}.wallet != :null_address;`;
  const results = await sqlExecutor.execute(sql, {
    null_address: NULL_ADDRESS
  });
  return results;
}

export async function fetchTransactionsFromDate(
  date: Date | undefined,
  limit?: number
) {
  let sql = `SELECT from_address, to_address FROM ${TRANSACTIONS_TABLE}`;
  const params: any = {};

  if (date) {
    sql += ` WHERE ${TRANSACTIONS_TABLE}.created_at >= :date`;
    params.date = date.toISOString();
  }
  if (limit) {
    sql += ` LIMIT :limit`;
    params.limit = limit;
  }

  const results = await sqlExecutor.execute(sql, params);
  return results;
}

export async function fetchAllOwnersAddresses() {
  const sql = `SELECT distinct wallet FROM ${OWNERS_TABLE} WHERE wallet != :null_address;`;
  const results = await sqlExecutor.execute(sql, {
    null_address: NULL_ADDRESS
  });
  return results;
}

export async function fetchWalletTransactions(wallet: string, block?: number) {
  const sql = `SELECT * FROM ${TRANSACTIONS_TABLE}`;
  const params: any = {};

  let filters = constructFilters(
    'filters',
    `(from_address = :from_address OR to_address = :to_address)`
  );
  params.from_address = wallet;
  params.to_address = wallet;

  if (block) {
    filters = constructFilters(filters, `block <= :block`);
    params.block = block;
  }

  const fullSql = `${sql} ${filters}`;

  const results = await sqlExecutor.execute(fullSql, params);
  return results;
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

export async function persistTransactions(
  transactions: BaseTransaction[],
  isLab?: boolean
) {
  if (transactions.length > 0) {
    const consolidatedTransactions = consolidateTransactions(transactions);

    if (isLab) {
      logger.info(
        `[LAB TRANSACTIONS] [PERSISTING ${consolidatedTransactions.length} TRANSACTIONS]`
      );
      await AppDataSource.getRepository(LabTransaction).save(
        consolidatedTransactions
      );
    } else {
      logger.info(
        `[TRANSACTIONS] [PERSISTING ${consolidatedTransactions.length} TRANSACTIONS]`
      );
      await AppDataSource.getRepository(Transaction).save(
        consolidatedTransactions
      );
    }

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

export async function persistOwners(owners: Owner[], isLab?: boolean) {
  if (owners.length > 0) {
    logger.info(`[OWNERS] [PERSISTING ${owners.length} OWNERS]`);

    await Promise.all(
      owners.map(async (owner) => {
        let sql;
        const table = isLab ? OWNERS_MEME_LAB_TABLE : OWNERS_TABLE;
        const params: any = {};

        if (0 >= owner.balance) {
          sql = `DELETE FROM ${table} WHERE wallet=:wallet AND token_id=:token_id AND contract=:contract`;
          params.wallet = owner.wallet;
          params.token_id = owner.token_id;
          params.contract = owner.contract;
        } else {
          sql = `REPLACE INTO ${table} SET created_at=:created_at, wallet=:wallet, token_id=:token_id, contract=:contract, balance=:balance`;
          params.created_at = new Date();
          params.wallet = owner.wallet;
          params.token_id = owner.token_id;
          params.contract = owner.contract;
          params.balance = owner.balance;
        }

        await sqlExecutor.execute(sql, params);
      })
    );

    logger.info(`[OWNERS] [ALL ${owners.length} OWNERS PERSISTED]`);
  }
}

export async function persistOwnerMetrics(
  ownerMetrics: OwnerMetric[],
  reset?: boolean
) {
  if (ownerMetrics.length > 0) {
    logger.info(`[OWNERS METRICS] [PERSISTING ${ownerMetrics.length} WALLETS]`);

    if (reset) {
      const walletIds = ownerMetrics.map((metric) => metric.wallet);

      const result = await AppDataSource.createQueryBuilder()
        .delete()
        .from(OwnerMetric)
        .where('wallet NOT IN (:...walletIds)', { walletIds })
        .execute();

      logger.info(`[OWNERS METRICS] [RESET] [${JSON.stringify(result)}]`);
    }

    const repo = AppDataSource.getRepository(OwnerMetric);

    await Promise.all(
      ownerMetrics.map(async (ownerMetric) => {
        if (0 >= ownerMetric.balance) {
          logger.info(
            `[OWNERS METRICS] [DELETING ${ownerMetric.wallet} BALANCE ${ownerMetric.balance}]`
          );
          await repo.remove(ownerMetric);
        } else {
          await repo.save(ownerMetric);
        }
      })
    );

    logger.info(
      `[OWNERS METRICS] [ALL ${ownerMetrics.length} WALLETS PERSISTED]`
    );
  }
}

export async function persistConsolidatedOwnerTags(
  tags: ConsolidatedOwnerTags[]
) {
  logger.info(`[CONSOLIDATED OWNER TAGS] PERSISTING [${tags.length} WALLETS]`);

  await AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(ConsolidatedOwnerTags);
    await repo.clear();
    await repo.save(tags);
  });

  logger.info(`[CONSOLIDATED OWNER TAGS] PERSISTED [${tags.length} WALLETS]`);
}

export async function persistConsolidatedOwnerMetrics(
  metrics: ConsolidatedOwnerMetric[]
) {
  logger.info(
    `[CONSOLIDATED OWNER METRICS] PERSISTING [${metrics.length} WALLETS]`
  );

  await AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(ConsolidatedOwnerMetric);
    const consolidationKeys = metrics.map((metric) => metric.consolidation_key);
    const consolidationDisplays = metrics.map(
      (metric) => metric.consolidation_display
    );

    const result = await AppDataSource.createQueryBuilder()
      .delete()
      .from(ConsolidatedOwnerMetric)
      .where('consolidation_key NOT IN (:...consolidationKeys)', {
        consolidationKeys
      })
      .orWhere('consolidation_display NOT IN (:...consolidationDisplays)', {
        consolidationDisplays
      })
      .execute();

    logger.info(
      `[CONSOLIDATED OWNER METRICS] [DELETED ${result.affected} WALLETS]`
    );

    await repo.save(metrics);
  });

  logger.info(
    `[CONSOLIDATED OWNER METRICS] [PERSISTED ${metrics.length} WALLETS]`
  );
}

export async function persistOwnerTags(ownersTags: OwnerTags[]) {
  if (ownersTags.length > 0) {
    logger.info(`[OWNERS TAGS] [PERSISTING ${ownersTags.length} WALLETS]`);

    await AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OwnerTags);
      await Promise.all(
        ownersTags.map(async (owner) => {
          if (0 >= owner.memes_balance && 0 >= owner.gradients_balance) {
            await repo.remove(owner);
          } else {
            await repo.upsert(owner, ['wallet']);
          }
        })
      );
    });

    logger.info(`[OWNERS TAGS] [ALL ${ownersTags.length} WALLETS PERSISTED]`);
  }
}

export async function persistMemesExtendedData(data: MemesExtendedData[]) {
  if (data.length > 0) {
    logger.info(
      `[MEMES EXTENDED DATA] [PERSISTING ${data.length} MEMES EXTENDED DATA]`
    );
    await Promise.all(
      data.map(async (md) => {
        const sql = `REPLACE INTO ${MEMES_EXTENDED_DATA_TABLE} SET 
            id=:id, 
            created_at=:created_at, 
            season=:season, 
            meme=:meme, 
            meme_name=:meme_name, 
            collection_size=:collection_size, 
            edition_size=:edition_size, 
            edition_size_rank=:edition_size_rank, 
            museum_holdings=:museum_holdings, 
            museum_holdings_rank=:museum_holdings_rank, 
            edition_size_cleaned=:edition_size_cleaned, 
            edition_size_cleaned_rank=:edition_size_cleaned_rank, 
            hodlers=:hodlers, 
            hodlers_rank=:hodlers_rank, 
            percent_unique=:percent_unique, 
            percent_unique_rank=:percent_unique_rank, 
            percent_unique_cleaned=:percent_unique_cleaned, 
            percent_unique_cleaned_rank=:percent_unique_cleaned_rank`;

        const params = {
          id: md.id,
          created_at: new Date(),
          season: md.season,
          meme: md.meme,
          meme_name: md.meme_name,
          collection_size: md.collection_size,
          edition_size: md.edition_size,
          edition_size_rank: md.edition_size_rank,
          museum_holdings: md.museum_holdings,
          museum_holdings_rank: md.museum_holdings_rank,
          edition_size_cleaned: md.edition_size_cleaned,
          edition_size_cleaned_rank: md.edition_size_cleaned_rank,
          hodlers: md.hodlers,
          hodlers_rank: md.hodlers_rank,
          percent_unique: md.percent_unique,
          percent_unique_rank: md.percent_unique_rank,
          percent_unique_cleaned: md.percent_unique_cleaned,
          percent_unique_cleaned_rank: md.percent_unique_cleaned_rank
        };
        await sqlExecutor.execute(sql, params);
      })
    );
    logger.info(
      `[MEMES EXTENDED DATA] [ALL ${data.length} MEMES EXTENDED DATA PERSISTED]`
    );
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

export async function findVolumeLab(nft: LabNFT): Promise<{
  total_volume_last_24_hours: number;
  total_volume_last_7_days: number;
  total_volume_last_1_month: number;
  total_volume: number;
}> {
  return findVolume(TRANSACTIONS_MEME_LAB_TABLE, nft.id, nft.contract);
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
    tdh = :tdh`;
  await sqlExecutor.execute(sql, {
    date: dateString,
    block: block,
    tdh: location
  });

  logger.info(`[TDH UPLOAD IN ${table} PERSISTED]`);
}

export async function persistTDH(block: number, timestamp: Date, tdh: TDH[]) {
  logger.info(`[TDH] PERSISTING WALLETS TDH [${tdh.length}]`);

  await AppDataSource.transaction(async (manager) => {
    await manager.getRepository(TDH).save(tdh);
    await manager.query(
      `REPLACE INTO ${TDH_BLOCKS_TABLE} SET block_number=?, timestamp=?`,
      [block, timestamp]
    );
  });

  logger.info(`[TDH] PERSISTED ALL WALLETS TDH [${tdh.length}]`);
}

export async function persistConsolidatedTDH(tdh: ConsolidatedTDH[]) {
  logger.info(`[CONSOLIDATED TDH] PERSISTING WALLETS TDH [${tdh.length}]`);

  await AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(ConsolidatedTDH);
    await repo.clear();
    await repo.save(tdh);
    await profilesService.updateProfileTdhs(tdh.at(0)?.block ?? 0, {
      connection: manager.connection
    });
  });

  logger.info(`[CONSOLIDATED TDH] PERSISTED ALL WALLETS TDH [${tdh.length}]`);
}

export async function persistENS(ens: ENS[]) {
  logger.info(`[ENS] PERSISTING ENS [${ens.length}]`);

  await Promise.all(
    ens.map(async (t) => {
      if ((t.display && t.display.length < 150) || !t.display) {
        const sql = `REPLACE INTO ${ENS_TABLE} SET 
          wallet = :wallet,
          display = :display`;
        try {
          await sqlExecutor.execute(sql, {
            wallet: t.wallet,
            display: t.display
          });
        } catch {
          await sqlExecutor.execute(
            `REPLACE INTO ${ENS_TABLE} SET 
            wallet = ?,
            display = ?`,
            [t.wallet, null]
          );
        }
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
  await repo.clear();
  await repo.save(team);
}

export async function fetchTDHForBlock(block: number) {
  const sql = `SELECT ${ENS_TABLE}.display as ens, ${WALLETS_TDH_TABLE}.* FROM ${WALLETS_TDH_TABLE} LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet WHERE block=:block;`;
  const results = await sqlExecutor.execute(sql, {
    block: block
  });
  results.map((r: any) => (r.memes = JSON.parse(r.memes)));
  results.map((r: any) => (r.gradients = JSON.parse(r.gradients)));
  return results;
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
  force: boolean,
  consolidations: ConsolidationEvent[]
) {
  if (consolidations.length > 0) {
    logger.info(
      `[CONSOLIDATIONS] [FORCE ${force}] [PERSISTING ${consolidations.length} RESULTS]`
    );

    const repo = AppDataSource.getRepository(Consolidation);

    if (force) {
      repo.clear();
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
}

export async function persistDelegations(
  force: boolean,
  registrations: DelegationEvent[],
  revocations: DelegationEvent[]
) {
  logger.info(
    `[DELEGATIONS] [FORCE ${force}] [PERSISTING ${registrations.length} REGISTRATIONS] [PERSISTING ${revocations.length} REVOCATIONS]`
  );

  const repo = AppDataSource.getRepository(Delegation);

  if (force) {
    repo.clear();
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
    `[DELEGATIONS] [${registrations.length} [REGISTRATIONS PERSISTED] [${revocations.length} REVOCATIONS PERSISTED]`
  );
}

export async function persistNftHistory(nftHistory: NFTHistory[]) {
  await AppDataSource.getRepository(NFTHistory).save(nftHistory);
}

export async function persistNftClaims(claims: NFTHistoryClaim[]) {
  await AppDataSource.getRepository(NFTHistoryClaim).save(claims);
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
  await AppDataSource.getRepository(NFTHistoryBlock).save({
    block
  });
}

export async function fetchLatestNftUri(tokenId: number, contract: string) {
  const latestHistory = await AppDataSource.getRepository(NFTHistory).findOne({
    where: { nft_id: tokenId, contract: contract },
    order: { transaction_date: 'DESC' }
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

export async function persistTDHHistory(tdhHistory: TDHHistory[]) {
  await AppDataSource.getRepository(TDHHistory).upsert(tdhHistory, [
    'date',
    'consolidation_key',
    'block'
  ]);
}

export async function persistGlobalTDHHistory(globalHistory: GlobalTDHHistory) {
  const globalHistoryRepo = AppDataSource.getRepository(GlobalTDHHistory);
  await globalHistoryRepo.upsert(globalHistory, ['date', 'block']);
}

export async function fetchLatestNextgenTransactionsBlockNumber() {
  const repo = AppDataSource.getRepository(NextGenTransactionsBlock);
  const latestBlock = await repo.findOne({
    order: {
      block_number: 'DESC'
    },
    where: {}
  });
  return latestBlock ? latestBlock.block_number : 0;
}

export async function persistNextgenTransactionsBlockNumber(block: number) {
  const repo = AppDataSource.getRepository(NextGenTransactionsBlock);
  await repo.save({
    block_number: block
  });
}
