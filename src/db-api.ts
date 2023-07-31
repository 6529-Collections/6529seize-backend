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
  NEXT_GEN_ALLOWLIST,
  NEXT_GEN_COLLECTIONS,
  GRADIENT_CONTRACT,
  LAB_EXTENDED_DATA_TABLE,
  MANIFOLD,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  NFTS_HISTORY_TABLE,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  NULL_ADDRESS,
  OWNERS_MEME_LAB_TABLE,
  OWNERS_METRICS_TABLE,
  OWNERS_TABLE,
  OWNERS_TAGS_TABLE,
  SIX529_MUSEUM,
  SZN1_INDEX,
  SZN2_INDEX,
  SZN3_INDEX,
  TDH_BLOCKS_TABLE,
  TEAM_TABLE,
  TRANSACTIONS_MEME_LAB_TABLE,
  TRANSACTIONS_TABLE,
  UPLOADS_TABLE,
  WALLETS_TDH_TABLE,
  REMEMES_TABLE,
  REMEMES_UPLOADS
} from './constants';
import {
  areEqualAddresses,
  extractConsolidationWallets,
  getConsolidationsSql
} from './helpers';
import { getProof } from './merkle_proof';

const mysql = require('mysql');

let mysql_pool: any;

export async function connect() {
  mysql_pool = mysql.createPool({
    connectionLimit: 10,
    connectTimeout: 30 * 1000,
    acquireTimeout: 30 * 1000,
    timeout: 30 * 1000,
    host: process.env.DB_HOST_READ,
    port: process.env.DB_PORT,
    user: process.env.DB_USER_READ,
    password: process.env.DB_PASS_READ,
    charset: 'utf8mb4',
    database: process.env.DB_NAME
  });

  console.log('[API]', `[CONNECTION POOL CREATED]`);
}

export function execSQL(sql: string): Promise<any> {
  return new Promise((resolve, reject) => {
    mysql_pool.getConnection(function (err: any, dbcon: any) {
      if (err) {
        console.log('custom err', err);
        if (dbcon) {
          dbcon.release();
        }
        throw err;
      }
      dbcon.query(sql, (err: any, result: any[]) => {
        dbcon.release();
        if (err) {
          console.log('custom err', err);
          return reject(err);
        }
        resolve(Object.values(JSON.parse(JSON.stringify(result))));
      });
    });
  });
}

export async function fetchLatestTDHBlockNumber() {
  let sql = `SELECT block_number FROM ${TDH_BLOCKS_TABLE} order by block_number desc limit 1;`;
  const r = await execSQL(sql);
  return r.length > 0 ? r[0].block_number : 0;
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
  const sql1 = `SELECT COUNT(*) as count FROM ${table} ${joins} ${filters}`;

  let sql2 = `SELECT ${fields ? fields : '*'} FROM ${table} ${
    joins ? joins : ''
  } ${filters} ${
    groups ? `group by ${groups}` : ``
  } order by ${orderBy} LIMIT ${pageSize}`;
  if (page > 1) {
    const offset = pageSize * (page - 1);
    sql2 += ` OFFSET ${offset}`;
  }
  const r1 = await execSQL(sql1);
  const r2 = await execSQL(sql2);

  // console.log(sql1);
  // console.log(sql2);

  // console.log(r1)
  // console.log(r2);

  return {
    count: r1[0]?.count,
    page: page,
    next: r1[0]?.count > pageSize * page,
    data: r2
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
  const joins = `LEFT JOIN ${ENS_TABLE} ON LOWER(${OWNERS_MEME_LAB_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet)`;

  return fetchPaginated(
    OWNERS_MEME_LAB_TABLE,
    `${sort} ${sortDir}, token_id asc, created_at desc`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
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
    filters = constructFilters(filters, `id in (${nfts})`);
  }
  return fetchPaginated(
    NFTS_TABLE,
    `id ${sortDir}`,
    pageSize,
    page,
    filters,
    `${NFTS_TABLE}.*, CASE WHEN EXISTS (SELECT 1 FROM distribution d WHERE d.card_id = ${NFTS_TABLE}.id AND d.contract = ${NFTS_TABLE}.contract) THEN TRUE ELSE FALSE END AS has_distribution`,
    ''
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
  seasons: string
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
    'id',
    pageSize,
    page,
    filters
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
  const joins = `LEFT JOIN ${ENS_TABLE} ON LOWER(${OWNERS_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet)`;

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
  const joins = `LEFT JOIN ${ENS_TABLE} ON LOWER(${OWNERS_TAGS_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet)`;

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
        newTypeFilter += 'value > 0';
        break;
      case 'airdrops':
        newTypeFilter += `from_address = ${mysql.escape(NULL_ADDRESS)}`;
        break;
      case 'transfers':
        newTypeFilter += `value = 0 and from_address != ${mysql.escape(
          NULL_ADDRESS
        )}`;
        break;
    }
    if (newTypeFilter) {
      filters = constructFilters(filters, newTypeFilter);
    }
  }

  const fields = `${TRANSACTIONS_MEME_LAB_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON LOWER(${TRANSACTIONS_MEME_LAB_TABLE}.from_address)=LOWER(ens1.wallet) LEFT JOIN ${ENS_TABLE} ens2 ON LOWER(${TRANSACTIONS_MEME_LAB_TABLE}.to_address)=LOWER(ens2.wallet)`;

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
  let results = await execSQL(sql);
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
        newTypeFilter += 'value > 0';
        break;
      case 'airdrops':
        newTypeFilter += `from_address = ${mysql.escape(NULL_ADDRESS)}`;
        break;
      case 'transfers':
        newTypeFilter += `value = 0 and from_address != ${mysql.escape(
          NULL_ADDRESS
        )}`;
        break;
    }
    if (newTypeFilter) {
      filters = constructFilters(filters, newTypeFilter);
    }
  }

  const fields = `${TRANSACTIONS_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON LOWER(${TRANSACTIONS_TABLE}.from_address)=LOWER(ens1.wallet) LEFT JOIN ${ENS_TABLE} ens2 ON LOWER(${TRANSACTIONS_TABLE}.to_address)=LOWER(ens2.wallet)`;

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
  const joins = `LEFT JOIN ${ENS_TABLE} ON LOWER(${WALLETS_TDH_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet)`;

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
    joins = `LEFT JOIN ${ENS_TABLE} ON LOWER(${WALLETS_TDH_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet) CROSS JOIN JSON_TABLE(memes, '$[*]' COLUMNS (
        id INT PATH '$.id',
        tdh DOUBLE PATH '$.tdh',
        tdh__raw varchar(100) PATH '$.tdh__raw',
        balance INT PATH '$.balance'
      )
    ) AS j`;
  } else if (areEqualAddresses(contract, GRADIENT_CONTRACT)) {
    joins = `LEFT JOIN ${ENS_TABLE} ON LOWER(${WALLETS_TDH_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet) CROSS JOIN JSON_TABLE(gradients, '$[*]' COLUMNS (
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
  joins += ` LEFT JOIN ${OWNERS_METRICS_TABLE} on LOWER(${WALLETS_TDH_TABLE}.wallet)=LOWER(${OWNERS_METRICS_TABLE}.wallet)`;

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

  joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_METRICS_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_display`;
  joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_display `;

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

  return fetchPaginated(
    CONSOLIDATED_WALLETS_TDH_TABLE,
    `${sort} ${sortDir}, boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
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
  const joins = `LEFT JOIN ${ENS_TABLE} ON LOWER(${WALLETS_TDH_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet)`;

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
      `LOWER(${OWNERS_METRICS_TABLE}.wallet) in (${mysql.escape(
        wallets.split(',').map((w) => w.toLowerCase())
      )}) OR LOWER(${ENS_TABLE}.display) in (${mysql.escape(
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
    (SELECT COUNT(*) FROM ${OWNERS_TAGS_TABLE} ${OWNERS_TAGS_TABLE}2 WHERE ${OWNERS_TAGS_TABLE}.unique_memes_szn4 = ${OWNERS_TAGS_TABLE}2.unique_memes_szn4) AS dense_rank_unique_memes_season4__ties `;
  }

  const walletsTdhTableSelect = `
    ${WALLETS_TDH_TABLE}.tdh_rank, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn1, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn2, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn3, 
    ${WALLETS_TDH_TABLE}.tdh_rank_memes_szn4, 
    ${WALLETS_TDH_TABLE}.tdh_rank_gradients, 
    ${WALLETS_TDH_TABLE}.boost, 
    ${WALLETS_TDH_TABLE}.boosted_tdh, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season1, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season2, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season3, 
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh_season4, 
    ${WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${WALLETS_TDH_TABLE}.tdh__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season1__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season2__raw, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season3__raw,
    ${WALLETS_TDH_TABLE}.memes_tdh_season4__raw, 
    ${WALLETS_TDH_TABLE}.gradients_tdh__raw, 
    ${WALLETS_TDH_TABLE}.tdh, 
    ${WALLETS_TDH_TABLE}.memes_tdh, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season1, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season2, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season3, 
    ${WALLETS_TDH_TABLE}.memes_tdh_season4, 
    ${WALLETS_TDH_TABLE}.gradients_tdh,
    ${WALLETS_TDH_TABLE}.memes,
    ${WALLETS_TDH_TABLE}.memes_ranks, 
    ${WALLETS_TDH_TABLE}.gradients, 
    ${WALLETS_TDH_TABLE}.gradients_ranks`;

  const fields = ` ${ownerMetricsSelect},${ENS_TABLE}.display as wallet_display, ${walletsTdhTableSelect} , ${OWNERS_TAGS_TABLE}.* `;
  let joins = ` LEFT JOIN ${WALLETS_TDH_TABLE} ON LOWER(${WALLETS_TDH_TABLE}.wallet)=LOWER(${OWNERS_METRICS_TABLE}.wallet) and ${WALLETS_TDH_TABLE}.block=${tdhBlock}`;
  joins += ` LEFT JOIN ${OWNERS_TAGS_TABLE} ON LOWER(${OWNERS_METRICS_TABLE}.wallet)=LOWER(${OWNERS_TAGS_TABLE}.wallet) `;
  joins += ` LEFT JOIN ${ENS_TABLE} ON LOWER(${OWNERS_METRICS_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet) `;

  if (
    sort == 'balance' ||
    sort == 'memes_balance' ||
    sort == 'memes_balance_season1' ||
    sort == 'memes_balance_season2' ||
    sort == 'memes_balance_season3' ||
    sort == 'memes_balance_season4' ||
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
    sort == 'memes_cards_sets_minus1' ||
    sort == 'genesis' ||
    sort == 'unique_memes' ||
    sort == 'unique_memes_szn1' ||
    sort == 'unique_memes_szn2' ||
    sort == 'unique_memes_szn3' ||
    sort == 'unique_memes_szn4'
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
      RANK() OVER(ORDER BY ${OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients, 
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes DESC) AS dense_rank_unique_memes,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn1 DESC) AS dense_rank_unique_memes_season1,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn2 DESC) AS dense_rank_unique_memes_season2,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn3 DESC) AS dense_rank_unique_memes_season3,
      RANK() OVER(ORDER BY ${OWNERS_TAGS_TABLE}.unique_memes_szn4 DESC) AS dense_rank_unique_memes_season4  
      FROM ${OWNERS_METRICS_TABLE} LEFT JOIN ${WALLETS_TDH_TABLE} ON LOWER(${WALLETS_TDH_TABLE}.wallet)=LOWER(${OWNERS_METRICS_TABLE}.wallet) and ${WALLETS_TDH_TABLE}.block=${tdhBlock} LEFT JOIN ${OWNERS_TAGS_TABLE} ON LOWER(${OWNERS_METRICS_TABLE}.wallet)=LOWER(${OWNERS_TAGS_TABLE}.wallet) ${hideWalletFilters}) as dense_table ON ${OWNERS_METRICS_TABLE}.wallet = dense_table.wallet `;
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
      const sql = `SELECT 
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0) AS transfers_out,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0) AS transfers_in,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS purchases_count,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS purchases_value,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS sales_count,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS sales_value,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS sales_count_memes,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS sales_value_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS transfers_out_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS purchases_count_memes,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS purchases_value_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS transfers_in_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS sales_count_memes_season1,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS sales_value_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS transfers_out_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS purchases_count_memes_season1,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS purchases_value_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS transfers_in_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS sales_count_memes_season2,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS sales_value_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS transfers_out_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS purchases_count_memes_season2,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS purchases_value_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS transfers_in_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS sales_count_memes_season3,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS sales_value_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS transfers_out_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS purchases_count_memes_season3,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS purchases_value_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS transfers_in_memes_season3,
      (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS sales_count_memes_season4,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS sales_value_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS transfers_out_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS purchases_count_memes_season4,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS purchases_value_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS transfers_in_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS sales_count_gradients,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS sales_value_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS transfers_out_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS purchases_count_gradients,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS purchases_value_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS transfers_in_gradients`;
      const results2 = await execSQL(sql);
      return {
        count: results2.length,
        page: 1,
        next: null,
        data: results2
      };
    }
  }
  return results;
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
    (SELECT COUNT(*) FROM ${CONSOLIDATED_OWNERS_TAGS_TABLE} ${CONSOLIDATED_OWNERS_TAGS_TABLE}2 WHERE ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn4 = ${CONSOLIDATED_OWNERS_TAGS_TABLE}2.unique_memes_szn4) AS dense_rank_unique_memes_season4__ties `;
  }

  const walletsTdhTableSelect = `
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_memes_szn4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh_rank_gradients, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boost, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season3,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_tdh__raw, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season1, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season2, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season3, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_tdh_season4, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.memes_ranks, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.gradients_ranks`;

  const fields = ` ${ownerMetricsSelect}, ${walletsTdhTableSelect} , ${CONSOLIDATED_OWNERS_TAGS_TABLE}.* `;
  let joins = ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_display`;
  joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_display=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_display `;

  if (
    sort == 'balance' ||
    sort == 'memes_balance' ||
    sort == 'memes_balance_season1' ||
    sort == 'memes_balance_season2' ||
    sort == 'memes_balance_season3' ||
    sort == 'memes_balance_season4' ||
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
    sort == 'memes_cards_sets_minus1' ||
    sort == 'genesis' ||
    sort == 'unique_memes' ||
    sort == 'unique_memes_szn1' ||
    sort == 'unique_memes_szn2' ||
    sort == 'unique_memes_szn3' ||
    sort == 'unique_memes_szn4'
  ) {
    sort = `${CONSOLIDATED_OWNERS_TAGS_TABLE}.${sort}`;
  }

  if (wallets) {
    joins += ` JOIN (
      SELECT ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_display, RANK() OVER(ORDER BY ${sort} DESC) AS dense_rank_sort, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes+${CONSOLIDATED_OWNERS_TAGS_TABLE}.gradients_balance DESC) AS dense_rank_unique,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.balance DESC) AS dense_rank_balance, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance DESC) AS dense_rank_balance_memes, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season1 DESC) AS dense_rank_balance_memes_season1, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season2 DESC) AS dense_rank_balance_memes_season2, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season3 DESC) AS dense_rank_balance_memes_season3, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.memes_balance_season4 DESC) AS dense_rank_balance_memes_season4, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_METRICS_TABLE}.gradients_balance DESC) AS dense_rank_balance_gradients, 
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes DESC) AS dense_rank_unique_memes,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn1 DESC) AS dense_rank_unique_memes_season1,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn2 DESC) AS dense_rank_unique_memes_season2,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn3 DESC) AS dense_rank_unique_memes_season3,
        RANK() OVER(ORDER BY ${CONSOLIDATED_OWNERS_TAGS_TABLE}.unique_memes_szn4 DESC) AS dense_rank_unique_memes_season4 
      FROM ${CONSOLIDATED_OWNERS_METRICS_TABLE} 
        LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display=${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_display LEFT JOIN ${CONSOLIDATED_OWNERS_TAGS_TABLE} ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_display=${CONSOLIDATED_OWNERS_TAGS_TABLE}.consolidation_display ${hideWalletFilters}) 
      AS dense_table ON ${CONSOLIDATED_OWNERS_METRICS_TABLE}.consolidation_display = dense_table.consolidation_display `;
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
      const sql = `SELECT 
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0) AS transfers_out,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0) AS transfers_in,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS purchases_count,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS purchases_value,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS sales_count,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS sales_value,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS sales_count_memes,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS sales_value_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS transfers_out_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS purchases_count_memes,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS purchases_value_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )}) AS transfers_in_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS sales_count_memes_season1,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS sales_value_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS transfers_out_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS purchases_count_memes_season1,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS purchases_value_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id <= ${SZN1_INDEX.end}) AS transfers_in_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS sales_count_memes_season2,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS sales_value_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS transfers_out_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS purchases_count_memes_season2,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS purchases_value_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
        SZN2_INDEX.end
      }) AS transfers_in_memes_season2,
      (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS sales_count_memes_season3,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS sales_value_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS transfers_out_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS purchases_count_memes_season3,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS purchases_value_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
        SZN3_INDEX.end
      }) AS transfers_in_memes_season3,
      (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS sales_count_memes_season4,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS sales_value_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS transfers_out_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS purchases_count_memes_season4,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS purchases_value_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        MEMES_CONTRACT
      )} AND token_id > ${SZN3_INDEX.end}) AS transfers_in_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS sales_count_gradients,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS sales_value_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS transfers_out_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS purchases_count_gradients,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS purchases_value_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
        GRADIENT_CONTRACT
      )}) AS transfers_in_gradients`;
      const results2 = await execSQL(sql);
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

  let joins = ` LEFT JOIN ${ENS_TABLE} ON LOWER(${DISTRIBUTION_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet) `;

  let transactionsTable = TRANSACTIONS_TABLE;
  if (areEqualAddresses(contract, MEMELAB_CONTRACT)) {
    transactionsTable = TRANSACTIONS_MEME_LAB_TABLE;
  }

  joins += ` LEFT JOIN ${transactionsTable} ON ${DISTRIBUTION_TABLE}.contract = ${transactionsTable}.contract AND ${DISTRIBUTION_TABLE}.card_id = ${transactionsTable}.token_id AND (${transactionsTable}.from_address=${mysql.escape(
    MANIFOLD
  )} OR ${transactionsTable}.from_address=${mysql.escape(
    NULL_ADDRESS
  )}) AND LOWER(${DISTRIBUTION_TABLE}.wallet)=LOWER(${transactionsTable}.to_address)`;

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
  pageSize: number,
  page: number
) {
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

  let joins = `LEFT JOIN ${NFTS_TABLE} ON ${DISTRIBUTION_TABLE}.card_id=${NFTS_TABLE}.id AND ${DISTRIBUTION_TABLE}.contract=${NFTS_TABLE}.contract`;
  joins += ` LEFT JOIN ${NFTS_MEME_LAB_TABLE} ON ${DISTRIBUTION_TABLE}.card_id=${NFTS_MEME_LAB_TABLE}.id AND ${DISTRIBUTION_TABLE}.contract=${NFTS_MEME_LAB_TABLE}.contract`;
  joins += ` LEFT JOIN ${TRANSACTIONS_TABLE} ON ${DISTRIBUTION_TABLE}.contract = ${TRANSACTIONS_TABLE}.contract AND ${DISTRIBUTION_TABLE}.card_id = ${TRANSACTIONS_TABLE}.token_id AND (${TRANSACTIONS_TABLE}.from_address=${mysql.escape(
    MANIFOLD
  )} OR ${TRANSACTIONS_TABLE}.from_address=${mysql.escape(
    NULL_ADDRESS
  )}) AND LOWER(${DISTRIBUTION_TABLE}.wallet)=LOWER(${TRANSACTIONS_TABLE}.to_address)`;
  joins += ` LEFT JOIN ${TRANSACTIONS_MEME_LAB_TABLE} ON ${DISTRIBUTION_TABLE}.contract = ${TRANSACTIONS_MEME_LAB_TABLE}.contract AND ${DISTRIBUTION_TABLE}.card_id = ${TRANSACTIONS_MEME_LAB_TABLE}.token_id AND (${TRANSACTIONS_MEME_LAB_TABLE}.from_address=${mysql.escape(
    MANIFOLD
  )} OR ${TRANSACTIONS_MEME_LAB_TABLE}.from_address=${mysql.escape(
    NULL_ADDRESS
  )}) AND LOWER(${DISTRIBUTION_TABLE}.wallet)=LOWER(${TRANSACTIONS_MEME_LAB_TABLE}.to_address)`;
  joins += ` LEFT JOIN ${ENS_TABLE} ON LOWER(${DISTRIBUTION_TABLE}.wallet)=LOWER(${ENS_TABLE}.wallet) `;

  return fetchPaginated(
    DISTRIBUTION_TABLE,
    `card_mint_date desc`,
    pageSize,
    page,
    filters,
    `${DISTRIBUTION_TABLE}.*,
      COALESCE(${NFTS_TABLE}.name, ${NFTS_MEME_LAB_TABLE}.name) AS card_name, 
      COALESCE(${NFTS_TABLE}.mint_date, ${NFTS_MEME_LAB_TABLE}.mint_date, ${DISTRIBUTION_TABLE}.created_at) AS card_mint_date,
      COALESCE(SUM(${TRANSACTIONS_TABLE}.token_count), SUM(${TRANSACTIONS_MEME_LAB_TABLE}.token_count), 0) AS card_mint_count,
      ${ENS_TABLE}.display`,
    joins,
    `${DISTRIBUTION_TABLE}.wallet, ${DISTRIBUTION_TABLE}.created_at, ${DISTRIBUTION_TABLE}.updated_at, ${DISTRIBUTION_TABLE}.phase, ${DISTRIBUTION_TABLE}.id, ${ENS_TABLE}.display`
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
    sql += ` LEFT JOIN ${ENS_TABLE} e1 ON LOWER(${CONSOLIDATIONS_TABLE}.wallet1)=LOWER(e1.wallet)`;
    sql += ` LEFT JOIN ${ENS_TABLE} e2 ON LOWER(${CONSOLIDATIONS_TABLE}.wallet2)=LOWER(e2.wallet)`;
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
    'consolidation_display, wallets'
  );

  await Promise.all(
    results.data.map(async (d: any) => {
      d.primary = await fetchPrimaryWallet(JSON.parse(d.wallets));
    })
  );

  return results;
}

export async function fetchDelegations(
  wallet: string,
  pageSize: number,
  page: number
) {
  const filter = `WHERE from_address = ${mysql.escape(
    wallet
  )} OR to_address = ${mysql.escape(wallet)}`;

  let joins = `LEFT JOIN ${ENS_TABLE} e1 ON LOWER(${DELEGATIONS_TABLE}.from_address)=LOWER(e1.wallet)`;
  joins += ` LEFT JOIN ${ENS_TABLE} e2 ON LOWER(${DELEGATIONS_TABLE}.to_address)=LOWER(e2.wallet)`;

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
  let filter = constructFilters(
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
  tokenType: string
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

  return fetchPaginated(
    REMEMES_TABLE,
    ` RAND() `,
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
