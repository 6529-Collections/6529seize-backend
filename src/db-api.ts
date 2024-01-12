import {
  ARTISTS_TABLE,
  CONSOLIDATED_OWNERS_METRICS_TABLE,
  CONSOLIDATED_OWNERS_TAGS_TABLE,
  CONSOLIDATED_UPLOADS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  DISTRIBUTION_PHOTO_TABLE,
  DISTRIBUTION_TABLE,
  ENS_TABLE,
  GRADIENT_CONTRACT,
  LAB_EXTENDED_DATA_TABLE,
  MANIFOLD,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_BURN_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NFTS_HISTORY_TABLE,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  NULL_ADDRESS,
  OWNERS_MEME_LAB_TABLE,
  OWNERS_METRICS_TABLE,
  OWNERS_TABLE,
  OWNERS_TAGS_TABLE,
  REMEMES_TABLE,
  REMEMES_UPLOADS,
  ROYALTIES_UPLOADS_TABLE,
  SIX529_MUSEUM,
  TDH_BLOCKS_TABLE,
  TDH_GLOBAL_HISTORY_TABLE,
  TDH_HISTORY_TABLE,
  TEAM_TABLE,
  TRANSACTIONS_MEME_LAB_TABLE,
  TRANSACTIONS_TABLE,
  UPLOADS_TABLE,
  USER_TABLE,
  WALLETS_TDH_TABLE,
  NEXTGEN_COLLECTIONS_TABLE,
  NEXTGEN_TOKENS_TABLE,
  NEXTGEN_LOGS_TABLE,
  NEXTGEN_TRANSACTIONS_TABLE
} from './constants';
import { RememeSource } from './entities/IRememe';
import { User } from './entities/IUser';
import {
  areEqualAddresses,
  distinct,
  extractConsolidationWallets
} from './helpers';
import { getConsolidationsSql, getProfilePageSql } from './sql_helpers';
import { getProof } from './merkle_proof';
import { ConnectionWrapper, setSqlExecutor, sqlExecutor } from './sql-executor';

import * as mysql from 'mysql';
import { Time } from './time';
import { DbPoolName, DbQueryOptions } from './db-query.options';
import { Logger } from './logging';
import { calculateLevel } from './profiles/profile-level';
import { Nft } from 'alchemy-sdk';
import {
  constructFilters,
  constructFiltersOR
} from './api-serverless/src/api-helpers';
import { profilesService } from './profiles/profiles.service';
import { repService } from './api-serverless/src/profiles/rep.service';
import { DEFAULT_PAGE_SIZE } from './api-serverless/src/api-constants';
import { NextGenCollectionStatus } from './api-serverless/src/api-filters';

let read_pool: mysql.Pool;
let write_pool: mysql.Pool;

const WRITE_OPERATIONS = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'];

const logger = Logger.get('DB_API');

export async function connect() {
  if (
    !process.env.DB_HOST ||
    !process.env.DB_USER ||
    !process.env.DB_PASS ||
    !process.env.DB_PORT
  ) {
    logger.error('[MISSING CONFIGURATION FOR WRITE DB] [EXITING]');
    process.exit();
  }
  if (
    !process.env.DB_HOST_READ ||
    !process.env.DB_USER_READ ||
    !process.env.DB_PASS_READ ||
    !process.env.DB_PORT
  ) {
    logger.error('[MISSING CONFIGURATION FOR READ DB] [EXITING]');
    process.exit();
  }
  const port = +process.env.DB_PORT;
  write_pool = mysql.createPool({
    connectionLimit: 5,
    connectTimeout: Time.seconds(30).toMillis(),
    acquireTimeout: Time.seconds(30).toMillis(),
    timeout: Time.seconds(30).toMillis(),
    host: process.env.DB_HOST,
    port: port,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    charset: 'utf8mb4',
    database: process.env.DB_NAME
  });
  read_pool = mysql.createPool({
    connectionLimit: 10,
    connectTimeout: Time.seconds(30).toMillis(),
    acquireTimeout: Time.seconds(30).toMillis(),
    timeout: Time.seconds(30).toMillis(),
    host: process.env.DB_HOST_READ,
    port: port,
    user: process.env.DB_USER_READ,
    password: process.env.DB_PASS_READ,
    charset: 'utf8mb4',
    database: process.env.DB_NAME
  });
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
  logger.info(`[CONNECTION POOLS CREATED]`);
}

function getPoolNameBySql(sql: string): DbPoolName {
  return WRITE_OPERATIONS.some((op) => sql.trim().toUpperCase().startsWith(op))
    ? DbPoolName.WRITE
    : DbPoolName.READ;
}

function getDbConnecionForQuery(
  sql: string,
  forcePool?: DbPoolName
): Promise<mysql.PoolConnection> {
  const poolName = forcePool ?? getPoolNameBySql(sql);
  return getDbConnectionByPoolName(poolName);
}

function getPoolByName(poolName: DbPoolName): mysql.Pool {
  const poolsMap: Record<DbPoolName, mysql.Pool> = {
    [DbPoolName.READ]: read_pool,
    [DbPoolName.WRITE]: write_pool
  };
  return poolsMap[poolName];
}

function getDbConnectionByPoolName(
  poolName: DbPoolName
): Promise<mysql.PoolConnection> {
  const pool = getPoolByName(poolName);
  return new Promise((resolve, reject) => {
    pool.getConnection(function (
      err: mysql.MysqlError,
      dbcon: mysql.PoolConnection
    ) {
      if (err) {
        logger.error(`Failed to establish connection to ${poolName} [${err}]`);
        reject(err);
      }
      resolve(dbcon);
    });
  });
}

async function execNativeTransactionally<T>(
  executable: (connectionWrapper: ConnectionWrapper<any>) => Promise<T>
): Promise<T> {
  const connection = await getDbConnectionByPoolName(DbPoolName.WRITE);
  try {
    connection.beginTransaction();
    const result = await executable({ connection: connection });
    return await new Promise((resolve, reject) => {
      connection.commit((err: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  } catch (e) {
    connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}

function prepareStatemant(query: string, values: Record<string, any>) {
  return query.replace(/:(\w+)/g, function (txt: any, key: any) {
    if (values.hasOwnProperty(key)) {
      const value = values[key];
      if (Array.isArray(value)) {
        return value.map((v) => mysql.escape(v)).join(', ');
      }
      return mysql.escape(value);
    }
    return txt;
  });
}

async function execSQLWithParams<T>(
  sql: string,
  params?: Record<string, any>,
  options?: {
    forcePool?: DbPoolName;
    wrappedConnection?: ConnectionWrapper<mysql.PoolConnection>;
  }
): Promise<T[]> {
  const externallyGivenConnection = options?.wrappedConnection?.connection;
  const connection: mysql.PoolConnection =
    externallyGivenConnection ||
    (await getDbConnecionForQuery(sql, options?.forcePool));
  return new Promise((resolve, reject) => {
    connection.config.queryFormat = function (query, values) {
      if (!values) return query;
      return prepareStatemant(query, values);
    };
    connection.query({ sql, values: params }, (err: any, result: T[]) => {
      if (!externallyGivenConnection) {
        connection?.release();
      }
      if (err) {
        logger.error(
          `Error "${err}" executing SQL query ${sql}${
            params ? ` with params ${JSON.stringify(params)}` : ''
          }\n`
        );
        reject(err);
      } else {
        resolve(Object.values(JSON.parse(JSON.stringify(result))));
      }
    });
  });
}

export async function fetchLatestTDHBlockNumber() {
  const sql = `SELECT block_number FROM ${TDH_BLOCKS_TABLE} order by block_number desc limit 1;`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0 ? r[0].block_number : 0;
}

export async function fetchLatestTDHHistoryBlockNumber() {
  const sql = `SELECT block FROM ${TDH_HISTORY_TABLE} order by block desc limit 1;`;
  const r = await sqlExecutor.execute(sql);
  return r.length > 0 ? r[0].block : 0;
}

async function getTeamWallets() {
  const sql = `SELECT wallet FROM ${TEAM_TABLE}`;
  let results = await sqlExecutor.execute(sql);
  results = results.map((r: { wallet: string }) => r.wallet);
  return results;
}

async function fetchPaginated(
  table: string,
  params: any,
  orderBy: string,
  pageSize: number,
  page: number,
  filters: string,
  fields?: string,
  joins?: string,
  groups?: string
) {
  const countSql = `SELECT COUNT(1) as count FROM (SELECT 1 FROM ${table} ${
    joins ?? ''
  } ${filters}${groups ? ` GROUP BY ${groups}` : ``}) inner_q`;

  let resultsSql = `SELECT ${fields ? fields : '*'} FROM ${table} ${
    joins ? joins : ''
  } ${filters} ${groups ? `group by ${groups}` : ``} order by ${orderBy} ${
    pageSize > 0 ? `LIMIT ${pageSize}` : ``
  }`;
  if (page > 1) {
    const offset = pageSize * (page - 1);
    resultsSql += ` OFFSET ${offset}`;
  }

  const count = await sqlExecutor
    .execute(countSql, params)
    .then((r) => r[0].count);
  const data = await sqlExecutor.execute(resultsSql, params);

  logger.info(`Count sql: '${countSql}', Result: ${count}`);
  logger.info(`Result sql: ${resultsSql}`);
  logger.debug(`Result data: %o`, data);

  return {
    count,
    page,
    next: count > pageSize * page,
    data
  };
}

export async function fetchRandomImage() {
  const sql = `SELECT scaled,image from ${NFTS_TABLE} WHERE contract=:memes_contract ORDER BY RAND() LIMIT 1;`;
  return await sqlExecutor.execute(sql, {
    memes_contract: MEMES_CONTRACT
  });
}

export async function fetchBlocks(pageSize: number, page: number) {
  return fetchPaginated(
    TDH_BLOCKS_TABLE,
    {},
    'block_number desc',
    pageSize,
    page,
    '',
    ''
  );
}

export async function fetchUploads(
  pageSize: number,
  page: number,
  block: number,
  date: string
) {
  return fetchUploadsByTable(UPLOADS_TABLE, pageSize, page, block, date);
}

export async function fetchConsolidatedUploads(
  pageSize: number,
  page: number,
  block: number,
  date: string
) {
  return fetchUploadsByTable(
    CONSOLIDATED_UPLOADS_TABLE,
    pageSize,
    page,
    block,
    date
  );
}

async function fetchUploadsByTable(
  table: string,
  pageSize: number,
  page: number,
  block: number,
  date: string
) {
  let filters = '';
  const params: any = {};
  if (block) {
    filters = constructFilters(filters, `block <= :block`);
    params.block = block;
  }
  if (date) {
    filters = constructFilters(filters, `STR_TO_DATE(date, '%Y%m%d') <= :date`);
    params.date = date;
  }

  return fetchPaginated(
    table,
    params,
    'block desc',
    pageSize,
    page,
    filters,
    ''
  );
}

export async function fetchArtists(
  pageSize: number,
  page: number,
  meme_nfts: string
) {
  let filters = '';
  const params: any = {};
  if (meme_nfts) {
    meme_nfts.split(',').forEach((nft_id, index) => {
      const paramName = `nft_id${index}`;
      const query = `%\"id\": ${nft_id}%`;

      if (index === 0) {
        filters += 'WHERE ';
      } else {
        filters += ' OR ';
      }

      filters += `memes LIKE :${paramName}`;
      params[paramName] = query;
    });
  }

  return fetchPaginated(
    ARTISTS_TABLE,
    params,
    'created_at desc',
    pageSize,
    page,
    filters
  );
}

export async function fetchArtistsNamesMemes() {
  return fetchArtistsNamesByTable('memes');
}

export async function fetchArtistsNamesMemeLab() {
  return fetchArtistsNamesByTable('memelab');
}

async function fetchArtistsNamesByTable(field: string) {
  const sql = `SELECT name, ${field} as cards 
      FROM artists 
      WHERE ${field} IS NOT NULL 
        AND JSON_VALID(${field}) 
        AND JSON_TYPE(${field}) = 'ARRAY' 
        AND JSON_LENGTH(${field}) > 0`;
  const artists = await sqlExecutor.execute(sql);
  return artists
    .map((a: any) => {
      const cards = JSON.parse(a.cards);
      return {
        name: a.name,
        cards: cards.map((m: any) => m.id).sort((a: number, b: number) => a - b)
      };
    })
    .sort((a: any, b: any) => {
      const minCardA = Math.min(...a.cards);
      const minCardB = Math.min(...b.cards);
      return minCardA - minCardB;
    });
}

export async function fetchLabNFTs(
  memeIds: string,
  pageSize: number,
  page: number,
  nfts: string,
  sortDir: string
) {
  let filters = '';
  const params: any = {};
  if (memeIds) {
    memeIds.split(',').forEach((nft_id, index) => {
      const paramName = `nft_id${index}`;
      filters = constructFilters(
        filters,
        `JSON_CONTAINS(meme_references, :${paramName},'$')`
      );
      params[paramName] = nft_id;
    });
  }

  if (nfts) {
    filters = constructFilters(filters, `${NFTS_MEME_LAB_TABLE}.id in (:nfts)`);
    params.nfts = nfts.split(',');
  }

  const fields = `
    ${NFTS_MEME_LAB_TABLE}.*,
    IF(d.card_id IS NOT NULL, TRUE, FALSE) AS has_distribution
  `;
  const joinClause = `
    LEFT JOIN distribution d ON d.card_id = ${NFTS_MEME_LAB_TABLE}.id AND d.contract = :meme_lab_contract
  `;
  const groupBy = `${NFTS_MEME_LAB_TABLE}.id`;
  params.meme_lab_contract = MEMELAB_CONTRACT;

  return fetchPaginated(
    NFTS_MEME_LAB_TABLE,
    params,
    `id ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joinClause,
    groupBy
  );
}

export async function fetchLabOwners(
  pageSize: number,
  page: number,
  wallets: string,
  nfts: string,
  sort: string,
  sortDir: string
) {
  let filters = '';
  const params: any = {};
  if (wallets) {
    filters = constructFilters(
      filters,
      `(${OWNERS_MEME_LAB_TABLE}.wallet in (:wallets) OR ${ENS_TABLE}.display in (:wallets))`
    );
    params.wallets = wallets.split(',');
  }
  if (nfts) {
    filters = constructFilters(filters, `token_id in (:nfts)`);
    params.nfts = nfts.split(',');
  }

  const fields = ` ${OWNERS_MEME_LAB_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${OWNERS_MEME_LAB_TABLE}.wallet=${ENS_TABLE}.wallet`;

  const result = await fetchPaginated(
    OWNERS_MEME_LAB_TABLE,
    params,
    `${sort} ${sortDir}, token_id asc, created_at desc`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
  result.data = await enhanceDataWithHandlesAndLevel(result.data);
  return result;
}

export async function fetchTeam(pageSize: number, page: number) {
  return fetchPaginated(
    TEAM_TABLE,
    {},
    `created_at desc`,
    pageSize,
    page,
    '',
    '',
    ''
  );
}

export async function fetchNFTs(
  pageSize: number,
  page: number,
  contracts: string,
  nfts: string,
  sortDir: string
) {
  let filters = '';
  const params: any = {};
  if (contracts) {
    filters = constructFilters(filters, `contract in (:contracts)`);
    params.contracts = contracts.split(',');
  }
  if (nfts) {
    filters = constructFilters(filters, `id in (:nfts)`);
    params.nfts = nfts.split(',');
  }

  return fetchPaginated(
    NFTS_TABLE,
    params,
    `contract desc, id ${sortDir}`,
    pageSize,
    page,
    filters,
    `${NFTS_TABLE}.*, CASE WHEN EXISTS (SELECT 1 FROM distribution d WHERE d.card_id = ${NFTS_TABLE}.id AND d.contract = ${NFTS_TABLE}.contract) THEN TRUE ELSE FALSE END AS has_distribution`,
    ''
  );
}

export async function fetchGradients(
  pageSize: number,
  page: number,
  sort: string,
  sortDir: string
) {
  const filters = constructFilters(
    '',
    `${NFTS_TABLE}.contract = :gradient_contract`
  );
  const params = {
    gradient_contract: GRADIENT_CONTRACT
  };

  let joins = ` INNER JOIN ${OWNERS_TABLE} ON ${NFTS_TABLE}.contract = ${OWNERS_TABLE}.contract AND ${NFTS_TABLE}.id = ${OWNERS_TABLE}.token_id `;
  joins += ` LEFT JOIN ${ENS_TABLE} ON ${OWNERS_TABLE}.wallet=${ENS_TABLE}.wallet`;
  const fields = ` ${NFTS_TABLE}.*, RANK() OVER (ORDER BY boosted_tdh desc, id asc) AS tdh_rank, ${OWNERS_TABLE}.wallet as owner, ${ENS_TABLE}.display as owner_display `;

  return fetchPaginated(
    NFTS_TABLE,
    params,
    `${sort} ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchNFTsForWallet(
  address: string,
  pageSize: number,
  page: number
) {
  const fields = ` ${NFTS_TABLE}.* `;
  const joins = `INNER JOIN owners ON nfts.id = owners.token_id AND nfts.contract = owners.contract`;
  const filters = `WHERE owners.wallet = :wallet`;
  const params = {
    wallet: address
  };

  return fetchPaginated(
    NFTS_TABLE,
    params,
    'nfts.contract asc, nfts.id asc',
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchMemesExtended(
  pageSize: number,
  page: number,
  nfts: string,
  seasons: string,
  sortDir: string
) {
  let filters = '';
  const params: any = {};

  if (nfts) {
    filters = constructFilters(filters, `id in (:nfts)`);
    params.nfts = nfts.split(',');
  }
  if (seasons) {
    filters = constructFilters(filters, `season in (:seasons)`);
    params.seasons = seasons.split(',');
  }
  return fetchPaginated(
    MEMES_EXTENDED_DATA_TABLE,
    params,
    `id ${sortDir}`,
    pageSize,
    page,
    filters
  );
}

export async function fetchMemesSeasons(sortDir: string) {
  const sql = `SELECT season, COUNT(id) as count, GROUP_CONCAT(id) AS token_ids FROM ${MEMES_EXTENDED_DATA_TABLE} GROUP BY season order by season ${sortDir}`;
  return await sqlExecutor.execute(sql);
}

export async function fetchMemesLite(sortDir: string) {
  const filters = constructFilters(
    '',
    `${NFTS_TABLE}.contract = :memes_contract`
  );
  const params = {
    memes_contract: MEMES_CONTRACT
  };

  return fetchPaginated(
    NFTS_TABLE,
    params,
    `id ${sortDir}`,
    0,
    1,
    filters,
    'id, name, contract, icon, thumbnail, scaled, image, animation',
    ''
  );
}

export async function fetchOwners(
  pageSize: number,
  page: number,
  wallets: string,
  contracts: string,
  nfts: string
) {
  let filters = '';
  const params: any = {};

  if (wallets) {
    filters = constructFilters(
      filters,
      `(${OWNERS_TABLE}.wallet in (:wallets) OR ${ENS_TABLE}.display in (:wallets))`
    );
    params.wallets = wallets.split(',');
  }
  if (contracts) {
    filters = constructFilters(filters, `contract in (:contracts)`);
    params.contracts = contracts.split(',');
  }
  if (nfts) {
    filters = constructFilters(filters, `token_id in (:nfts)`);
    params.nfts = nfts.split(',');
  }

  const fields = ` ${OWNERS_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${OWNERS_TABLE}.wallet=${ENS_TABLE}.wallet`;

  return fetchPaginated(
    OWNERS_TABLE,
    params,
    'token_id asc, created_at desc',
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchOwnersTags(
  pageSize: number,
  page: number,
  wallets: string
) {
  let filters = '';
  const params: any = {};

  if (wallets) {
    filters = constructFilters(
      filters,
      `${OWNERS_TAGS_TABLE}.wallet in (:wallets) OR ${ENS_TABLE}.display in (:wallets)`
    );
    params.wallets = wallets.split(',');
  }

  const fields = ` ${OWNERS_TAGS_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${OWNERS_TAGS_TABLE}.wallet=${ENS_TABLE}.wallet`;

  return fetchPaginated(
    OWNERS_TAGS_TABLE,
    params,
    'memes_balance desc, gradients_balance desc',
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

async function resolveEns(walletsStr: string) {
  const wallets = walletsStr.split(',');
  const sql = `SELECT wallet,display FROM ${ENS_TABLE} WHERE wallet IN (:wallets) OR display IN (:wallets)`;
  const results = await sqlExecutor.execute(sql, {
    wallets: wallets
  });
  const returnResults: string[] = [];
  wallets.forEach((wallet: any) => {
    const w = results.find(
      (r: any) =>
        areEqualAddresses(r.wallet, wallet) ||
        areEqualAddresses(r.display, wallet)
    );
    if (w) {
      returnResults.push(w.wallet);
    } else {
      returnResults.push(wallet);
    }
  });
  return returnResults;
}

async function getTransactionFilters(
  wallets: string,
  nfts: string,
  type_filter: string
): Promise<{
  filters: string;
  params: any;
} | null> {
  let filters = '';
  const params: any = {};
  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    if (resolvedWallets.length == 0) {
      return null;
    }

    if (type_filter == 'purchases') {
      filters = constructFilters(filters, `to_address in (:wallets)`);
    } else if (type_filter === 'sales') {
      filters = constructFilters(filters, `from_address in (:wallets)`);
    } else {
      filters = constructFilters(
        filters,
        `(from_address in (:wallets) OR to_address in (:wallets))`
      );
    }
    params.wallets = resolvedWallets;
  }
  if (nfts) {
    filters = constructFilters(filters, `token_id in (:nfts)`);
    params.nfts = nfts.split(',');
  }
  if (type_filter) {
    let newTypeFilter = '';
    switch (type_filter) {
      case 'sales':
      case 'purchases':
        newTypeFilter += `value > 0 AND from_address != :null_address and from_address != :manifold and to_address != :null_address`;
        break;
      case 'airdrops':
        newTypeFilter += `value = 0 AND from_address = :null_address`;
        break;
      case 'mints':
        newTypeFilter += `value > 0 AND (from_address = :null_address OR from_address = :manifold)`;
        break;
      case 'transfers':
        newTypeFilter += `value = 0 and from_address != :null_address and to_address != :null_address`;
        break;
      case 'burns':
        newTypeFilter += `to_address = :null_address`;
        break;
    }
    if (newTypeFilter) {
      filters = constructFilters(filters, newTypeFilter);
      params.null_address = NULL_ADDRESS;
      params.manifold = MANIFOLD;
    }
  }

  return {
    filters,
    params
  };
}
export async function fetchLabTransactions(
  pageSize: number,
  page: number,
  wallets: string,
  nfts: string,
  type_filter: string
) {
  const filters = await getTransactionFilters(wallets, nfts, type_filter);
  if (!filters) {
    return returnEmpty();
  }

  const fields = `${TRANSACTIONS_MEME_LAB_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON ${TRANSACTIONS_MEME_LAB_TABLE}.from_address=ens1.wallet LEFT JOIN ${ENS_TABLE} ens2 ON ${TRANSACTIONS_MEME_LAB_TABLE}.to_address=ens2.wallet`;

  return fetchPaginated(
    TRANSACTIONS_MEME_LAB_TABLE,
    filters.params,
    'transaction_date desc',
    pageSize,
    page,
    filters.filters,
    fields,
    joins
  );
}

export async function fetchTransactions(
  pageSize: number,
  page: number,
  wallets: string,
  contracts: string,
  nfts: string,
  type_filter: string
) {
  const filters = await getTransactionFilters(wallets, nfts, type_filter);
  if (!filters) {
    return returnEmpty();
  }

  if (contracts) {
    filters.filters = constructFilters(
      filters.filters,
      `contract in (${mysql.escape(contracts.split(','))})`
    );
  }

  const fields = `${TRANSACTIONS_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON ${TRANSACTIONS_TABLE}.from_address=ens1.wallet LEFT JOIN ${ENS_TABLE} ens2 ON ${TRANSACTIONS_TABLE}.to_address=ens2.wallet`;

  return fetchPaginated(
    TRANSACTIONS_TABLE,
    filters.params,
    'transaction_date desc',
    pageSize,
    page,
    filters.filters,
    fields,
    joins
  );
}

export async function fetchGradientTdh(pageSize: number, page: number) {
  const tdhBlock = await fetchLatestTDHBlockNumber();

  let filters = constructFilters('', `block=:block`);
  filters = constructFilters(filters, `gradients_balance > 0`);
  const params = {
    block: tdhBlock
  };

  const fields = ` ${WALLETS_TDH_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet`;

  return fetchPaginated(
    WALLETS_TDH_TABLE,
    params,
    `tdh DESC`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchNftTdh(
  pageSize: number,
  page: number,
  contract: string,
  nftId: number,
  wallets: string,
  sort: string,
  sortDir: string
) {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  let filters = `WHERE block=:block AND j.id=:nft_id `;
  const params: any = {
    block: tdhBlock,
    nft_id: nftId
  };
  if (wallets) {
    filters += ` AND ${WALLETS_TDH_TABLE}.wallet in (:wallets)`;
    params.wallets = wallets.split(',');
  }

  let joins: string;
  if (areEqualAddresses(contract, MEMES_CONTRACT)) {
    joins = `LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet CROSS JOIN JSON_TABLE(memes, '$[*]' COLUMNS (
        id INT PATH '$.id',
        tdh DOUBLE PATH '$.tdh',
        tdh__raw varchar(100) PATH '$.tdh__raw',
        balance INT PATH '$.balance'
      )
    ) AS j`;
  } else if (areEqualAddresses(contract, GRADIENT_CONTRACT)) {
    joins = `LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet CROSS JOIN JSON_TABLE(gradients, '$[*]' COLUMNS (
        id varchar(100) PATH '$.id',
        tdh varchar(100) PATH '$.tdh',
        tdh__raw varchar(100) PATH '$.tdh__raw',
        balance INT PATH '$.balance',
      )
    ) AS j`;
  } else {
    return returnEmpty();
  }

  joins += ` JOIN (SELECT wallet, RANK() OVER(ORDER BY ${OWNERS_TABLE}.balance DESC) AS dense_rank_balance from ${OWNERS_TABLE} where ${OWNERS_TABLE}.contract=${mysql.escape(
    contract
  )} and ${OWNERS_TABLE}.token_id=${nftId}) as dense_table ON ${WALLETS_TDH_TABLE}.wallet = dense_table.wallet`;
  joins += ` LEFT JOIN ${OWNERS_METRICS_TABLE} on ${WALLETS_TDH_TABLE}.wallet=${OWNERS_METRICS_TABLE}.wallet`;

  const fields = ` ${OWNERS_METRICS_TABLE}.balance, ${WALLETS_TDH_TABLE}.*,${ENS_TABLE}.display as wallet_display, dense_table.dense_rank_balance `;

  switch (sort) {
    case 'card_tdh':
      sort = 'CAST(j.tdh AS DECIMAL)';
      break;
    case 'card_tdh__raw':
      sort = 'CAST(j.tdh__raw AS DECIMAL)';
      break;
    case 'card_balance':
      sort = 'j.balance';
      break;
    case 'total_tdh':
      sort = 'boosted_tdh';
      break;
    case 'total_tdh__raw':
      sort = 'tdh__raw';
      break;
    case 'total_balance':
      sort = `${OWNERS_METRICS_TABLE}.balance`;
      break;
  }

  const result = await fetchPaginated(
    WALLETS_TDH_TABLE,
    params,
    `${sort} ${sortDir}, boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
  result.data = await enhanceDataWithHandlesAndLevel(result.data);
  return result;
}

export async function fetchConsolidatedNftTdh(
  pageSize: number,
  page: number,
  contract: string,
  nftId: number,
  wallets: string,
  sort: string,
  sortDir: string
) {
  let filters = `WHERE j.id=:nft_id `;
  const params: any = {
    nft_id: nftId
  };
  if (wallets) {
    wallets.split(',').forEach((w, index) => {
      const paramName = `wallet${index}`;
      filters = constructFilters(
        filters,
        `LOWER(${CONSOLIDATED_WALLETS_TDH_TABLE}.wallets) LIKE :${paramName}`
      );
      params[paramName] = `%${w.toLowerCase()}%`;
    });
  }

  let joins: string;
  if (areEqualAddresses(contract, MEMES_CONTRACT)) {
    joins = ` CROSS JOIN JSON_TABLE(memes, '$[*]' COLUMNS (
        id INT PATH '$.id',
        tdh DOUBLE PATH '$.tdh',
        tdh__raw varchar(100) PATH '$.tdh__raw',
        balance INT PATH '$.balance'
      )
    ) AS j`;
  } else if (areEqualAddresses(contract, GRADIENT_CONTRACT)) {
    joins = ` CROSS JOIN JSON_TABLE(gradients, '$[*]' COLUMNS (
        id varchar(100) PATH '$.id',
        tdh varchar(100) PATH '$.tdh',
        tdh__raw varchar(100) PATH '$.tdh__raw',
        balance INT PATH '$.balance',
      )
    ) AS j`;
  } else {
    return returnEmpty();
  }

  joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_METRICS_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_key `;

  const fields = ` ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance, ${CONSOLIDATED_WALLETS_TDH_TABLE}.* `;

  switch (sort) {
    case 'card_tdh':
      sort = 'CAST(j.tdh AS DECIMAL)';
      break;
    case 'card_tdh__raw':
      sort = 'CAST(j.tdh__raw AS DECIMAL)';
      break;
    case 'card_balance':
      sort = 'j.balance';
      break;
    case 'total_tdh':
      sort = 'boosted_tdh';
      break;
    case 'total_tdh__raw':
      sort = 'tdh__raw';
      break;
    case 'total_balance':
      sort = `${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance`;
      break;
  }

  const result = await fetchPaginated(
    CONSOLIDATED_WALLETS_TDH_TABLE,
    params,
    `${sort} ${sortDir}, boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
  result.data = await enhanceDataWithHandlesAndLevel(result.data);
  return result;
}

export async function fetchTDH(
  pageSize: number,
  page: number,
  wallets: string,
  sort: string,
  sortDir: string,
  tdh_filter: string,
  hideMuseum: boolean,
  hideTeam: boolean
) {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  let filters = `WHERE block=:block`;
  const params: any = {
    block: tdhBlock
  };
  if (hideMuseum) {
    filters = constructFilters(
      filters,
      `${WALLETS_TDH_TABLE}.wallet != :museum`
    );
    params.museum = SIX529_MUSEUM;
  }
  if (hideTeam) {
    const team: string[] = await getTeamWallets();
    filters = constructFilters(
      filters,
      `${OWNERS_METRICS_TABLE}.wallet NOT IN (:team)`
    );
    params.team = team;
  }
  if (wallets) {
    filters = constructFilters(
      filters,
      `${WALLETS_TDH_TABLE}.wallet in (:wallets)`
    );
    params.wallets = wallets.split(',');
  }
  if (tdh_filter) {
    switch (tdh_filter) {
      case 'memes_set':
        filters = constructFilters(
          filters,
          `${WALLETS_TDH_TABLE}.memes_cards_sets > 0`
        );
        break;
      case 'memes_genesis':
        filters = constructFilters(filters, `${WALLETS_TDH_TABLE}.genesis > 0`);
        break;
      case 'gradients':
        filters = constructFilters(
          filters,
          `${WALLETS_TDH_TABLE}.gradients_balance > 0`
        );
        break;
    }
  }

  const fields = ` ${WALLETS_TDH_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet`;

  return fetchPaginated(
    WALLETS_TDH_TABLE,
    params,
    `${sort} ${sortDir}, boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchOwnerMetrics(
  pageSize: number,
  page: number,
  wallets: string,
  sort: string,
  sortDir: string,
  metrics_filter: string,
  hideMuseum: boolean,
  hideTeam: boolean,
  profilePage: boolean
) {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  let filters = '';
  let hideWalletFilters = '';
  const params: any = {};
  if (hideMuseum) {
    filters = constructFilters(
      filters,
      `${OWNERS_METRICS_TABLE}.wallet != :museum`
    );
    params.museum = SIX529_MUSEUM;
  }
  if (hideTeam) {
    const team: string[] = await getTeamWallets();
    filters = constructFilters(
      filters,
      `${OWNERS_METRICS_TABLE}.wallet NOT IN (:team)`
    );
    params.team = team;
  }
  hideWalletFilters = filters;
  if (wallets) {
    filters = constructFilters(
      filters,
      `${OWNERS_METRICS_TABLE}.wallet in (:wallets) OR ${ENS_TABLE}.display in (:wallets)`
    );
    params.wallets = wallets.split(',').map((w) => w.toLowerCase());
  }
  if (metrics_filter) {
    switch (metrics_filter) {
      case 'memes':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_balance > 0`
        );
        break;
      case 'memes_set':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_cards_sets > 0`
        );
        break;
      case 'memes_genesis':
        filters = constructFilters(filters, `${OWNERS_TAGS_TABLE}.genesis > 0`);
        break;
      case 'gradients':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.gradients_balance > 0`
        );
        break;
      case 'memes_set_minus1':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_cards_sets_minus1 > 0`
        );
        break;
      case 'memes_set_szn1':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_cards_sets_szn1 > 0`
        );
        break;
      case 'memes_set_szn2':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_cards_sets_szn2 > 0`
        );
        break;
      case 'memes_set_szn3':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_cards_sets_szn3 > 0`
        );
        break;
      case 'memes_set_szn4':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_cards_sets_szn4 > 0`
        );
        break;
      case 'memes_set_szn5':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_cards_sets_szn5 > 0`
        );
        break;
      case 'memes_set_szn6':
        filters = constructFilters(
          filters,
          `${OWNERS_TAGS_TABLE}.memes_cards_sets_szn6 > 0`
        );
        break;
    }
  }

  let ownerMetricsSelect: string;

  if (!wallets) {
    ownerMetricsSelect = ` ${OWNERS_METRICS_TABLE}.*, 
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.balance DESC) AS dense_rank_balance,
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance DESC) AS dense_rank_balance_memes, 
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season1 DESC) AS dense_rank_balance_memes_season1, 
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season2 DESC) AS dense_rank_balance_memes_season2,
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season3 DESC) AS dense_rank_balance_memes_season3,
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season4 DESC) AS dense_rank_balance_memes_season4, 
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season5 DESC) AS dense_rank_balance_memes_season5,
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season6 DESC) AS dense_rank_balance_memes_season6,
    RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients`;
  } else {
    ownerMetricsSelect = ` ${OWNERS_METRICS_TABLE}.*, 
    dense_table.dense_rank_sort,
    dense_table.dense_rank_balance,
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.balance = ${OWNERS_METRICS_TABLE}2.balance) AS dense_rank_balance__ties,
    dense_table.dense_rank_unique,
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes+${OWNERS_TAGS_TABLE}.gradients_balance = ${OWNERS_TAGS_TABLE}2.unique_memes+${OWNERS_TAGS_TABLE}2.gradients_balance) AS dense_rank_unique__ties,
    dense_table.dense_rank_balance_memes, 
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.memes_balance = ${OWNERS_METRICS_TABLE}2.memes_balance) AS dense_rank_balance_memes__ties,
    dense_table.dense_rank_balance_memes_season1,
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.memes_balance_season1 = ${OWNERS_METRICS_TABLE}2.memes_balance_season1) AS dense_rank_balance_memes_season1__ties, 
    dense_table.dense_rank_balance_memes_season2,
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.memes_balance_season2 = ${OWNERS_METRICS_TABLE}2.memes_balance_season2) AS dense_rank_balance_memes_season2__ties,
    dense_table.dense_rank_balance_memes_season3,
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.memes_balance_season3 = ${OWNERS_METRICS_TABLE}2.memes_balance_season3) AS dense_rank_balance_memes_season3__ties, 
    dense_table.dense_rank_balance_memes_season4,
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.memes_balance_season4 = ${OWNERS_METRICS_TABLE}2.memes_balance_season4) AS dense_rank_balance_memes_season4__ties,
    dense_table.dense_rank_balance_memes_season5,
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.memes_balance_season5 = ${OWNERS_METRICS_TABLE}2.memes_balance_season5) AS dense_rank_balance_memes_season5__ties, 
    dense_table.dense_rank_balance_memes_season6,
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.memes_balance_season6 = ${OWNERS_METRICS_TABLE}2.memes_balance_season6) AS dense_rank_balance_memes_season6__ties, 
    dense_table.dense_rank_balance_gradients,
    (SELECT COUNT(*) FROM ${OWNERS_METRICS_TABLE} ${OWNERS_METRICS_TABLE}2 WHERE ${OWNERS_METRICS_TABLE}.gradients_balance = ${OWNERS_METRICS_TABLE}2.gradients_balance) AS dense_rank_balance_gradients__ties,
    dense_table.dense_rank_unique_memes,
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes = ${OWNERS_TAGS_TABLE}2.unique_memes) AS dense_rank_unique_memes__ties,
    dense_table.dense_rank_unique_memes_season1,
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes_szn1 = ${OWNERS_TAGS_TABLE}2.unique_memes_szn1) AS dense_rank_unique_memes_season1__ties,
    dense_table.dense_rank_unique_memes_season2,
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes_szn2 = ${OWNERS_TAGS_TABLE}2.unique_memes_szn2) AS dense_rank_unique_memes_season2__ties,
    dense_table.dense_rank_unique_memes_season3,
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes_szn3 = ${OWNERS_TAGS_TABLE}2.unique_memes_szn3) AS dense_rank_unique_memes_season3__ties,
    dense_table.dense_rank_unique_memes_season4,
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes_szn4 = ${OWNERS_TAGS_TABLE}2.unique_memes_szn4) AS dense_rank_unique_memes_season4__ties,
    dense_table.dense_rank_unique_memes_season5,
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes_szn5 = ${OWNERS_TAGS_TABLE}2.unique_memes_szn5) AS dense_rank_unique_memes_season5__ties,
    dense_table.dense_rank_unique_memes_season6,
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes_szn6 = ${OWNERS_TAGS_TABLE}2.unique_memes_szn6) AS dense_rank_unique_memes_season6__ties `;
  }

  const walletsTdhTableSelect = `
    ${WALLETS_TDH_TABLE}.tdh_rank, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn1, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn2, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn3, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn4, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn5,
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn6, 
    ${WALLETS_TDH_TABLE}.tdh_rank_gradients, 
    ${WALLETS_TDH_TABLE}.boost, 
    ${WALLETS_TDH_TABLE}.boosted_tdh, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season1, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season2, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season3, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season4, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season5,
     ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season6,
    ${WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${WALLETS_TDH_TABLE}.tdh__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season1__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season2__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season3__raw,
    ${WALLETS_TDH_TABLE}.memes_tdh_season4__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season5__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season6__raw, 
    ${WALLETS_TDH_TABLE}.gradients_tdh__raw, 
    ${WALLETS_TDH_TABLE}.tdh, 
    ${WALLETS_TDH_TABLE}.memes_tdh, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season1, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season2, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season3, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season4, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season5, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season6, 
    ${WALLETS_TDH_TABLE}.gradients_tdh,
    ${WALLETS_TDH_TABLE}.memes,
    ${WALLETS_TDH_TABLE}.memes_ranks, 
    ${WALLETS_TDH_TABLE}.gradients, 
    ${WALLETS_TDH_TABLE}.gradients_ranks`;

  const fields = ` ${ownerMetricsSelect},${ENS_TABLE}.display as wallet_display, ${walletsTdhTableSelect} , ${OWNERS_TAGS_TABLE}.* `;
  let joins = ` LEFT JOIN ${WALLETS_TDH_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${OWNERS_METRICS_TABLE}.wallet and ${WALLETS_TDH_TABLE}.block=${tdhBlock}`;
  joins += ` LEFT JOIN ${OWNERS_TAGS_TABLE} ON ${OWNERS_METRICS_TABLE}.wallet=${OWNERS_TAGS_TABLE}.wallet `;
  joins += ` LEFT JOIN ${ENS_TABLE} ON ${OWNERS_METRICS_TABLE}.wallet=${ENS_TABLE}.wallet `;

  if (
    sort == 'balance' ||
    sort == 'memes_balance' ||
    sort == 'memes_balance_season1' ||
    sort == 'memes_balance_season2' ||
    sort == 'memes_balance_season3' ||
    sort == 'memes_balance_season4' ||
    sort == 'memes_balance_season5' ||
    sort == 'memes_balance_season6' ||
    sort == 'gradients_balance'
  ) {
    sort = `${OWNERS_METRICS_TABLE}.${sort}`;
  }
  if (
    sort == 'memes_cards_sets' ||
    sort == 'memes_cards_sets_szn1' ||
    sort == 'memes_cards_sets_szn2' ||
    sort == 'memes_cards_sets_szn3' ||
    sort == 'memes_cards_sets_szn4' ||
    sort == 'memes_cards_sets_szn5' ||
    sort == 'memes_cards_sets_szn6' ||
    sort == 'memes_cards_sets_minus1' ||
    sort == 'genesis' ||
    sort == 'unique_memes' ||
    sort == 'unique_memes_szn1' ||
    sort == 'unique_memes_szn2' ||
    sort == 'unique_memes_szn3' ||
    sort == 'unique_memes_szn4' ||
    sort == 'unique_memes_szn5' ||
    sort == 'unique_memes_szn6'
  ) {
    sort = `${OWNERS_TAGS_TABLE}.${sort}`;
  }

  if (wallets) {
    joins += ` JOIN (
      SELECT ${OWNERS_METRICS_TABLE}.wallet, RANK() OVER(ORDER BY ${sort} DESC) AS dense_rank_sort, 
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes+${OWNERS_TAGS_TABLE}.gradients_balance DESC) AS dense_rank_unique,
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.balance DESC) AS dense_rank_balance, 
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance DESC) AS dense_rank_balance_memes, 
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season1 DESC) AS dense_rank_balance_memes_season1, 
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season2 DESC) AS dense_rank_balance_memes_season2, 
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season3 DESC) AS dense_rank_balance_memes_season3, 
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season4 DESC) AS dense_rank_balance_memes_season4, 
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season5 DESC) AS dense_rank_balance_memes_season5, 
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.memes_balance_season6 DESC) AS dense_rank_balance_memes_season6, 
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients, 
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes DESC) AS dense_rank_unique_memes,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn1 DESC) AS dense_rank_unique_memes_season1,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn2 DESC) AS dense_rank_unique_memes_season2,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn3 DESC) AS dense_rank_unique_memes_season3,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn4 DESC) AS dense_rank_unique_memes_season4,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn5 DESC) AS dense_rank_unique_memes_season5,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn6 DESC) AS dense_rank_unique_memes_season6  
      FROM ${OWNERS_METRICS_TABLE} LEFT JOIN ${WALLETS_TDH_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${OWNERS_METRICS_TABLE}.wallet and ${WALLETS_TDH_TABLE}.block=${tdhBlock} LEFT JOIN ${OWNERS_TAGS_TABLE} ON ${OWNERS_METRICS_TABLE}.wallet=${OWNERS_TAGS_TABLE}.wallet ${hideWalletFilters}) as dense_table ON ${OWNERS_METRICS_TABLE}.wallet = dense_table.wallet `;
  }

  const results = await fetchPaginated(
    OWNERS_METRICS_TABLE,
    params,
    `${sort} ${sortDir}, ${OWNERS_METRICS_TABLE}.balance ${sortDir}, boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );

  if (results.data.length == 0 && wallets && profilePage) {
    const resolvedWallets = await resolveEns(wallets);
    if (resolvedWallets.length > 0) {
      const sql = getProfilePageSql(resolvedWallets);
      let results2 = await sqlExecutor.execute(sql.sql, sql.params);
      results2 = await enhanceDataWithHandlesAndLevel(results2);
      return {
        count: results2.length,
        page: 1,
        next: null,
        data: results2
      };
    }
  }
  results.data = await enhanceDataWithHandlesAndLevel(results.data);
  return results;
}

export async function fetchConsolidatedOwnerMetricsForKey(
  consolidationkey: string
) {
  const filters = constructFilters(
    '',
    `${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key = :consolidation_key`
  );
  const params = {
    consolidation_key: consolidationkey
  };

  const ownerMetricsSelect = ` ${CONSOLIDATED_OWNERS_METRICS_TABLE}.*, 
    dense_table.dense_rank_balance,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.balance) AS dense_rank_balance__ties,
    dense_table.dense_rank_unique,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes+${CONSOLIDATED_OWNERS_TAGS_TABLE}.gradients_balance = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes+${CONSOLIDATED_OWNERS_TAGS_TABLE}2.gradients_balance) AS dense_rank_unique__ties,
    dense_table.dense_rank_balance_memes, 
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance) AS dense_rank_balance_memes__ties,
    dense_table.dense_rank_balance_memes_season1,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season1 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season1) AS dense_rank_balance_memes_season1__ties, 
    dense_table.dense_rank_balance_memes_season2,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season2 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season2) AS dense_rank_balance_memes_season2__ties,
    dense_table.dense_rank_balance_memes_season3,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season3 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season3) AS dense_rank_balance_memes_season3__ties, 
    dense_table.dense_rank_balance_memes_season4,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season4 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season4) AS dense_rank_balance_memes_season4__ties,
    dense_table.dense_rank_balance_memes_season5,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season5 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season5) AS dense_rank_balance_memes_season5__ties,
    dense_table.dense_rank_balance_memes_season6,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season6 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season6) AS dense_rank_balance_memes_season6__ties, 
    dense_table.dense_rank_balance_gradients,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.gradients_balance = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.gradients_balance) AS dense_rank_balance_gradients__ties,
    dense_table.dense_rank_unique_memes,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes) AS dense_rank_unique_memes__ties,
    dense_table.dense_rank_unique_memes_season1,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn1 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn1) AS dense_rank_unique_memes_season1__ties,
    dense_table.dense_rank_unique_memes_season2,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn2 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn2) AS dense_rank_unique_memes_season2__ties,
    dense_table.dense_rank_unique_memes_season3,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn3 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn3) AS dense_rank_unique_memes_season3__ties,
    dense_table.dense_rank_unique_memes_season4,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn4 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn4) AS dense_rank_unique_memes_season4__ties,
    dense_table.dense_rank_unique_memes_season5,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn5 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn5) AS dense_rank_unique_memes_season5__ties,
    dense_table.dense_rank_unique_memes_season6,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn6 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn6) AS dense_rank_unique_memes_season6__ties `;

  const walletsTdhTableSelect = `
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn5,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn6, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_gradients, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boost, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season3,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season5, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season6,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season5__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season6__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season5, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season6,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_ranks, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_ranks,
    COALESCE(${TDH_HISTORY_TABLE}.net_boosted_tdh, 0) as day_change,
    COALESCE(${TDH_HISTORY_TABLE}.net_tdh, 0) as day_change_unboosted`;

  const fields = ` ${ownerMetricsSelect}, ${walletsTdhTableSelect} , ${CONSOLIDATED_OWNERS_TAGS_TABLE}.* `;
  let joins = ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_key `;

  const tdhHistoryBlock = await fetchLatestTDHHistoryBlockNumber();
  joins += ` LEFT JOIN ${TDH_HISTORY_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${TDH_HISTORY_TABLE}.consolidation_key and ${TDH_HISTORY_TABLE}.block=${tdhHistoryBlock} `;

  joins += ` JOIN (
      SELECT ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes+${CONSOLIDATED_OWNERS_TAGS_TABLE}.gradients_balance DESC) AS dense_rank_unique,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance DESC) AS dense_rank_balance, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance DESC) AS dense_rank_balance_memes, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season1 DESC) AS dense_rank_balance_memes_season1, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season2 DESC) AS dense_rank_balance_memes_season2, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season3 DESC) AS dense_rank_balance_memes_season3, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season4 DESC) AS dense_rank_balance_memes_season4, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season5 DESC) AS dense_rank_balance_memes_season5, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season6 DESC) AS dense_rank_balance_memes_season6,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes DESC) AS dense_rank_unique_memes,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn1 DESC) AS dense_rank_unique_memes_season1,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn2 DESC) AS dense_rank_unique_memes_season2,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn3 DESC) AS dense_rank_unique_memes_season3,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn4 DESC) AS dense_rank_unique_memes_season4,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn5 DESC) AS dense_rank_unique_memes_season5,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn6 DESC) AS dense_rank_unique_memes_season6 
      FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} 
        LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_key) 
      AS dense_table ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key = dense_table.consolidation_key `;

  const results = await fetchPaginated(
    CONSOLIDATED_OWNERS_METRICS_TABLE,
    params,
    `boosted_tdh ASC`,
    1,
    1,
    filters,
    fields,
    joins
  );

  if (results.data.length == 0) {
    const resolvedWallets = consolidationkey.split('-');
    const sql = getProfilePageSql(resolvedWallets);
    const results2 = await sqlExecutor.execute(sql.sql, sql.params);
    if (results2.length == 1) {
      const r = results2[0];
      r.consolidation_key = consolidationkey;
      r.wallets = consolidationkey.split('-');
      return r;
    } else {
      return null;
    }
  }

  if (results.data.length == 1) {
    return results.data[0];
  } else {
    return null;
  }
}

async function enhanceDataWithHandlesAndLevel(
  data: { wallets?: string; wallet?: string; boostedTdh?: number }[]
) {
  const resultWallets: string[] = distinct(
    data
      .map((d: { wallets?: string; wallet?: string }) =>
        d.wallet ? [d.wallet] : d.wallets ? JSON.parse(d.wallets) : []
      )
      .flat()
  );
  const walletsToHandlesAndIds =
    await profilesService.getProfileIdsAndHandlesByPrimaryWallets(
      resultWallets
    );
  const profileIds = Object.values(walletsToHandlesAndIds).map((it) => it.id);
  const profileReps = await repService.getRepForProfiles(profileIds);
  return data.map(
    (d: { wallets?: string; wallet?: string; boosted_tdh?: number }) => {
      const parsedWallets = d.wallet
        ? [d.wallet]
        : d.wallets
        ? JSON.parse(d.wallets)
        : [];
      const resolvedWallet = parsedWallets.find(
        (w: string) => walletsToHandlesAndIds[w.toLowerCase()]
      );
      (d as any).level = calculateLevel({
        tdh: d.boosted_tdh ?? 0,
        rep: !resolvedWallet
          ? 0
          : profileReps[
              walletsToHandlesAndIds[resolvedWallet.toLowerCase()]?.id
            ] ?? 0
      });
      if (!resolvedWallet) {
        return d;
      }
      return {
        ...d,
        handle: walletsToHandlesAndIds[resolvedWallet.toLowerCase()]?.handle
      };
    }
  );
}

export async function fetchConsolidatedOwnerMetrics(
  pageSize: number,
  page: number,
  wallets: string,
  sort: string,
  sortDir: string,
  metrics_filter: string,
  hideMuseum: boolean,
  hideTeam: boolean,
  profilePage: boolean,
  includePrimaryWallet: boolean
) {
  let filters = '';
  let hideWalletFilters = '';
  const params: any = {};
  if (hideMuseum) {
    filters = constructFilters(
      filters,
      `LOWER(${CONSOLIDATED_OWNERS_METRICS_TABLE}.wallets) NOT LIKE :museum`
    );
    params.museum = `%${SIX529_MUSEUM.toLowerCase()}%`;
  }
  if (hideTeam) {
    const team: string[] = await getTeamWallets();
    team.forEach((t, index) => {
      const paramName = `team${index}`;
      filters = constructFilters(
        filters,
        `LOWER(${CONSOLIDATED_OWNERS_METRICS_TABLE}.wallets) NOT LIKE :${paramName}`
      );
      params[paramName] = `%${t.toLowerCase()}%`;
    });
  }
  hideWalletFilters = filters;
  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    let walletFilters = '';
    resolvedWallets.forEach((w, index) => {
      const paramName = `wallet${index}`;
      walletFilters = constructFiltersOR(
        walletFilters,
        `LOWER(${CONSOLIDATED_OWNERS_METRICS_TABLE}.wallets) LIKE :${paramName}`
      );
      params[paramName] = `%${w.toLowerCase()}%`;
    });
    filters = constructFilters(filters, `(${walletFilters})`);
  }
  if (metrics_filter) {
    switch (metrics_filter) {
      case 'memes':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_balance > 0`
        );
        break;
      case 'memes_set':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_cards_sets > 0`
        );
        break;
      case 'memes_genesis':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.genesis > 0`
        );
        break;
      case 'gradients':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.gradients_balance > 0`
        );
        break;
      case 'memes_set_minus1':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_cards_sets_minus1 > 0`
        );
        break;
      case 'memes_set_szn1':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_cards_sets_szn1 > 0`
        );
        break;
      case 'memes_set_szn2':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_cards_sets_szn2 > 0`
        );
        break;
      case 'memes_set_szn3':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_cards_sets_szn3 > 0`
        );
        break;
      case 'memes_set_szn4':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_cards_sets_szn4 > 0`
        );
        break;
      case 'memes_set_szn5':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_cards_sets_szn5 > 0`
        );
        break;
      case 'memes_set_szn6':
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_TAGS_TABLE}.memes_cards_sets_szn6 > 0`
        );
        break;
    }
  }

  let ownerMetricsSelect: string;

  if (!wallets) {
    ownerMetricsSelect = ` ${CONSOLIDATED_OWNERS_METRICS_TABLE}.*, 
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance DESC) AS dense_rank_balance,
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance DESC) AS dense_rank_balance_memes, 
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season1 DESC) AS dense_rank_balance_memes_season1, 
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season2 DESC) AS dense_rank_balance_memes_season2,
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season3 DESC) AS dense_rank_balance_memes_season3, 
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season4 DESC) AS dense_rank_balance_memes_season4, 
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season5 DESC) AS dense_rank_balance_memes_season5,
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season6 DESC) AS dense_rank_balance_memes_season6, 
    RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients`;
  } else {
    ownerMetricsSelect = ` ${CONSOLIDATED_OWNERS_METRICS_TABLE}.*, 
    dense_table.dense_rank_sort,
    dense_table.dense_rank_balance,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.balance) AS dense_rank_balance__ties,
    dense_table.dense_rank_unique,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes+${CONSOLIDATED_OWNERS_TAGS_TABLE}.gradients_balance = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes+${CONSOLIDATED_OWNERS_TAGS_TABLE}2.gradients_balance) AS dense_rank_unique__ties,
    dense_table.dense_rank_balance_memes, 
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance) AS dense_rank_balance_memes__ties,
    dense_table.dense_rank_balance_memes_season1,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season1 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season1) AS dense_rank_balance_memes_season1__ties, 
    dense_table.dense_rank_balance_memes_season2,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season2 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season2) AS dense_rank_balance_memes_season2__ties,
    dense_table.dense_rank_balance_memes_season3,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season3 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season3) AS dense_rank_balance_memes_season3__ties, 
    dense_table.dense_rank_balance_memes_season4,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season4 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season4) AS dense_rank_balance_memes_season4__ties, 
    dense_table.dense_rank_balance_memes_season5,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season5 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season5) AS dense_rank_balance_memes_season5__ties, 
    dense_table.dense_rank_balance_memes_season6,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season6 = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.memes_balance_season6) AS dense_rank_balance_memes_season6__ties,
    dense_table.dense_rank_balance_gradients,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} ${CONSOLIDATED_OWNERS_METRICS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_METRICS_TABLE}.gradients_balance = ${CONSOLIDATED_OWNERS_METRICS_TABLE}2.gradients_balance) AS dense_rank_balance_gradients__ties,
    dense_table.dense_rank_unique_memes,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes) AS dense_rank_unique_memes__ties,
    dense_table.dense_rank_unique_memes_season1,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn1 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn1) AS dense_rank_unique_memes_season1__ties,
    dense_table.dense_rank_unique_memes_season2,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn2 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn2) AS dense_rank_unique_memes_season2__ties,
    dense_table.dense_rank_unique_memes_season3,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn3 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn3) AS dense_rank_unique_memes_season3__ties,
    dense_table.dense_rank_unique_memes_season4,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn4 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn4) AS dense_rank_unique_memes_season4__ties,
    dense_table.dense_rank_unique_memes_season5,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn5 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn5) AS dense_rank_unique_memes_season5__ties,
    dense_table.dense_rank_unique_memes_season6,
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn6 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn6) AS dense_rank_unique_memes_season6__ties `;
  }

  const walletsTdhTableSelect = `
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn5,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn6, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_gradients, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boost, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season3,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season5, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season6,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season5__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season6__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season5,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season6, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_ranks, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_ranks,
    COALESCE(${TDH_HISTORY_TABLE}.net_boosted_tdh, 0) as day_change,
    COALESCE(${TDH_HISTORY_TABLE}.net_tdh, 0) as day_change_unboosted`;

  const fields = ` ${ownerMetricsSelect}, ${walletsTdhTableSelect} , ${CONSOLIDATED_OWNERS_TAGS_TABLE}.* `;
  let joins = ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_key `;

  const tdhHistoryBlock = await fetchLatestTDHHistoryBlockNumber();
  joins += ` LEFT JOIN ${TDH_HISTORY_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${TDH_HISTORY_TABLE}.consolidation_key and ${TDH_HISTORY_TABLE}.block=${tdhHistoryBlock} `;

  if (
    sort == 'balance' ||
    sort == 'memes_balance' ||
    sort == 'memes_balance_season1' ||
    sort == 'memes_balance_season2' ||
    sort == 'memes_balance_season3' ||
    sort == 'memes_balance_season4' ||
    sort == 'memes_balance_season5' ||
    sort == 'memes_balance_season6' ||
    sort == 'gradients_balance'
  ) {
    sort = `${CONSOLIDATED_OWNERS_METRICS_TABLE}.${sort}`;
  }
  if (
    sort == 'memes_cards_sets' ||
    sort == 'memes_cards_sets_szn1' ||
    sort == 'memes_cards_sets_szn2' ||
    sort == 'memes_cards_sets_szn3' ||
    sort == 'memes_cards_sets_szn4' ||
    sort == 'memes_cards_sets_szn5' ||
    sort == 'memes_cards_sets_szn6' ||
    sort == 'memes_cards_sets_minus1' ||
    sort == 'genesis' ||
    sort == 'unique_memes' ||
    sort == 'unique_memes_szn1' ||
    sort == 'unique_memes_szn2' ||
    sort == 'unique_memes_szn3' ||
    sort == 'unique_memes_szn4' ||
    sort == 'unique_memes_szn5' ||
    sort == 'unique_memes_szn6'
  ) {
    sort = `${CONSOLIDATED_OWNERS_TAGS_TABLE}.${sort}`;
  }

  if (wallets) {
    joins += ` JOIN (
      SELECT ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key, RANK() OVER(ORDER BY ${sort} DESC) AS dense_rank_sort, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes+${CONSOLIDATED_OWNERS_TAGS_TABLE}.gradients_balance DESC) AS dense_rank_unique,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance DESC) AS dense_rank_balance, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance DESC) AS dense_rank_balance_memes, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season1 DESC) AS dense_rank_balance_memes_season1, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season2 DESC) AS dense_rank_balance_memes_season2, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season3 DESC) AS dense_rank_balance_memes_season3, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season4 DESC) AS dense_rank_balance_memes_season4, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season5 DESC) AS dense_rank_balance_memes_season5, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season6 DESC) AS dense_rank_balance_memes_season6,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes DESC) AS dense_rank_unique_memes,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn1 DESC) AS dense_rank_unique_memes_season1,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn2 DESC) AS dense_rank_unique_memes_season2,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn3 DESC) AS dense_rank_unique_memes_season3,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn4 DESC) AS dense_rank_unique_memes_season4,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn5 DESC) AS dense_rank_unique_memes_season5,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn6 DESC) AS dense_rank_unique_memes_season6 
      FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} 
        LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_key ${hideWalletFilters}) 
      AS dense_table ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key = dense_table.consolidation_key `;
  }

  const results = await fetchPaginated(
    CONSOLIDATED_OWNERS_METRICS_TABLE,
    params,
    `${sort} ${sortDir}, ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance ${sortDir}, boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );

  if (results.data.length == 0 && wallets && profilePage) {
    const resolvedWallets = await resolveEns(wallets);
    if (resolvedWallets.length > 0) {
      const sql = getProfilePageSql(resolvedWallets);
      let results2 = await sqlExecutor.execute(sql.sql, sql.params);
      results2[0].wallets = resolvedWallets;
      results2 = await enhanceDataWithHandlesAndLevel(results2);
      return {
        count: results2.length,
        page: 1,
        next: null,
        data: results2
      };
    }
  }

  if (includePrimaryWallet) {
    await Promise.all(
      results.data.map(async (d: any) => {
        d.primary_wallet = await fetchPrimaryWallet(JSON.parse(d.wallets));
      })
    );
  }
  results.data = await enhanceDataWithHandlesAndLevel(results.data);

  return results;
}
function returnEmpty() {
  return {
    count: 0,
    page: 0,
    next: null,
    data: []
  };
}

export async function fetchEns(address: string) {
  const sql = `SELECT * FROM ${ENS_TABLE} WHERE LOWER(wallet)=LOWER(:address) OR LOWER(display)=LOWER(:address)`;
  return sqlExecutor.execute(sql, { address: address });
}

export async function fetchUser(address: string) {
  const sql = `SELECT 
      ${ENS_TABLE}.*, 
      ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key,
      ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance, 
      ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh, 
      ${USER_TABLE}.pfp, ${USER_TABLE}.banner_1, ${USER_TABLE}.banner_2, ${USER_TABLE}.website 
    FROM ${ENS_TABLE} 
    LEFT JOIN ${CONSOLIDATED_OWNERS_METRICS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key LIKE CONCAT('%', ${ENS_TABLE}.wallet, '%') 
    LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key 
    LEFT JOIN ${USER_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key LIKE CONCAT('%', ${USER_TABLE}.wallet, '%') 
    WHERE LOWER(${ENS_TABLE}.wallet)=LOWER(:address) OR LOWER(display)=LOWER(:address) ORDER BY ${USER_TABLE}.updated_at desc limit 1`;
  return sqlExecutor.execute(sql, { address: address });
}

export async function fetchRanksForWallet(address: string) {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  const sqlTdh = `SELECT * FROM ${WALLETS_TDH_TABLE} WHERE block=${tdhBlock} and wallet=:address`;
  const ownerTdh = await sqlExecutor.execute(sqlTdh, { address: address });

  return ownerTdh;
}

export async function fetchLabExtended(
  pageSize: number,
  page: number,
  nfts: string,
  collections: string
) {
  let filters = '';
  const params: any = {};

  if (nfts) {
    filters = constructFilters(filters, `id in (:nfts)`);
    params.nfts = nfts.split(',');
  }
  if (collections) {
    filters = constructFilters(
      filters,
      `metadata_collection in (:collections)`
    );
    params.collections = collections.split(',');
  }
  return fetchPaginated(
    LAB_EXTENDED_DATA_TABLE,
    params,
    'id',
    pageSize,
    page,
    filters
  );
}

export async function fetchDistributionPhotos(
  contract: string,
  cardId: number,
  pageSize: number,
  page: number
) {
  let filters = constructFilters('', `contract = :contract`);
  filters = constructFilters(filters, `card_id = :card_id`);
  const params = {
    contract: contract,
    card_id: cardId
  };

  return fetchPaginated(
    DISTRIBUTION_PHOTO_TABLE,
    params,
    `link asc`,
    pageSize,
    page,
    filters,
    ``,
    ``
  );
}

export async function fetchDistributionPhases(
  contract: string,
  cardId: number
) {
  const sql = `SELECT DISTINCT phase FROM ${DISTRIBUTION_TABLE} WHERE contract=:contract AND card_id=:card_id ORDER BY phase ASC`;
  const results = await sqlExecutor.execute(sql, {
    contract: contract,
    card_id: cardId
  });
  const phases = results.map((r: any) => r.phase);

  return {
    count: phases.length,
    page: 1,
    next: null,
    data: phases
  };
}

export async function fetchDistributionForNFT(
  contract: string,
  cardId: number,
  wallets: string,
  phases: string,
  pageSize: number,
  page: number,
  sort: string,
  sortDir: string
) {
  const params: any = {};
  let filters = constructFilters(
    '',
    `${DISTRIBUTION_TABLE}.contract = :contract`
  );
  params.contract = contract;

  filters = constructFilters(filters, `card_id = :card_id`);
  params.card_id = cardId;

  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    if (resolvedWallets.length == 0) {
      return returnEmpty();
    }
    filters += ` AND ${DISTRIBUTION_TABLE}.wallet in (:wallets)`;
    params.wallets = resolvedWallets;
  }
  if (phases) {
    filters = constructFilters(filters, `phase in (:phase)`);
    params.phase = phases.split(',');
  }

  let joins = ` LEFT JOIN ${ENS_TABLE} ON ${DISTRIBUTION_TABLE}.wallet=${ENS_TABLE}.wallet `;

  let transactionsTable = TRANSACTIONS_TABLE;
  if (areEqualAddresses(contract, MEMELAB_CONTRACT)) {
    transactionsTable = TRANSACTIONS_MEME_LAB_TABLE;
  }

  joins += ` LEFT JOIN ${transactionsTable} ON ${DISTRIBUTION_TABLE}.contract = ${transactionsTable}.contract AND ${DISTRIBUTION_TABLE}.card_id = ${transactionsTable}.token_id AND (${transactionsTable}.from_address=${mysql.escape(
    MANIFOLD
  )} OR ${transactionsTable}.from_address=${mysql.escape(
    NULL_ADDRESS
  )}) AND ${DISTRIBUTION_TABLE}.wallet=${transactionsTable}.to_address and value > 0`;

  return fetchPaginated(
    DISTRIBUTION_TABLE,
    params,
    `${sort} ${
      sort == 'phase' ? (sortDir == 'asc' ? 'desc' : 'asc') : sortDir
    }, phase ${
      sortDir == 'asc' ? 'desc' : 'asc'
    }, count ${sortDir}, wallet_balance ${sortDir}, wallet_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    `${DISTRIBUTION_TABLE}.*, ${ENS_TABLE}.display, SUM(${transactionsTable}.token_count) as card_mint_count`,
    joins,
    `${DISTRIBUTION_TABLE}.wallet, ${DISTRIBUTION_TABLE}.created_at, ${DISTRIBUTION_TABLE}.phase, ${ENS_TABLE}.display`
  );
}

export async function fetchDistributions(
  wallets: string,
  cards: string,
  contracts: string,
  pageSize: number,
  page: number
) {
  if (!wallets && !cards && !contracts) {
    return returnEmpty();
  }

  let filters = '';
  const params: any = {};

  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    if (resolvedWallets.length == 0) {
      return returnEmpty();
    }
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_TABLE}.wallet in (:wallets)`
    );
    params.wallets = resolvedWallets;
  }
  if (cards) {
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_TABLE}.card_id in (:cards)`
    );
    params.cards = cards.split(',');
  }
  if (contracts) {
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_TABLE}.contract in (:contracts)`
    );
    params.contracts = contracts.split(',');
  }

  let joins = `LEFT JOIN ${NFTS_TABLE} ON ${DISTRIBUTION_TABLE}.card_id=${NFTS_TABLE}.id AND ${DISTRIBUTION_TABLE}.contract=${NFTS_TABLE}.contract`;
  joins += ` LEFT JOIN ${NFTS_MEME_LAB_TABLE} ON ${DISTRIBUTION_TABLE}.card_id=${NFTS_MEME_LAB_TABLE}.id AND ${DISTRIBUTION_TABLE}.contract=${NFTS_MEME_LAB_TABLE}.contract`;
  joins += ` LEFT JOIN ${TRANSACTIONS_TABLE} ON ${DISTRIBUTION_TABLE}.contract = ${TRANSACTIONS_TABLE}.contract AND ${DISTRIBUTION_TABLE}.card_id = ${TRANSACTIONS_TABLE}.token_id AND (${TRANSACTIONS_TABLE}.from_address=${mysql.escape(
    MANIFOLD
  )} OR ${TRANSACTIONS_TABLE}.from_address=${mysql.escape(
    NULL_ADDRESS
  )}) AND ${DISTRIBUTION_TABLE}.wallet=${TRANSACTIONS_TABLE}.to_address AND ${TRANSACTIONS_TABLE}.value > 0`;
  joins += ` LEFT JOIN ${TRANSACTIONS_MEME_LAB_TABLE} ON ${DISTRIBUTION_TABLE}.contract = ${TRANSACTIONS_MEME_LAB_TABLE}.contract AND ${DISTRIBUTION_TABLE}.card_id = ${TRANSACTIONS_MEME_LAB_TABLE}.token_id AND (${TRANSACTIONS_MEME_LAB_TABLE}.from_address=${mysql.escape(
    MANIFOLD
  )} OR ${TRANSACTIONS_MEME_LAB_TABLE}.from_address=${mysql.escape(
    NULL_ADDRESS
  )}) AND ${DISTRIBUTION_TABLE}.wallet=${TRANSACTIONS_MEME_LAB_TABLE}.to_address AND ${TRANSACTIONS_MEME_LAB_TABLE}.value > 0`;
  joins += ` LEFT JOIN ${ENS_TABLE} ON ${DISTRIBUTION_TABLE}.wallet=${ENS_TABLE}.wallet `;

  return fetchPaginated(
    `(
        SELECT wallet, contract, card_id,
        SUM(CASE WHEN phase = 'Airdrop' THEN count ELSE 0 END) AS airdrop,
        SUM(CASE WHEN phase = 'Allowlist' THEN count ELSE 0 END) AS allowlist,
        SUM(CASE WHEN phase = 'Phase0' THEN count ELSE 0 END) AS phase_0,
        SUM(CASE WHEN phase = 'Phase1' THEN count ELSE 0 END) AS phase_1,
        SUM(CASE WHEN phase = 'Phase2' THEN count ELSE 0 END) AS phase_2,
        SUM(CASE WHEN phase = 'Phase3' THEN count ELSE 0 END) AS phase_3
        from distribution ${filters} GROUP BY wallet, contract, card_id
    ) as ${DISTRIBUTION_TABLE}`,
    params,
    `card_mint_date desc, allowlist desc, airdrop desc, phase_0 desc, phase_1 desc, phase_2 desc, phase_3 desc`,
    pageSize,
    page,
    filters,
    `${DISTRIBUTION_TABLE}.wallet,
    ${ENS_TABLE}.display,
    ${DISTRIBUTION_TABLE}.contract,
    ${DISTRIBUTION_TABLE}.card_id,
    COALESCE(SUM(${TRANSACTIONS_TABLE}.token_count), SUM(${TRANSACTIONS_MEME_LAB_TABLE}.token_count), 0) AS total_minted,
    COALESCE(${NFTS_TABLE}.name, ${NFTS_MEME_LAB_TABLE}.name) as card_name,
    COALESCE(${NFTS_TABLE}.mint_date, ${NFTS_MEME_LAB_TABLE}.mint_date, now()) AS card_mint_date,
    ${DISTRIBUTION_TABLE}.airdrop,
    ${DISTRIBUTION_TABLE}.allowlist,
    ${DISTRIBUTION_TABLE}.phase_0,
    ${DISTRIBUTION_TABLE}.phase_1,
    ${DISTRIBUTION_TABLE}.phase_2,
    ${DISTRIBUTION_TABLE}.phase_3`,
    joins,
    `${DISTRIBUTION_TABLE}.wallet, ${DISTRIBUTION_TABLE}.contract, ${DISTRIBUTION_TABLE}.card_id`
  );
}

export async function fetchConsolidationsForWallet(
  wallet: string,
  showIncomplete: boolean
) {
  if (!showIncomplete) {
    const sql = getConsolidationsSql();
    const consolidations: any[] = await sqlExecutor.execute(sql, {
      wallet: wallet
    });
    const wallets = extractConsolidationWallets(consolidations, wallet);
    return {
      count: wallets.length,
      page: 1,
      next: null,
      data: wallets
    };
  } else {
    let sql = `SELECT ${CONSOLIDATIONS_TABLE}.*, e1.display as wallet1_display, e2.display as wallet2_display FROM ${CONSOLIDATIONS_TABLE}`;
    sql += ` LEFT JOIN ${ENS_TABLE} e1 ON ${CONSOLIDATIONS_TABLE}.wallet1=e1.wallet`;
    sql += ` LEFT JOIN ${ENS_TABLE} e2 ON ${CONSOLIDATIONS_TABLE}.wallet2=e2.wallet`;
    sql += ` WHERE wallet1=:wallet OR wallet2=:wallet`;

    const results = await sqlExecutor.execute(sql, { wallet: wallet });

    return {
      count: results.length,
      page: 1,
      next: null,
      data: results
    };
  }
}

export async function fetchPrimaryWallet(wallets: string[]) {
  if (!wallets) {
    return null;
  }
  if (wallets.length == 1) {
    return wallets[0];
  }
  const tdhBlock = await fetchLatestTDHBlockNumber();
  const sql = `SELECT wallet from ${WALLETS_TDH_TABLE} where wallet in (:wallets) AND block=:block order by boosted_tdh desc limit 1`;
  const results: any[] = await sqlExecutor.execute(sql, {
    wallets: wallets,
    block: tdhBlock
  });
  if (results[0]) {
    return results[0].wallet;
  } else {
    return null;
  }
}

export async function fetchConsolidations(
  pageSize: number,
  page: number,
  block: string
) {
  let filters = constructFilters('', "wallets like '%, %'");
  const params: any = {};
  if (block) {
    filters = constructFilters(filters, `block <= :block`);
    params.block = block;
  }
  const results = await fetchPaginated(
    CONSOLIDATED_WALLETS_TDH_TABLE,
    params,
    'boosted_tdh desc',
    pageSize,
    page,
    filters,
    'consolidation_display, consolidation_key, wallets'
  );

  await Promise.all(
    results.data.map(async (d: any) => {
      d.primary = await fetchPrimaryWallet(JSON.parse(d.wallets));
    })
  );

  return results;
}

export async function fetchConsolidationTransactions(
  pageSize: number,
  page: number,
  block: string,
  showIncomplete: boolean
) {
  let filters = '';
  const params: any = {};
  if (block) {
    filters = constructFilters('', `block <= :block`);
    params.block = block;
  }
  if (!showIncomplete) {
    filters = constructFilters(filters, `confirmed=1`);
  }
  let joins = `LEFT JOIN ${ENS_TABLE} e1 ON ${CONSOLIDATIONS_TABLE}.wallet1=e1.wallet`;
  joins += ` LEFT JOIN ${ENS_TABLE} e2 ON ${CONSOLIDATIONS_TABLE}.wallet2=e2.wallet`;

  return fetchPaginated(
    CONSOLIDATIONS_TABLE,
    params,
    'block desc',
    pageSize,
    page,
    filters,
    `${CONSOLIDATIONS_TABLE}.*, e1.display as wallet1_display, e2.display as wallet2_display`,
    joins
  );
}

export async function fetchDelegations(
  wallet: string,
  pageSize: number,
  page: number
) {
  const filter = `WHERE from_address = :wallet OR to_address = :wallet`;
  const params = {
    wallet: wallet
  };

  let joins = `LEFT JOIN ${ENS_TABLE} e1 ON ${DELEGATIONS_TABLE}.from_address=e1.wallet`;
  joins += ` LEFT JOIN ${ENS_TABLE} e2 ON ${DELEGATIONS_TABLE}.to_address=e2.wallet`;

  return fetchPaginated(
    DELEGATIONS_TABLE,
    params,
    'block desc',
    pageSize,
    page,
    filter,
    `${DELEGATIONS_TABLE}.*, e1.display as from_display, e2.display as to_display`,
    joins
  );
}

export async function fetchDelegationsByUseCase(
  collections: string,
  useCases: string,
  showExpired: boolean,
  pageSize: number,
  page: number,
  block: string
) {
  let filters = '';
  const params: any = {};

  if (collections) {
    filters = constructFilters(filters, `collection in (:collections)`);
    params.collections = collections.split(',');
  }
  if (!showExpired) {
    filters = constructFilters(filters, `expiry >= :expiry`);
    params.expiry = Date.now() / 1000;
  }
  if (useCases) {
    filters = constructFilters(filters, `use_case in (:use_cases)`);
    params.use_cases = useCases.split(',');
  }
  if (block) {
    filters = constructFilters(filters, `block <= :block`);
    params.block = block;
  }

  return fetchPaginated(
    DELEGATIONS_TABLE,
    params,
    'block desc',
    pageSize,
    page,
    filters,
    '',
    ''
  );
}

export async function fetchNftHistory(
  pageSize: number,
  page: number,
  contract: string,
  nftId: number
) {
  const filter = constructFilters('', `contract=:contract AND nft_id=:nft_id`);
  const params = {
    contract: contract,
    nft_id: nftId
  };

  return fetchPaginated(
    NFTS_HISTORY_TABLE,
    params,
    `transaction_date desc`,
    pageSize,
    page,
    filter
  );
}

export async function fetchNextGenAllowlistCollection(merkleRoot: string) {
  const sql = `SELECT * FROM ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE} LEFT JOIN ${NEXTGEN_BURN_COLLECTIONS_TABLE} ON ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.collection_id=${NEXTGEN_BURN_COLLECTIONS_TABLE}.collection_id WHERE ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.merkle_root=:merkle_root`;
  const collection = (
    await sqlExecutor.execute(sql, {
      merkle_root: merkleRoot
    })
  )[0];
  return collection;
}

export async function fetchNextGenAllowlist(
  merkleRoot: string,
  address: string
) {
  const sql1 = `SELECT * FROM ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE} WHERE merkle_root=:merkle_root`;
  const collection = (
    await sqlExecutor.execute(sql1, {
      merkle_root: merkleRoot
    })
  )[0];

  const sql2 = `SELECT * FROM ${NEXTGEN_ALLOWLIST_TABLE} WHERE merkle_root=:merkle_root AND address=:address`;

  const allowlist = (
    await sqlExecutor.execute(sql2, {
      merkle_root: merkleRoot,
      address: address
    })
  )[0];

  if (collection && allowlist) {
    const proof = getProof(collection.merkle_tree, allowlist.keccak);
    return {
      keccak: allowlist.keccak,
      spots: allowlist.spots,
      info: allowlist.info,
      proof: proof
    };
  }
  return {
    keccak: null,
    spots: -1,
    data: null,
    proof: []
  };
}

export async function fetchNextGenBurnAllowlist(
  merkleRoot: string,
  tokenId: number
) {
  const collection = await fetchNextGenAllowlistCollection(merkleRoot);

  const sql2 = `SELECT * FROM ${NEXTGEN_ALLOWLIST_BURN_TABLE} WHERE merkle_root=:merkle_root AND token_id=:token_id`;
  const allowlist = (
    await sqlExecutor.execute(sql2, {
      merkle_root: merkleRoot,
      token_id: tokenId
    })
  )[0];

  if (collection && allowlist) {
    const proof = getProof(collection.merkle_tree, allowlist.keccak);
    return {
      keccak: allowlist.keccak,
      info: allowlist.info,
      proof: proof
    };
  }
  return {
    keccak: null,
    data: null,
    proof: []
  };
}

export async function fetchRememes(
  memeIds: string,
  pageSize: number,
  page: number,
  contract: string,
  id: string,
  tokenType: string,
  sort: string,
  sortDirection: string
) {
  let filters = '';
  let joins = '';
  let fields = `${REMEMES_TABLE}.*`;
  const params: any = {};

  if (memeIds) {
    memeIds.split(',').forEach((nft_id) => {
      const paramName = `nft_id${nft_id}`;
      filters = constructFilters(
        filters,
        `JSON_CONTAINS(${REMEMES_TABLE}.meme_references, :${paramName},'$')`
      );
      params[paramName] = nft_id;
    });
  }
  if (tokenType) {
    filters = constructFilters(
      filters,
      `${REMEMES_TABLE}.token_type=:token_type`
    );
    params.token_type = tokenType;
  }

  if (contract && id) {
    filters = constructFilters(
      filters,
      `${REMEMES_TABLE}.contract=:contract AND id=:id`
    );
    params.contract = contract;
    params.id = id;
  } else {
    filters = constructFilters(
      filters,
      'first_occurrences.first_id IS NOT NULL'
    );
    joins = `LEFT JOIN (
          SELECT contract, image, MIN(id) AS first_id, meme_references, token_type
          FROM ${REMEMES_TABLE}
          GROUP BY contract, image, meme_references, token_type
      ) AS first_occurrences
      ON ${REMEMES_TABLE}.contract = first_occurrences.contract
        AND ${REMEMES_TABLE}.image = first_occurrences.image
        AND ${REMEMES_TABLE}.id = first_occurrences.first_id
        ${filters}`;
    filters = '';
  }

  fields += `, (SELECT GROUP_CONCAT(id) 
     FROM ${REMEMES_TABLE} r2 
     WHERE r2.contract = ${REMEMES_TABLE}.contract 
       AND r2.image = ${REMEMES_TABLE}.image 
       AND r2.meme_references = ${REMEMES_TABLE}.meme_references
    ) AS replicas`;

  let rememeSort = ` RAND() `;
  if (sort && sortDirection) {
    rememeSort = ` ${sort} ${sortDirection} `;
  }

  return fetchPaginated(
    REMEMES_TABLE,
    params,
    rememeSort,
    pageSize,
    page,
    filters,
    fields,
    joins,
    ''
  );
}

export async function fetchRememesUploads(pageSize: number, page: number) {
  return fetchPaginated(
    REMEMES_UPLOADS,
    {},
    ` created_at desc `,
    pageSize,
    page,
    ''
  );
}

export async function rememeExists(contract: string, token_id: string) {
  const sql = `SELECT * FROM ${REMEMES_TABLE} WHERE contract=:contract AND id=:token_id`;
  const result = await sqlExecutor.execute(sql, {
    contract: contract,
    token_id: token_id
  });
  return result.length > 0;
}

export async function addRememe(by: string, rememe: any) {
  const contract = rememe.contract.address;
  const deployer = rememe.contract.contractDeployer;
  const openseaData = rememe.contract.openSeaMetadata;

  const tokens: Nft[] = rememe.nfts;

  for (const t of tokens) {
    const token_id = t.tokenId;
    const tokenType = t.tokenType;
    const tokenUri = t.tokenUri ? t.tokenUri : t.raw.tokenUri;
    const media = t.image;
    const metadata = t.raw.metadata;
    const image = metadata
      ? metadata.image
        ? metadata.image
        : metadata.image_url
        ? metadata.image_url
        : ''
      : '';

    const animation = metadata
      ? metadata.animation
        ? metadata.animation
        : metadata.animation_url
        ? metadata.animation_url
        : ''
      : '';

    const sql = `INSERT INTO ${REMEMES_TABLE} 
        (contract, id, deployer, token_uri, token_type, image, animation, meme_references, metadata, contract_opensea_data, media, source, added_by) 
        VALUES (:contract, :token_id, :deployer, :tokenUri, :tokenType, :image, :animation, :meme_references, :metadata, :contract_opensea_data, :media, :source, :added_by)`;
    const params = {
      contract: contract,
      token_id: token_id,
      deployer: deployer,
      tokenUri: tokenUri,
      tokenType: tokenType,
      image: image,
      animation: animation,
      meme_references: JSON.stringify(rememe.references),
      metadata: JSON.stringify(metadata),
      contract_opensea_data: JSON.stringify(openseaData),
      media: JSON.stringify(media),
      source: RememeSource.SEIZE,
      added_by: by
    };

    await sqlExecutor.execute(sql, params);
  }
}

export async function getTdhForAddress(address: string) {
  const sql = `SELECT boosted_tdh FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} WHERE LOWER(${CONSOLIDATED_WALLETS_TDH_TABLE}.wallets) LIKE :address`;
  const result = await sqlExecutor.execute(sql, {
    address: `%${address.toLowerCase()}%`
  });
  if (result.length === 0) {
    return 0;
  }
  return result[0].boosted_tdh;
}

export async function fetchTDHGlobalHistory(pageSize: number, page: number) {
  return fetchPaginated(
    TDH_GLOBAL_HISTORY_TABLE,
    {},
    ` date desc `,
    pageSize,
    page,
    ''
  );
}

export async function fetchTDHHistory(
  wallets: string,
  pageSize: number,
  page: number
) {
  let filters = '';
  const params: any = {};
  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    resolvedWallets.forEach((w, index) => {
      const paramName = `wallet${index}`;
      filters = constructFilters(filters, `LOWER(wallets) LIKE :${paramName}`);
      params[paramName] = `%${w.toLowerCase()}%`;
    });
  }

  return fetchPaginated(
    TDH_HISTORY_TABLE,
    params,
    ` date desc, block desc, net_boosted_tdh desc `,
    pageSize,
    page,
    filters
  );
}

export async function updateUser(user: User) {
  const sql = `INSERT INTO ${USER_TABLE} (wallet, pfp, banner_1, banner_2, website) 
    VALUES (:wallet, :pfp, :banner_1, :banner_2, :website) 
    ON DUPLICATE KEY UPDATE 
    pfp = IF(:pfp IS NOT NULL AND LENGTH(:pfp) > 0, :pfp, pfp),
    banner_1 = :banner_1, 
    banner_2 = :banner_2, 
    website = :website`;
  const params = {
    wallet: user.wallet,
    pfp: user.pfp,
    banner_1: user.banner_1,
    banner_2: user.banner_2,
    website: user.website
  };

  await sqlExecutor.execute(sql, params);
}

export async function fetchRoyaltiesUploads(pageSize: number, page: number) {
  return fetchPaginated(
    ROYALTIES_UPLOADS_TABLE,
    {},
    'date desc',
    pageSize,
    page,
    ''
  );
}

export async function fetchNextGenCollections(
  pageSize: number,
  page: number,
  status: NextGenCollectionStatus | null
) {
  let filters = '';
  let sort = 'id desc';
  if (status) {
    const now = Time.now().toSeconds();
    sort = 'allowlist_start asc, public_start asc, id desc';
    switch (status) {
      case NextGenCollectionStatus.LIVE:
        filters = constructFilters(
          filters,
          `(allowlist_start <= ${now} AND allowlist_end >= ${now}) OR (public_start <= ${now} AND public_end >= ${now})`
        );
        sort = 'allowlist_start asc, public_start asc, id desc';
        break;
      case NextGenCollectionStatus.UPCOMING:
        filters = constructFilters(
          filters,
          `allowlist_start > ${now} OR public_start > ${now}`
        );
        break;
      case NextGenCollectionStatus.COMPLETED:
        filters = constructFilters(
          filters,
          `allowlist_end < ${now} AND public_end < ${now}`
        );
        break;
    }
  }
  return fetchPaginated(
    NEXTGEN_COLLECTIONS_TABLE,
    {},
    sort,
    pageSize,
    page,
    filters
  );
}

export async function fetchNextGenCollectionById(id: number) {
  const sql = `SELECT * FROM ${NEXTGEN_COLLECTIONS_TABLE} WHERE id=:id`;
  const results = await sqlExecutor.execute(sql, {
    id: id
  });
  if (results.length === 1) {
    return results[0];
  }
  return returnEmpty();
}

export async function fetchNextGenCollectionTokens(
  collectionId: number,
  pageSize: number,
  page: number
) {
  let filters = constructFilters(
    '',
    `${NEXTGEN_TOKENS_TABLE}.collection_id=:collectionId`
  );
  return fetchPaginated(
    NEXTGEN_TOKENS_TABLE,
    {
      collectionId: collectionId
    },
    'id asc',
    pageSize,
    page,
    filters
  );
}

export async function fetchNextGenToken(tokendId: number) {
  const sql = `SELECT * FROM ${NEXTGEN_TOKENS_TABLE} WHERE id=:id`;
  const results = await sqlExecutor.execute(sql, {
    id: tokendId
  });
  if (results.length === 1) {
    return results[0];
  }
  return returnEmpty();
}

export async function fetchNextGenCollectionLogs(
  collectionId: number,
  pageSize: number,
  page: number
) {
  let filters = constructFilters(
    '',
    `${NEXTGEN_LOGS_TABLE}.collection_id = :collectionId OR ${NEXTGEN_LOGS_TABLE}.collection_id = 0`
  );
  return fetchPaginated(
    NEXTGEN_LOGS_TABLE,
    {
      collectionId: collectionId
    },
    'block desc, log desc',
    pageSize,
    page,
    filters
  );
}

export async function fetchNextGenTokenTransactions(
  tokenId: number,
  pageSize: number,
  page: number
) {
  let filters = constructFilters(
    '',
    `${NEXTGEN_TRANSACTIONS_TABLE}.token_id = :tokenId`
  );

  const fields = `${NEXTGEN_TRANSACTIONS_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON ${NEXTGEN_TRANSACTIONS_TABLE}.from_address=ens1.wallet LEFT JOIN ${ENS_TABLE} ens2 ON ${NEXTGEN_TRANSACTIONS_TABLE}.to_address=ens2.wallet`;

  return fetchPaginated(
    NEXTGEN_TRANSACTIONS_TABLE,
    {
      tokenId: tokenId
    },
    'block desc, transaction_date desc, token_id desc',
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}
