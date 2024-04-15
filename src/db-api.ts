import {
  ARTISTS_TABLE,
  CONSOLIDATED_UPLOADS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  CONSOLIDATIONS_TABLE,
  DELEGATION_ALL_ADDRESS,
  DELEGATIONS_TABLE,
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_PHOTO_TABLE,
  DISTRIBUTION_TABLE,
  ENS_TABLE,
  GRADIENT_CONTRACT,
  LAB_EXTENDED_DATA_TABLE,
  MANIFOLD,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  MEMES_SEASONS_TABLE,
  NFT_OWNERS_TABLE,
  NFTS_HISTORY_TABLE,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  NULL_ADDRESS,
  NULL_ADDRESS_DEAD,
  PROFILE_FULL,
  REMEMES_TABLE,
  REMEMES_UPLOADS,
  ROYALTIES_UPLOADS_TABLE,
  TDH_BLOCKS_TABLE,
  TDH_GLOBAL_HISTORY_TABLE,
  TDH_HISTORY_TABLE,
  TEAM_TABLE,
  TRANSACTIONS_TABLE,
  UPLOADS_TABLE,
  USE_CASE_ALL,
  USE_CASE_MINTING,
  WALLETS_CONSOLIDATION_KEYS_VIEW,
  WALLETS_TDH_TABLE
} from './constants';
import { RememeSource } from './entities/IRememe';
import { areEqualAddresses, extractConsolidationWallets } from './helpers';
import { getConsolidationsSql } from './sql_helpers';
import { ConnectionWrapper, setSqlExecutor, sqlExecutor } from './sql-executor';

import * as mysql from 'mysql';
import { Time } from './time';
import { DbPoolName, DbQueryOptions } from './db-query.options';
import { Logger } from './logging';
import { calculateLevel } from './profiles/profile-level';
import { Nft } from 'alchemy-sdk';
import {
  constructFilters,
  constructFiltersOR,
  getSearchFilters
} from './api-serverless/src/api-helpers';

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
        logger.error(
          `Failed to establish connection to ${poolName} [${JSON.stringify(
            err
          )}]`
        );
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

export async function fetchPaginated(
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
  const groupPart = groups ? ` GROUP BY ${groups}` : '';
  const countSql = `SELECT COUNT(1) as count FROM (SELECT 1 FROM ${table} ${
    joins ?? ''
  } ${filters}${groupPart}) inner_q`;

  let resultsSql = `SELECT ${fields ? fields : '*'} FROM ${table} ${
    joins ? joins : ''
  } ${filters} ${groups ? `group by ${groups}` : ``} order by ${orderBy} ${
    pageSize > 0 ? `LIMIT ${pageSize}` : ``
  }`;
  if (page > 1) {
    const offset = pageSize * (page - 1);
    resultsSql += ` OFFSET ${offset}`;
  }
  logger.debug(`Count sql: '${countSql}`);
  logger.debug(`Data sql: ${resultsSql}`);

  const count = await sqlExecutor
    .execute(countSql, params)
    .then((r) => r[0].count);
  const data = await sqlExecutor.execute(resultsSql, params);
  logger.debug(`Count sql: '${countSql}', Result: ${count}`);
  logger.debug(`Result sql: ${resultsSql}`);
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
  const groupBy = `${NFTS_MEME_LAB_TABLE}.id, ${NFTS_MEME_LAB_TABLE}.contract`;
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
  let filters = constructFilters(
    '',
    `${NFT_OWNERS_TABLE}.contract = :meme_lab_contract`
  );
  const params: any = {
    meme_lab_contract: MEMELAB_CONTRACT
  };
  if (wallets) {
    filters = constructFilters(
      filters,
      `(${NFT_OWNERS_TABLE}.wallet in (:wallets) OR ${ENS_TABLE}.display in (:wallets))`
    );
    params.wallets = wallets.split(',');
  }
  if (nfts) {
    filters = constructFilters(filters, `token_id in (:nfts)`);
    params.nfts = nfts.split(',');
  }

  const fields = ` ${NFT_OWNERS_TABLE}.*,${ENS_TABLE}.display as wallet_display, p.handle as handle, p.rep_score as rep_score, p.cic_score as cic_score, p.profile_tdh as profile_tdh `;
  let joins = `LEFT JOIN ${ENS_TABLE} ON ${NFT_OWNERS_TABLE}.wallet=${ENS_TABLE}.wallet `;
  joins += ` LEFT JOIN ${WALLETS_CONSOLIDATION_KEYS_VIEW} wc on wc.wallet = ${NFT_OWNERS_TABLE}.wallet`;
  joins += ` LEFT JOIN ${PROFILE_FULL} p on p.consolidation_key = wc.consolidation_key`;

  const result = await fetchPaginated(
    NFT_OWNERS_TABLE,
    params,
    `${sort} ${sortDir}, token_id asc, created_at desc`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
  result.data.forEach((d: any) => {
    d.level = calculateLevel({
      tdh: d.profile_tdh ?? 0,
      rep: d.rep_score
    });
  });
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
  idStr: string,
  pageSize: number,
  page: number,
  sort: string,
  sortDir: string
) {
  let filters = constructFilters(
    '',
    `${NFTS_TABLE}.contract = :gradient_contract`
  );
  const params: any = {
    gradient_contract: GRADIENT_CONTRACT
  };
  if (idStr) {
    filters += ` AND id in (:ids)`;
    params.ids = idStr.split(',');
  }

  let joins = ` INNER JOIN ${NFT_OWNERS_TABLE} ON ${NFTS_TABLE}.contract = ${NFT_OWNERS_TABLE}.contract AND ${NFTS_TABLE}.id = ${NFT_OWNERS_TABLE}.token_id `;
  joins += ` LEFT JOIN ${ENS_TABLE} ON ${NFT_OWNERS_TABLE}.wallet=${ENS_TABLE}.wallet`;
  const fields = ` ${NFTS_TABLE}.*, RANK() OVER (ORDER BY boosted_tdh desc, id asc) AS tdh_rank, ${NFT_OWNERS_TABLE}.wallet as owner, ${ENS_TABLE}.display as owner_display `;

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

export async function fetchMemesExtended(
  pageSize: number,
  page: number,
  nfts: string,
  seasons: string,
  sort: string,
  sortDir: string
) {
  let filters = '';
  const params: any = {};

  if (nfts) {
    filters = constructFilters(
      filters,
      `${MEMES_EXTENDED_DATA_TABLE}.id in (:nfts)`
    );
    params.nfts = nfts.split(',');
  }
  if (seasons) {
    filters = constructFilters(
      filters,
      `${MEMES_EXTENDED_DATA_TABLE}.season in (:seasons)`
    );
    params.seasons = seasons.split(',');
  }
  let joins = ` LEFT JOIN ${NFTS_TABLE} ON ${MEMES_EXTENDED_DATA_TABLE}.id = ${NFTS_TABLE}.id AND ${NFTS_TABLE}.contract = :memes_contract`;
  params.memes_contract = MEMES_CONTRACT;

  let sortResolved = sort;
  if (sort === 'id') {
    sortResolved = `${MEMES_EXTENDED_DATA_TABLE}.id`;
  } else if (sort === 'age') {
    sortResolved = `${MEMES_EXTENDED_DATA_TABLE}.id`;
    sortDir = sortDir.toLowerCase() === 'asc' ? 'desc' : 'asc';
  }

  return fetchPaginated(
    MEMES_EXTENDED_DATA_TABLE,
    params,
    `${sortResolved} ${sortDir}, ${MEMES_EXTENDED_DATA_TABLE}.id ${sortDir}`,
    pageSize,
    page,
    filters,
    '',
    joins
  );
}

export async function fetchMemesSeasons(sortDir: string) {
  const sql = `SELECT season, COUNT(id) as count, GROUP_CONCAT(id) AS token_ids FROM ${MEMES_EXTENDED_DATA_TABLE} GROUP BY season order by season ${sortDir}`;
  return await sqlExecutor.execute(sql);
}

export async function fetchNewMemesSeasons() {
  const sql = `SELECT * from ${MEMES_SEASONS_TABLE} order by id asc`;
  return await sqlExecutor.execute(sql);
}

export async function fetchMemesLite(
  sortDir: string,
  search: string,
  pageSize: number
) {
  let filters = constructFilters(
    '',
    `${NFTS_TABLE}.contract = :memes_contract`
  );
  let params: any = {
    memes_contract: MEMES_CONTRACT
  };
  if (search) {
    const searchFilters = getSearchFilters(['name', 'artist'], search);
    filters = constructFilters(filters, `(${searchFilters.filters})`);
    const id = parseInt(search);
    if (!isNaN(id)) {
      filters = constructFiltersOR(filters, `id = :id`);
      params = { ...params, ...searchFilters.params, id };
    }
  }

  return fetchPaginated(
    NFTS_TABLE,
    params,
    `id ${sortDir}`,
    pageSize,
    1,
    filters,
    'id, name, contract, icon, thumbnail, scaled, image, animation, artist',
    ''
  );
}

export async function resolveEns(walletsStr: string) {
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
    } else if (type_filter === 'sales' || type_filter === 'burns') {
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
        newTypeFilter += `value > 0 AND from_address != :null_address and from_address != :manifold and to_address != :null_address and to_address != :dead_address`;
        break;
      case 'airdrops':
        newTypeFilter += `value = 0 AND from_address = :null_address`;
        break;
      case 'mints':
        newTypeFilter += `value > 0 AND (from_address = :null_address OR from_address = :manifold)`;
        break;
      case 'transfers':
        newTypeFilter += `value = 0 and from_address != :null_address and to_address != :null_address and to_address != :dead_address`;
        break;
      case 'burns':
        newTypeFilter += `(to_address = :null_address or to_address = :dead_address)`;
        break;
    }
    if (newTypeFilter) {
      filters = constructFilters(filters, newTypeFilter);
      params.null_address = NULL_ADDRESS;
      params.dead_address = NULL_ADDRESS_DEAD;
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

  const fields = `${TRANSACTIONS_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON ${TRANSACTIONS_TABLE}.from_address=ens1.wallet LEFT JOIN ${ENS_TABLE} ens2 ON ${TRANSACTIONS_TABLE}.to_address=ens2.wallet`;
  filters.filters = constructFilters(
    filters.filters,
    `contract = :memeLabContract`
  );
  filters.params.memeLabContract = MEMELAB_CONTRACT;
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
      `contract in (:contracts)`
    );
    filters.params.contracts = contracts.split(',');
  }

  return fetchPaginatedTransactions(pageSize, page, filters);
}

export async function fetchTransactionByHash(hash: string) {
  const filters = constructFilters('', `transaction = :hash`);
  const params = {
    hash
  };

  return fetchPaginatedTransactions(1, 1, { filters, params });
}

async function fetchPaginatedTransactions(
  pageSize: number,
  page: number,
  filters: { filters: string; params: any }
) {
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

export function returnEmpty() {
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

export async function fetchDistributions(
  search: string,
  cards: string,
  contracts: string,
  pageSize: number,
  page: number
) {
  if (!search && !cards && !contracts) {
    return returnEmpty();
  }

  let filters = '';
  let params: any = {};

  if (search) {
    const searchFilters = getSearchFilters(
      [
        `${DISTRIBUTION_NORMALIZED_TABLE}.wallet`,
        `${DISTRIBUTION_NORMALIZED_TABLE}.wallet_display`
      ],
      search
    );
    filters = constructFilters(filters, `(${searchFilters.filters})`);
    params = {
      ...params,
      ...searchFilters.params
    };
  }
  if (cards) {
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_NORMALIZED_TABLE}.card_id in (:cards)`
    );
    params.cards = cards.split(',');
  }
  if (contracts) {
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_NORMALIZED_TABLE}.contract in (:contracts)`
    );
    params.contracts = contracts.split(',');
  }

  const results = await fetchPaginated(
    DISTRIBUTION_NORMALIZED_TABLE,
    params,
    `mint_date desc, airdrops desc, total_count desc, total_spots desc, wallet desc, wallet_display desc`,
    pageSize,
    page,
    filters
  );
  results.data.forEach((d: any) => {
    d.phases = JSON.parse(d.phases);
    d.allowlist = JSON.parse(d.allowlist);
  });
  return results;
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

export async function fetchMintingDelegations(
  wallet: string,
  pageSize: number,
  page: number
) {
  let filter = constructFilters('', `LOWER(from_address) = :wallet`);

  filter = constructFilters(filter, `expiry >= :expiry`);
  filter = constructFilters(filter, `use_case in (:use_cases)`);
  filter = constructFilters(filter, `collection in (:collections)`);

  const params = {
    wallet: wallet.toLowerCase(),
    expiry: Date.now() / 1000,
    use_cases: [USE_CASE_ALL, USE_CASE_MINTING],
    collections: [DELEGATION_ALL_ADDRESS, MEMES_CONTRACT]
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
    let image = '';
    if (metadata) {
      image = metadata.image ?? metadata.image_url ?? '';
    }
    let animation = '';
    if (metadata) {
      animation = metadata.animation ?? metadata.animation_url ?? '';
    }

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
