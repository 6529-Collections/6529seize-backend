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
  NEXT_GEN_ALLOWLIST,
  NEXT_GEN_COLLECTIONS,
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
  SIX529_MUSEUM,
  TDH_BLOCKS_TABLE,
  TDH_GLOBAL_HISTORY_TABLE,
  TDH_HISTORY_TABLE,
  TEAM_TABLE,
  TRANSACTIONS_MEME_LAB_TABLE,
  TRANSACTIONS_TABLE,
  UPLOADS_TABLE,
  USER_TABLE,
  WALLETS_TDH_TABLE
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
import { setSqlExecutor } from './sql-executor';
import * as profiles from './profiles';

import * as mysql from 'mysql';
import { Time } from './time';
import { DbPoolName, DbQueryOptions } from './db-query.options';

let read_pool: mysql.Pool;
let write_pool: mysql.Pool;

const WRITE_OPERATIONS = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'];

export async function connect() {
  let port: number | undefined;
  if (
    !process.env.DB_HOST ||
    !process.env.DB_USER ||
    !process.env.DB_PASS ||
    !process.env.DB_PORT
  ) {
    console.log('[API]', '[MISSING CONFIGURATION FOR WRITE DB]', '[EXITING]');
    process.exit();
  }
  if (
    !process.env.DB_HOST_READ ||
    !process.env.DB_USER_READ ||
    !process.env.DB_PASS_READ ||
    !process.env.DB_PORT
  ) {
    console.log('[API]', '[MISSING CONFIGURATION FOR READ DB]', '[EXITING]');
    process.exit();
  }
  port = +process.env.DB_PORT;
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
    ) => execSQLWithParams(sql, params, options)
  });
  console.log('[API]', `[CONNECTION POOLS CREATED]`);
}

function getPool(sql: string, queryOptions?: DbQueryOptions) {
  switch (queryOptions?.forcePool) {
    case DbPoolName.READ:
      return read_pool;
    case DbPoolName.WRITE:
      return write_pool;
    default:
      return WRITE_OPERATIONS.some((op) => sql.toUpperCase().startsWith(op))
        ? write_pool
        : read_pool;
  }
}

export function execSQL(sql: string, options?: DbQueryOptions): Promise<any> {
  const my_pool: mysql.Pool = getPool(sql, options);
  return new Promise((resolve, reject) => {
    my_pool.getConnection(function (
      err: mysql.MysqlError,
      dbcon: mysql.PoolConnection
    ) {
      if (err) {
        console.log('custom err', err);
        dbcon?.release();
        throw err;
      }
      dbcon.query(sql, (err: any, result: any[]) => {
        dbcon?.release();
        if (err) {
          console.log('custom err', err);
          return reject(err);
        }
        resolve(Object.values(JSON.parse(JSON.stringify(result))));
      });
    });
  });
}

export function execSQLWithParams(
  sql: string,
  params?: Record<string, any>,
  options?: { forcePool?: DbPoolName }
): Promise<any> {
  const my_pool: mysql.Pool = getPool(sql, options);
  return new Promise((resolve, reject) => {
    my_pool.getConnection(function (
      err: mysql.MysqlError,
      dbcon: mysql.PoolConnection
    ) {
      if (err) {
        console.log('custom err', err);
        dbcon?.release();
        throw err;
      }
      dbcon.config.queryFormat = function (query, values) {
        if (!values) return query;
        return query.replace(/\:(\w+)/g, function (txt: any, key: any) {
          if (values.hasOwnProperty(key)) {
            const value = values[key];
            if (Array.isArray(value)) {
              return value.map((v) => mysql.escape(v)).join(', ');
            }
            return mysql.escape(value);
          }
          return txt;
        });
      };
      dbcon.query({ sql, values: params }, (err: any, result: any[]) => {
        dbcon?.release();
        if (err) {
          console.log('custom err', err);
          return reject(err);
        }
        resolve(result);
      });
    });
  });
}

export async function fetchLatestTDHBlockNumber() {
  const sql = `SELECT block_number FROM ${TDH_BLOCKS_TABLE} order by block_number desc limit 1;`;
  const r = await execSQL(sql);
  return r.length > 0 ? r[0].block_number : 0;
}

export async function fetchLatestTDHHistoryBlockNumber() {
  const sql = `SELECT block FROM ${TDH_HISTORY_TABLE} order by block desc limit 1;`;
  const r = await execSQL(sql);
  return r.length > 0 ? r[0].block : 0;
}

export interface DBResponse {
  count: number;
  page: number;
  next: any;
  data: any[];
}

function constructFilters(f: string, newF: string) {
  if (f.trim().toUpperCase().startsWith('WHERE')) {
    return ` ${f} AND ${newF} `;
  }
  return ` WHERE ${newF} `;
}

function constructFiltersOR(f: string, newF: string) {
  if (f.trim() != '') {
    return ` ${f} OR ${newF} `;
  }
  return ` ${newF} `;
}

async function getTeamWallets() {
  const sql = `SELECT wallet FROM ${TEAM_TABLE}`;
  let results = await execSQL(sql);
  results = results.map((r: { wallet: string }) => r.wallet);
  return results;
}

async function fetchPaginated(
  table: string,
  orderBy: string,
  pageSize: number,
  page: number,
  filters: string,
  fields?: string,
  joins?: string,
  groups?: string
) {
  const countSql = `SELECT COUNT(1) as count FROM (SELECT 1 FROM ${table} ${joins} ${filters}${
    groups ? ` GROUP BY ${groups}` : ``
  }) inner_q`;

  let resultsSql = `SELECT ${fields ? fields : '*'} FROM ${table} ${
    joins ? joins : ''
  } ${filters} ${groups ? `group by ${groups}` : ``} order by ${orderBy} ${
    pageSize > 0 ? `LIMIT ${pageSize}` : ``
  }`;
  if (page > 1) {
    const offset = pageSize * (page - 1);
    resultsSql += ` OFFSET ${offset}`;
  }

  // console.log(countSql);
  // console.log(resultsSql);

  const count = await execSQL(countSql).then((r) => r[0].count);
  const data = await execSQL(resultsSql);

  // console.log(count);
  // console.log(data);

  return {
    count,
    page,
    next: count > pageSize * page,
    data
  };
}

export async function fetchRandomImage() {
  const sql = `SELECT scaled,image from ${NFTS_TABLE} WHERE CONTRACT=${mysql.escape(
    MEMES_CONTRACT
  )} ORDER BY RAND() LIMIT 1;`;
  return execSQL(sql);
}

export async function fetchBlocks(pageSize: number, page: number) {
  return fetchPaginated(
    TDH_BLOCKS_TABLE,
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
  let filters = '';
  if (block) {
    filters = constructFilters(filters, `block <= ${block}`);
  }
  if (date) {
    filters = constructFilters(
      filters,
      `STR_TO_DATE(date, '%Y%m%d') <= ${mysql.escape(date)}`
    );
  }

  return fetchPaginated(
    UPLOADS_TABLE,
    'block desc',
    pageSize,
    page,
    filters,
    ''
  );
}

export async function fetchConsolidatedUploads(
  pageSize: number,
  page: number,
  block: number,
  date: string
) {
  let filters = '';
  if (block) {
    filters = constructFilters(filters, `block <= ${block}`);
  }
  if (date) {
    filters = constructFilters(
      filters,
      `STR_TO_DATE(date, '%Y%m%d') <= ${mysql.escape(date)}`
    );
  }

  return fetchPaginated(
    CONSOLIDATED_UPLOADS_TABLE,
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
  if (meme_nfts) {
    filters = `WHERE `;
    meme_nfts.split(',').map((nft_id) => {
      const query = `%\"id\": ${nft_id}%`;
      filters += ` memes LIKE ${mysql.escape(query)}`;
    });
  }
  return fetchPaginated(
    ARTISTS_TABLE,
    'created_at desc',
    pageSize,
    page,
    filters
  );
}

export async function fetchLabNFTs(
  memeIds: string,
  pageSize: number,
  page: number,
  contracts: string,
  nfts: string,
  sortDir: string
) {
  let filters = '';
  if (memeIds) {
    memeIds.split(',').map((nft_id) => {
      filters = constructFilters(
        filters,
        `JSON_CONTAINS(meme_references, '${nft_id}','$')`
      );
    });
  }
  if (contracts) {
    filters = constructFilters(
      filters,
      `contract in (${mysql.escape(contracts.split(','))})`
    );
  }
  if (nfts) {
    filters = constructFilters(filters, `id in (${nfts})`);
  }
  return fetchPaginated(
    NFTS_MEME_LAB_TABLE,
    `id ${sortDir}`,
    pageSize,
    page,
    filters,
    `${NFTS_MEME_LAB_TABLE}.*, CASE WHEN EXISTS (SELECT 1 FROM distribution d WHERE d.card_id = ${NFTS_MEME_LAB_TABLE}.id AND d.contract = ${NFTS_MEME_LAB_TABLE}.contract) THEN TRUE ELSE FALSE END AS has_distribution`,
    ''
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
  if (wallets) {
    filters = constructFilters(
      filters,
      `(${OWNERS_MEME_LAB_TABLE}.wallet in (${mysql.escape(
        wallets.split(',')
      )}) OR ${ENS_TABLE}.display in (${mysql.escape(wallets.split(','))}))`
    );
  }
  if (nfts) {
    filters = constructFilters(filters, `token_id in (${nfts})`);
  }

  const fields = ` ${OWNERS_MEME_LAB_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${OWNERS_MEME_LAB_TABLE}.wallet=${ENS_TABLE}.wallet`;

  const result = await fetchPaginated(
    OWNERS_MEME_LAB_TABLE,
    `${sort} ${sortDir}, token_id asc, created_at desc`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
  result.data = await enhanceDataWithHandles(result.data);
  return result;
}

export async function fetchTeam(pageSize: number, page: number) {
  return fetchPaginated(
    TEAM_TABLE,
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
  if (contracts) {
    filters = constructFilters(
      filters,
      `contract in (${mysql.escape(contracts.split(','))})`
    );
  }
  if (nfts) {
    filters = constructFilters(
      filters,
      `id in (${nfts
        .split(',')
        .map((it) => mysql.escape(it))
        .join(',')})`
    );
  }
  return fetchPaginated(
    NFTS_TABLE,
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
    `${NFTS_TABLE}.contract = ${mysql.escape(GRADIENT_CONTRACT)}`
  );

  let joins = ` INNER JOIN ${OWNERS_TABLE} ON ${NFTS_TABLE}.contract = ${OWNERS_TABLE}.contract AND ${NFTS_TABLE}.id = ${OWNERS_TABLE}.token_id `;
  joins += ` LEFT JOIN ${ENS_TABLE} ON ${OWNERS_TABLE}.wallet=${ENS_TABLE}.wallet`;
  const fields = ` ${NFTS_TABLE}.*, RANK() OVER (ORDER BY boosted_tdh desc, id asc) AS tdh_rank, ${OWNERS_TABLE}.wallet as owner, ${ENS_TABLE}.display as owner_display `;

  return fetchPaginated(
    NFTS_TABLE,
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
  const filters = `WHERE owners.wallet = ${mysql.escape(address)}`;

  return fetchPaginated(
    NFTS_TABLE,
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

  if (nfts) {
    filters = constructFilters(filters, `id in (${nfts})`);
  }
  if (seasons) {
    filters = constructFilters(filters, `season in (${seasons})`);
  }
  return fetchPaginated(
    MEMES_EXTENDED_DATA_TABLE,
    `id ${sortDir}`,
    pageSize,
    page,
    filters
  );
}

export async function fetchMemesSeasons(sortDir: string) {
  const sql = `SELECT season, COUNT(id) as count, GROUP_CONCAT(id) AS token_ids FROM ${MEMES_EXTENDED_DATA_TABLE} GROUP BY season order by season ${sortDir}`;
  return await execSQL(sql);
}

export async function fetchMemesLite(sortDir: string) {
  const filters = constructFilters(
    '',
    `${NFTS_TABLE}.contract = ${mysql.escape(MEMES_CONTRACT)}`
  );

  return fetchPaginated(
    NFTS_TABLE,
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
  if (wallets) {
    filters = constructFilters(
      filters,
      `(${OWNERS_TABLE}.wallet in (${mysql.escape(
        wallets.split(',')
      )}) OR ${ENS_TABLE}.display in (${mysql.escape(wallets.split(','))}))`
    );
  }
  if (contracts) {
    filters = constructFilters(
      filters,
      `contract in (${mysql.escape(contracts.split(','))})`
    );
  }
  if (nfts) {
    filters = constructFilters(filters, `token_id in (${nfts})`);
  }

  const fields = ` ${OWNERS_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${OWNERS_TABLE}.wallet=${ENS_TABLE}.wallet`;

  return fetchPaginated(
    OWNERS_TABLE,
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
  if (wallets) {
    filters = constructFilters(
      filters,
      `${OWNERS_TAGS_TABLE}.wallet in (${mysql.escape(
        wallets.split(',')
      )}) OR ${ENS_TABLE}.display in (${mysql.escape(wallets.split(','))})`
    );
  }

  const fields = ` ${OWNERS_TAGS_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${OWNERS_TAGS_TABLE}.wallet=${ENS_TABLE}.wallet`;

  return fetchPaginated(
    OWNERS_TAGS_TABLE,
    'memes_balance desc, gradients_balance desc',
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchLabTransactions(
  pageSize: number,
  page: number,
  wallets: string,
  nfts: string,
  type_filter: string
) {
  let filters = '';
  if (wallets) {
    filters = constructFilters(
      filters,
      `(from_address in (${mysql.escape(
        wallets.split(',')
      )}) OR to_address in (${mysql.escape(wallets.split(','))}))`
    );
  }
  if (nfts) {
    filters = constructFilters(filters, `token_id in (${nfts})`);
  }
  if (type_filter) {
    let newTypeFilter = '';
    switch (type_filter) {
      case 'sales':
        newTypeFilter += `value > 0 AND from_address != ${mysql.escape(
          NULL_ADDRESS
        )} and to_address != ${mysql.escape(NULL_ADDRESS)}`;
        break;
      case 'airdrops':
        newTypeFilter += `value = 0 AND from_address = ${mysql.escape(
          NULL_ADDRESS
        )}`;
        break;
      case 'mints':
        newTypeFilter += `value > 0 AND from_address = ${mysql.escape(
          NULL_ADDRESS
        )}`;
        break;
      case 'transfers':
        newTypeFilter += `value = 0 and from_address != ${mysql.escape(
          NULL_ADDRESS
        )} and to_address != ${mysql.escape(NULL_ADDRESS)}`;
        break;
      case 'burns':
        newTypeFilter += `to_address = ${mysql.escape(NULL_ADDRESS)}`;
        break;
    }
    if (newTypeFilter) {
      filters = constructFilters(filters, newTypeFilter);
    }
  }

  const fields = `${TRANSACTIONS_MEME_LAB_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON ${TRANSACTIONS_MEME_LAB_TABLE}.from_address=ens1.wallet LEFT JOIN ${ENS_TABLE} ens2 ON ${TRANSACTIONS_MEME_LAB_TABLE}.to_address=ens2.wallet`;

  return fetchPaginated(
    TRANSACTIONS_MEME_LAB_TABLE,
    'transaction_date desc',
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

async function resolveEns(walletsStr: string) {
  const wallets = walletsStr.split(',');
  const sql = `SELECT wallet,display FROM ${ENS_TABLE} WHERE wallet IN (${mysql.escape(
    wallets
  )}) OR display IN (${mysql.escape(wallets)})`;
  const results = await execSQL(sql);
  const returnResults: string[] = [];
  wallets.map((wallet: any) => {
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

export async function fetchTransactions(
  pageSize: number,
  page: number,
  wallets: string,
  contracts: string,
  nfts: string,
  type_filter: string
) {
  let filters = '';
  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    if (resolvedWallets.length == 0) {
      return returnEmpty();
    }
    filters = constructFilters(
      filters,
      `(from_address in (${mysql.escape(
        resolvedWallets
      )}) OR to_address in (${mysql.escape(resolvedWallets)}))`
    );
  }
  if (contracts) {
    filters = constructFilters(
      filters,
      `contract in (${mysql.escape(contracts.split(','))})`
    );
  }
  if (nfts) {
    filters = constructFilters(filters, `token_id in (${nfts})`);
  }
  if (type_filter) {
    let newTypeFilter = '';
    switch (type_filter) {
      case 'sales':
        newTypeFilter += `value > 0 AND from_address != ${mysql.escape(
          NULL_ADDRESS
        )} and to_address != ${mysql.escape(NULL_ADDRESS)}`;
        break;
      case 'airdrops':
        newTypeFilter += `value = 0 AND from_address = ${mysql.escape(
          NULL_ADDRESS
        )}`;
        break;
      case 'mints':
        newTypeFilter += `value > 0 AND from_address = ${mysql.escape(
          NULL_ADDRESS
        )}`;
        break;
      case 'transfers':
        newTypeFilter += `value = 0 and from_address != ${mysql.escape(
          NULL_ADDRESS
        )} and to_address != ${mysql.escape(NULL_ADDRESS)}`;
        break;
      case 'burns':
        newTypeFilter += `to_address = ${mysql.escape(NULL_ADDRESS)}`;
        break;
    }
    if (newTypeFilter) {
      filters = constructFilters(filters, newTypeFilter);
    }
  }

  const fields = `${TRANSACTIONS_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON ${TRANSACTIONS_TABLE}.from_address=ens1.wallet LEFT JOIN ${ENS_TABLE} ens2 ON ${TRANSACTIONS_TABLE}.to_address=ens2.wallet`;

  return fetchPaginated(
    TRANSACTIONS_TABLE,
    'transaction_date desc',
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchGradientTdh(pageSize: number, page: number) {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  let filters = constructFilters('', `block=${tdhBlock}`);
  filters = constructFilters(filters, `gradients_balance > 0`);

  const fields = ` ${WALLETS_TDH_TABLE}.*,${ENS_TABLE}.display as wallet_display `;
  const joins = `LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet`;

  return fetchPaginated(
    WALLETS_TDH_TABLE,
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
  let filters = `WHERE block=${tdhBlock} AND j.id=${nftId} `;
  if (wallets) {
    filters += ` AND ${WALLETS_TDH_TABLE}.wallet in (${mysql.escape(
      wallets.split(',')
    )})`;
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
    `${sort} ${sortDir}, boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
  result.data = await enhanceDataWithHandles(result.data);
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
  let filters = `WHERE j.id=${nftId} `;
  if (wallets) {
    wallets.split(',').map((w) => {
      filters = constructFilters(
        filters,
        `LOWER(${CONSOLIDATED_WALLETS_TDH_TABLE}.wallets) LIKE '%${w.toLowerCase()}%'`
      );
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
    `${sort} ${sortDir}, boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
  result.data = await enhanceDataWithHandles(result.data);
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
  let filters = `WHERE block=${tdhBlock}`;
  if (hideMuseum) {
    filters = constructFilters(
      filters,
      `${WALLETS_TDH_TABLE}.wallet != ${mysql.escape(SIX529_MUSEUM)}`
    );
  }
  if (hideTeam) {
    const team: string[] = await getTeamWallets();
    filters = constructFilters(
      filters,
      `${OWNERS_METRICS_TABLE}.wallet NOT IN (${mysql.escape(team)})`
    );
  }
  if (wallets) {
    filters = constructFilters(
      filters,
      `${WALLETS_TDH_TABLE}.wallet in (${mysql.escape(wallets.split(','))})`
    );
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
  if (hideMuseum) {
    filters = constructFilters(
      filters,
      `${OWNERS_METRICS_TABLE}.wallet != ${mysql.escape(SIX529_MUSEUM)}`
    );
  }
  if (hideTeam) {
    const team: string[] = await getTeamWallets();
    filters = constructFilters(
      filters,
      `${OWNERS_METRICS_TABLE}.wallet NOT IN (${mysql.escape(team)})`
    );
  }
  hideWalletFilters = filters;
  if (wallets) {
    filters = constructFilters(
      filters,
      `${OWNERS_METRICS_TABLE}.wallet in (${mysql.escape(
        wallets.split(',').map((w) => w.toLowerCase())
      )}) OR ${ENS_TABLE}.display in (${mysql.escape(
        wallets.split(',').map((w) => w.toLowerCase())
      )})`
    );
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
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes_szn5 = ${OWNERS_TAGS_TABLE}2.unique_memes_szn5) AS dense_rank_unique_memes_season5__ties `;
  }

  const walletsTdhTableSelect = `
    ${WALLETS_TDH_TABLE}.tdh_rank, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn1, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn2, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn3, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn4, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn5, 
    ${WALLETS_TDH_TABLE}.tdh_rank_gradients, 
    ${WALLETS_TDH_TABLE}.boost, 
    ${WALLETS_TDH_TABLE}.boosted_tdh, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season1, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season2, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season3, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season4, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season5, 
    ${WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${WALLETS_TDH_TABLE}.tdh__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season1__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season2__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season3__raw,
    ${WALLETS_TDH_TABLE}.memes_tdh_season4__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season5__raw, 
    ${WALLETS_TDH_TABLE}.gradients_tdh__raw, 
    ${WALLETS_TDH_TABLE}.tdh, 
    ${WALLETS_TDH_TABLE}.memes_tdh, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season1, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season2, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season3, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season4, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season5, 
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
    sort == 'memes_cards_sets_minus1' ||
    sort == 'genesis' ||
    sort == 'unique_memes' ||
    sort == 'unique_memes_szn1' ||
    sort == 'unique_memes_szn2' ||
    sort == 'unique_memes_szn3' ||
    sort == 'unique_memes_szn4' ||
    sort == 'unique_memes_szn5'
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
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients, 
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes DESC) AS dense_rank_unique_memes,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn1 DESC) AS dense_rank_unique_memes_season1,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn2 DESC) AS dense_rank_unique_memes_season2,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn3 DESC) AS dense_rank_unique_memes_season3,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn4 DESC) AS dense_rank_unique_memes_season4,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn5 DESC) AS dense_rank_unique_memes_season5  
      FROM ${OWNERS_METRICS_TABLE} LEFT JOIN ${WALLETS_TDH_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${OWNERS_METRICS_TABLE}.wallet and ${WALLETS_TDH_TABLE}.block=${tdhBlock} LEFT JOIN ${OWNERS_TAGS_TABLE} ON ${OWNERS_METRICS_TABLE}.wallet=${OWNERS_TAGS_TABLE}.wallet ${hideWalletFilters}) as dense_table ON ${OWNERS_METRICS_TABLE}.wallet = dense_table.wallet `;
  }

  const results = await fetchPaginated(
    OWNERS_METRICS_TABLE,
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
      let results2 = await execSQL(sql);
      results2 = await enhanceDataWithHandles(results2);
      return {
        count: results2.length,
        page: 1,
        next: null,
        data: results2
      };
    }
  }
  results.data = await enhanceDataWithHandles(results.data);
  return results;
}

export async function fetchConsolidatedOwnerMetricsForKey(
  consolidationkey: string
) {
  const filters = constructFilters(
    '',
    `${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key = ${mysql.escape(
      consolidationkey
    )}`
  );

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
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn5 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn5) AS dense_rank_unique_memes_season5__ties `;

  const walletsTdhTableSelect = `
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn5, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_gradients, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boost, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season3,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season5, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4__raw, 
     ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season5__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season5, 
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
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes DESC) AS dense_rank_unique_memes,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn1 DESC) AS dense_rank_unique_memes_season1,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn2 DESC) AS dense_rank_unique_memes_season2,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn3 DESC) AS dense_rank_unique_memes_season3,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn4 DESC) AS dense_rank_unique_memes_season4,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn5 DESC) AS dense_rank_unique_memes_season5 
      FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} 
        LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_key) 
      AS dense_table ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key = dense_table.consolidation_key `;

  const results = await fetchPaginated(
    CONSOLIDATED_OWNERS_METRICS_TABLE,
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
    const results2 = await execSQL(sql);
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

async function enhanceDataWithHandles(
  data: { wallets?: string; wallet?: string }[]
) {
  const resultWallets: string[] = distinct(
    data
      .map((d: { wallets?: string; wallet?: string }) =>
        d.wallet ? [d.wallet] : d.wallets ? JSON.parse(d.wallets) : []
      )
      .flat()
  );
  const walletsToHandles = await profiles.getProfileHandlesByPrimaryWallets(
    resultWallets
  );

  return data.map((d: { wallets?: string; wallet?: string }) => {
    const parsedWallets = d.wallet
      ? [d.wallet]
      : d.wallets
      ? JSON.parse(d.wallets)
      : [];
    const resolvedWallet = parsedWallets.find(
      (w: string) => walletsToHandles[w.toLowerCase()]
    );
    if (!resolvedWallet) {
      return d;
    }
    return { ...d, handle: walletsToHandles[resolvedWallet.toLowerCase()] };
  });
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
  if (hideMuseum) {
    filters = constructFilters(
      filters,
      `LOWER(${CONSOLIDATED_OWNERS_METRICS_TABLE}.wallets) NOT LIKE '%${SIX529_MUSEUM.toLowerCase()}%'`
    );
  }
  if (hideTeam) {
    const team: string[] = await getTeamWallets();
    team.map((t) => {
      filters = constructFilters(
        filters,
        `LOWER(${CONSOLIDATED_OWNERS_METRICS_TABLE}.wallets) NOT LIKE '%${t.toLowerCase()}%'`
      );
    });
  }
  hideWalletFilters = filters;
  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    let walletFilters = '';
    resolvedWallets.map((w) => {
      walletFilters = constructFiltersOR(
        walletFilters,
        `LOWER(${CONSOLIDATED_OWNERS_METRICS_TABLE}.wallets) LIKE '%${w.toLowerCase()}%'`
      );
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
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn5 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn5) AS dense_rank_unique_memes_season5__ties `;
  }

  const walletsTdhTableSelect = `
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn5, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_gradients, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boost, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season3,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season5, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season5__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season5, 
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
    sort == 'memes_cards_sets_minus1' ||
    sort == 'genesis' ||
    sort == 'unique_memes' ||
    sort == 'unique_memes_szn1' ||
    sort == 'unique_memes_szn2' ||
    sort == 'unique_memes_szn3' ||
    sort == 'unique_memes_szn4' ||
    sort == 'unique_memes_szn5'
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
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes DESC) AS dense_rank_unique_memes,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn1 DESC) AS dense_rank_unique_memes_season1,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn2 DESC) AS dense_rank_unique_memes_season2,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn3 DESC) AS dense_rank_unique_memes_season3,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn4 DESC) AS dense_rank_unique_memes_season4,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn5 DESC) AS dense_rank_unique_memes_season5 
      FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} 
        LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_key ${hideWalletFilters}) 
      AS dense_table ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_key = dense_table.consolidation_key `;
  }

  const results = await fetchPaginated(
    CONSOLIDATED_OWNERS_METRICS_TABLE,
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
      let results2 = await execSQL(sql);
      results2[0].wallets = resolvedWallets;
      results2 = await enhanceDataWithHandles(results2);
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
  results.data = await enhanceDataWithHandles(results.data);

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
  const sql = `SELECT * FROM ${ENS_TABLE} WHERE LOWER(wallet)=LOWER(${mysql.escape(
    address
  )}) OR LOWER(display)=LOWER(${mysql.escape(address)})`;
  return execSQL(sql);
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
    WHERE LOWER(${ENS_TABLE}.wallet)=LOWER(${mysql.escape(
    address
  )}) OR LOWER(display)=LOWER(${mysql.escape(
    address
  )}) ORDER BY ${USER_TABLE}.updated_at desc limit 1`;
  return execSQL(sql);
}

export async function fetchRanksForWallet(address: string) {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  const sqlTdh = `SELECT * FROM ${WALLETS_TDH_TABLE} WHERE block=${tdhBlock} and wallet=${mysql.escape(
    address
  )}`;
  const ownerTdh = await execSQL(sqlTdh);

  return ownerTdh;
}

export async function fetchLabExtended(
  pageSize: number,
  page: number,
  nfts: string,
  collections: string
) {
  let filters = '';

  if (nfts) {
    filters = constructFilters(filters, `id in (${nfts})`);
  }
  if (collections) {
    filters = constructFilters(
      filters,
      `metadata_collection in (${mysql.escape(collections.split(','))})`
    );
  }
  return fetchPaginated(LAB_EXTENDED_DATA_TABLE, 'id', pageSize, page, filters);
}

export async function fetchDistributionPhotos(
  contract: string,
  cardId: number,
  pageSize: number,
  page: number
) {
  let filters = constructFilters('', `contract = ${mysql.escape(contract)}`);
  filters = constructFilters(filters, `card_id = ${cardId}`);

  return fetchPaginated(
    DISTRIBUTION_PHOTO_TABLE,
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
  const sql = `SELECT DISTINCT phase FROM ${DISTRIBUTION_TABLE} WHERE contract=${mysql.escape(
    contract
  )} AND card_id=${cardId} ORDER BY phase ASC`;
  const results = await execSQL(sql);
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
  let filters = constructFilters(
    '',
    `${DISTRIBUTION_TABLE}.contract = ${mysql.escape(contract)}`
  );
  filters = constructFilters(filters, `card_id = ${cardId}`);
  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    if (resolvedWallets.length == 0) {
      return returnEmpty();
    }
    filters += ` AND ${DISTRIBUTION_TABLE}.wallet in (${mysql.escape(
      resolvedWallets
    )})`;
  }
  if (phases) {
    filters = constructFilters(
      filters,
      `phase in (${mysql.escape(phases.split(','))})`
    );
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
  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    if (resolvedWallets.length == 0) {
      return returnEmpty();
    }
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_TABLE}.wallet in (${mysql.escape(resolvedWallets)})`
    );
  }
  if (cards) {
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_TABLE}.card_id in (${cards})`
    );
  }
  if (contracts) {
    filters = constructFilters(
      filters,
      `${DISTRIBUTION_TABLE}.contract in (${mysql.escape(
        contracts.split(',')
      )})`
    );
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
    const sql = getConsolidationsSql(wallet);
    const consolidations: any[] = await execSQL(sql);
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
    sql += ` WHERE wallet1=${mysql.escape(wallet)} OR wallet2=${mysql.escape(
      wallet
    )}`;
    const results = await execSQL(sql);
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
  const sql = `SELECT wallet from ${WALLETS_TDH_TABLE} where wallet in (${mysql.escape(
    wallets
  )}) AND block=${tdhBlock} order by boosted_tdh desc limit 1`;
  const results: any[] = await execSQL(sql);
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
  if (block) {
    filters = constructFilters(filters, `block <= ${block}`);
  }
  const results = await fetchPaginated(
    CONSOLIDATED_WALLETS_TDH_TABLE,
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
  if (block) {
    filters = constructFilters('', `block <= ${block}`);
  }
  if (!showIncomplete) {
    filters = constructFilters(filters, `confirmed=1`);
  }
  let joins = `LEFT JOIN ${ENS_TABLE} e1 ON ${CONSOLIDATIONS_TABLE}.wallet1=e1.wallet`;
  joins += ` LEFT JOIN ${ENS_TABLE} e2 ON ${CONSOLIDATIONS_TABLE}.wallet2=e2.wallet`;

  return fetchPaginated(
    CONSOLIDATIONS_TABLE,
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
  const filter = `WHERE from_address = ${mysql.escape(
    wallet
  )} OR to_address = ${mysql.escape(wallet)}`;

  let joins = `LEFT JOIN ${ENS_TABLE} e1 ON ${DELEGATIONS_TABLE}.from_address=e1.wallet`;
  joins += ` LEFT JOIN ${ENS_TABLE} e2 ON ${DELEGATIONS_TABLE}.to_address=e2.wallet`;

  return fetchPaginated(
    DELEGATIONS_TABLE,
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
  if (collections) {
    filters = constructFilters(
      filters,
      `collection in (${mysql.escape(collections.split(','))})`
    );
  }
  if (!showExpired) {
    filters = constructFilters(filters, `expiry >= ${Date.now() / 1000}`);
  }
  if (useCases) {
    filters = constructFilters(filters, `use_case in (${useCases.split(',')})`);
  }
  if (block) {
    filters = constructFilters(filters, `block <= ${block}`);
  }

  return fetchPaginated(
    DELEGATIONS_TABLE,
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
  const filter = constructFilters(
    '',
    `contract=${mysql.escape(contract)} AND nft_id=${nftId}`
  );

  return fetchPaginated(
    NFTS_HISTORY_TABLE,
    `transaction_date desc`,
    pageSize,
    page,
    filter
  );
}

export async function fetchNextGenAllowlist(
  merkleRoot: string,
  address: string
) {
  const sql1 = `SELECT * FROM ${NEXT_GEN_COLLECTIONS} WHERE merkle_root=${mysql.escape(
    merkleRoot
  )}`;
  const collection = (await execSQL(sql1))[0];

  const sql2 = `SELECT * FROM ${NEXT_GEN_ALLOWLIST} WHERE merkle_root=${mysql.escape(
    merkleRoot
  )} AND address=${mysql.escape(address)}`;
  const allowlist = (await execSQL(sql2))[0];

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

  if (memeIds) {
    memeIds.split(',').map((nft_id) => {
      filters = constructFilters(
        filters,
        `JSON_CONTAINS(${REMEMES_TABLE}.meme_references, '${nft_id}','$')`
      );
    });
  }
  if (tokenType) {
    filters = constructFilters(
      filters,
      `${REMEMES_TABLE}.token_type=${mysql.escape(tokenType)}`
    );
  }

  if (contract && id) {
    filters = constructFilters(
      filters,
      `${REMEMES_TABLE}.contract=${mysql.escape(
        contract
      )} AND id=${mysql.escape(id)}`
    );
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
    ` created_at desc `,
    pageSize,
    page,
    ''
  );
}

export async function rememeExists(contract: string, token_id: string) {
  const sql = `SELECT * FROM ${REMEMES_TABLE} WHERE contract=${mysql.escape(
    contract
  )} AND id=${mysql.escape(token_id)}`;
  const result = await execSQL(sql);
  return result.length > 0;
}

export async function addRememe(by: string, rememe: any) {
  const contract = rememe.contract.address;
  const openseaData = rememe.contract.openSea;
  const deployer = rememe.contract.contractDeployer;
  const tokens = rememe.nfts;

  for (const t of tokens) {
    const token_id = t.tokenId;
    const tokenType = t.tokenType;
    const tokenUri = t.tokenUri ? t.tokenUri.raw : '';
    const media = t.media;
    const metadata = t.rawMetadata;
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

    const sql = `INSERT INTO ${REMEMES_TABLE} (contract, id, deployer, token_uri, token_type, image, animation, meme_references, metadata, contract_opensea_data, media, source, added_by) VALUES (${mysql.escape(
      contract
    )}, ${mysql.escape(token_id)}, ${mysql.escape(deployer)}, ${mysql.escape(
      tokenUri
    )}, ${mysql.escape(tokenType)}, ${mysql.escape(image)}, ${mysql.escape(
      animation
    )}, ${mysql.escape(JSON.stringify(rememe.references))}, ${mysql.escape(
      JSON.stringify(metadata)
    )}, ${mysql.escape(JSON.stringify(openseaData))}, ${mysql.escape(
      JSON.stringify(media)
    )}, ${mysql.escape(RememeSource.SEIZE)}, ${mysql.escape(by)})`;
    await execSQL(sql);
  }
}

export async function getTdhForAddress(address: string) {
  const sql = `SELECT boosted_tdh FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} WHERE LOWER(${CONSOLIDATED_WALLETS_TDH_TABLE}.wallets) LIKE '%${address.toLowerCase()}%'`;
  const result = await execSQL(sql);
  if (result.length === 0) {
    return 0;
  }
  return result[0].boosted_tdh;
}

export async function fetchTDHGlobalHistory(pageSize: number, page: number) {
  return fetchPaginated(
    TDH_GLOBAL_HISTORY_TABLE,
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
  if (wallets) {
    const resolvedWallets = await resolveEns(wallets);
    resolvedWallets.map((w) => {
      filters = constructFilters(
        filters,
        `LOWER(wallets) LIKE '%${w.toLowerCase()}%'`
      );
    });
  }

  return fetchPaginated(
    TDH_HISTORY_TABLE,
    ` date desc, block desc, net_boosted_tdh desc `,
    pageSize,
    page,
    filters
  );
}

export async function updateUser(user: User) {
  const sql = `INSERT INTO ${USER_TABLE} (wallet, pfp, banner_1, banner_2, website) VALUES (${mysql.escape(
    user.wallet
  )}, ${mysql.escape(user.pfp)}, ${mysql.escape(user.banner_1)}, ${mysql.escape(
    user.banner_2
  )}, ${mysql.escape(user.website)}) ON DUPLICATE KEY UPDATE ${
    user.pfp ? `pfp=${mysql.escape(user.pfp)},` : ``
  } banner_1=${mysql.escape(user.banner_1)}, banner_2=${mysql.escape(
    user.banner_2
  )}, website=${mysql.escape(user.website)}`;

  await execSQL(sql);
}
