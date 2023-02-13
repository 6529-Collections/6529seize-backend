import {
  TDH_BLOCKS_TABLE,
  TRANSACTIONS_TABLE,
  NFTS_TABLE,
  ARTISTS_TABLE,
  MEMES_EXTENDED_DATA_TABLE,
  OWNERS_TABLE,
  OWNERS_TAGS_TABLE,
  WALLETS_TDH_TABLE,
  UPLOADS_TABLE,
  ENS_TABLE,
  TRANSACTIONS_REMAKE_TABLE,
  OWNERS_METRICS_TABLE,
  NULL_ADDRESS,
  MANIFOLD,
  NFTS_MEME_LAB_TABLE,
  TRANSACTIONS_MEME_LAB_TABLE,
  OWNERS_MEME_LAB_TABLE
} from './constants';
import { Artist } from './entities/IArtist';
import { ENS } from './entities/IENS';
import {
  BaseNFT,
  MemesExtendedData,
  NFT,
  NftTDH,
  NFTWithTDH
} from './entities/INFT';
import { Owner, OwnerMetric, OwnerTags } from './entities/IOwner';
import { TDH } from './entities/ITDH';
import { Transaction } from './entities/ITransaction';

const mysql = require('mysql');

let mysql_pool: any;

export async function connect() {
  console.log('[DATABASE]', `[DB HOST ${process.env.DB_HOST}]`);

  mysql_pool = mysql.createPool({
    connectionLimit: 10,
    connectTimeout: 30 * 1000,
    acquireTimeout: 30 * 1000,
    timeout: 30 * 1000,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    charset: 'utf8mb4',
    database: process.env.DB_NAME
  });

  console.log('[DATABASE]', `[CONNECTION POOL CREATED]`);
}

export async function addColumnToTable(
  table: string,
  column: string,
  type: string
) {
  const sql1 = `SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ${mysql.escape(
    table
  )} AND COLUMN_NAME = ${mysql.escape(column)} `;
  const r1 = await execSQL(sql1);

  if (r1.length > 0) {
    console.log(`[DB]`, `[COLUMN EXISTS ${table}.${column}]`);
  } else {
    const sql2 = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;
    await execSQL(sql2);
    console.log(`[DB]`, `[COLUMN CREATED ${table}.${column}]`);
  }
}

export async function addIconColumnToNfts() {
  await addColumnToTable(NFTS_TABLE, 'icon', 'TEXT NOT NULL');
}

export async function addMemeLabColumnToArtists() {
  await addColumnToTable(ARTISTS_TABLE, 'memelab', 'JSON');
}

export async function createMemeLabNftsTable() {
  const sql = `CREATE TABLE IF NOT EXISTS ${NFTS_MEME_LAB_TABLE} (
    id INT NOT NULL , 
    contract VARCHAR(50) NOT NULL , 
    created_at DATETIME NOT NULL DEFAULT now(), 
    mint_date DATETIME NOT NULL , 
    mint_price DOUBLE NOT NULL , 
    supply INT NOT NULL , 
    name TEXT NOT NULL , 
    collection TEXT NOT NULL , 
    token_type TEXT NOT NULL , 
    description TEXT NOT NULL , 
    artist TEXT NOT NULL , 
    uri TEXT NOT NULL , 
    icon TEXT NOT NULL , 
    thumbnail TEXT NOT NULL , 
    scaled TEXT NOT NULL , 
    compressed_animation TEXT ,
    image TEXT NOT NULL , 
    animation TEXT , 
    metadata JSON NOT NULL , 
    PRIMARY KEY (id, contract)
  ) ENGINE = InnoDB;`;
  await execSQL(sql);
}

export async function createMemeLabTransactionsTable() {
  const sql = `CREATE TABLE IF NOT EXISTS ${TRANSACTIONS_MEME_LAB_TABLE} LIKE ${TRANSACTIONS_TABLE};`;
  await execSQL(sql);
}

export async function createMemeLabOwnersTable() {
  const sql = `CREATE TABLE IF NOT EXISTS ${OWNERS_MEME_LAB_TABLE} LIKE ${OWNERS_TABLE};`;
  await execSQL(sql);
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

export async function fetchLastUpload(): Promise<any> {
  let sql = `SELECT * FROM ${UPLOADS_TABLE} ORDER BY date DESC LIMIT 1;`;
  const results = await execSQL(sql);
  return results ? results[0] : [];
}

export async function fetchLastOwnerMetrics(): Promise<any> {
  let sql = `SELECT created_at FROM ${OWNERS_METRICS_TABLE} ORDER BY created_at DESC LIMIT 1;`;
  const results = await execSQL(sql);
  return results ? results[0].created_at : [];
}

export async function findReplayTransactions(): Promise<Transaction[]> {
  let sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE value=0 AND from_address != ${mysql.escape(
    NULL_ADDRESS
  )};`;
  const results = await execSQL(sql);
  return results;
}

export async function findDuplicateTransactionHashes(): Promise<string[]> {
  let sql = `SELECT transaction FROM ${TRANSACTIONS_TABLE} GROUP BY transaction HAVING COUNT(*) > 1;`;
  const results = await execSQL(sql);
  const hashes: string[] = results.map((r: Transaction) => r.transaction);
  return hashes;
}

export async function findTransactionsByHash(
  hashes: string[]
): Promise<Transaction[]> {
  let sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE transaction in (${mysql.escape(
    hashes
  )}) ORDER BY transaction_date DESC;`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchLatestLabTransactionsBlockNumber(beforeDate?: Date) {
  let sql = `SELECT block FROM ${TRANSACTIONS_MEME_LAB_TABLE}`;
  if (beforeDate) {
    sql += ` WHERE UNIX_TIMESTAMP(transaction_date) <= ${
      beforeDate.getTime() / 1000
    }`;
  }
  sql += ` order by block desc limit 1;`;
  const r = await execSQL(sql);
  return r.length > 0 ? r[0].block : 0;
}

export async function fetchLatestTransactionsBlockNumber(beforeDate?: Date) {
  let sql = `SELECT block FROM ${TRANSACTIONS_TABLE}`;
  if (beforeDate) {
    sql += ` WHERE UNIX_TIMESTAMP(transaction_date) <= ${
      beforeDate.getTime() / 1000
    }`;
  }
  sql += ` order by block desc limit 1;`;
  const r = await execSQL(sql);
  return r.length > 0 ? r[0].block : 0;
}

export async function fetchLatestTDHBDate() {
  let sql = `SELECT timestamp FROM ${TDH_BLOCKS_TABLE} order by block_number desc limit 1;`;
  const r = await execSQL(sql);
  return r.length > 0 ? r[0].timestamp : 0;
}

export async function fetchLatestTDHBlockNumber() {
  let sql = `SELECT block_number FROM ${TDH_BLOCKS_TABLE} order by block_number desc limit 1;`;
  const r = await execSQL(sql);
  return r.length > 0 ? r[0].block_number : 0;
}

export async function fetchAllTransactions() {
  let sql = `SELECT * FROM ${TRANSACTIONS_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllMemeLabTransactions() {
  let sql = `SELECT * FROM ${TRANSACTIONS_MEME_LAB_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchNftsForContract(contract: string, orderBy?: string) {
  let sql = `SELECT * from ${NFTS_TABLE} WHERE contract=${mysql.escape(
    contract
  )}`;
  if (orderBy) {
    sql += ` order by ${orderBy}`;
  }
  const results = await execSQL(sql);
  return results;
}

export async function fetchTransactionsWithoutValue(
  pageSize: number,
  page: number
) {
  const offset = pageSize * (page - 1);
  let sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE value=0 LIMIT ${pageSize} OFFSET ${offset};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllMemeLabNFTs() {
  let sql = `SELECT * FROM ${NFTS_MEME_LAB_TABLE};`;
  const results = await execSQL(sql);
  results.map((r: any) => (r.metadata = JSON.parse(r.metadata)));
  return results;
}

export async function fetchAllNFTs() {
  let sql = `SELECT * FROM ${NFTS_TABLE};`;
  const results = await execSQL(sql);
  results.map((r: any) => (r.metadata = JSON.parse(r.metadata)));
  return results;
}

export async function fetchAllTDH() {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  let sql = `SELECT ${ENS_TABLE}.display as ens, ${WALLETS_TDH_TABLE}.* FROM ${WALLETS_TDH_TABLE} LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet WHERE block=${tdhBlock};`;
  const results = await execSQL(sql);
  results.map((r: any) => (r.memes = JSON.parse(r.memes)));
  results.map((r: any) => (r.gradients = JSON.parse(r.gradients)));
  return results;
}

export async function fetchAllArtists() {
  let sql = `SELECT * FROM ${ARTISTS_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllLabOwners() {
  let sql = `SELECT * FROM ${OWNERS_MEME_LAB_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllOwners() {
  let sql = `SELECT * FROM ${OWNERS_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchWalletsFromTransactions(datetime: Date | undefined) {
  let sql = `SELECT DISTINCT COALESCE(from_address, to_address) AS wallet FROM ${TRANSACTIONS_TABLE} `;
  if (datetime) {
    sql += ` WHERE ${TRANSACTIONS_TABLE}.transaction_date >= ${mysql.escape(
      datetime
    )}`;
  }
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllOwnersAddresses() {
  let sql = `SELECT distinct wallet FROM ${OWNERS_TABLE} WHERE wallet != ${mysql.escape(
    NULL_ADDRESS
  )} AND wallet != ${mysql.escape(MANIFOLD)};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllOwnerMetrics() {
  let sql = `SELECT * FROM ${OWNERS_METRICS_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchWalletTransactions(wallet: string, block?: number) {
  let sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE (from_address = ${mysql.escape(
    wallet
  )} OR to_address = ${mysql.escape(wallet)})`;
  if (block) {
    sql += ` AND block <= ${block}`;
  }
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllOwnerTags() {
  let sql = `SELECT * FROM ${OWNERS_TAGS_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchEnsRefresh() {
  let sql = `SELECT * FROM ${ENS_TABLE} WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY created_at ASC LIMIT 200;`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchMissingEns(datetime?: Date) {
  let sql = `SELECT DISTINCT COALESCE(from_address, to_address) AS address  FROM ${TRANSACTIONS_TABLE} WHERE COALESCE(from_address, to_address) NOT IN (SELECT wallet FROM ${ENS_TABLE}) `;
  if (datetime) {
    sql += ` AND ${TRANSACTIONS_TABLE}.created_at > ${mysql.escape(datetime)}`;
  }
  sql += ` LIMIT 200`;

  const results = await execSQL(sql);

  const structuredResults = results.map((r: any) => r.address);

  return structuredResults;
}

export async function persistTransactions(
  transactions: Transaction[],
  isLab?: boolean
) {
  if (transactions.length > 0) {
    console.log(
      new Date(),
      '[TRANSACTIONS]',
      `[PERSISTING ${transactions.length} TRANSACTIONS]`
    );
    await Promise.all(
      transactions.map(async (t) => {
        let sql = `REPLACE INTO ${
          isLab ? TRANSACTIONS_MEME_LAB_TABLE : TRANSACTIONS_TABLE
        } SET transaction=${mysql.escape(t.transaction)}, block=${
          t.block
        }, transaction_date=${mysql.escape(
          t.transaction_date
        )}, from_address=${mysql.escape(
          t.from_address
        )}, to_address=${mysql.escape(t.to_address)}, contract=${mysql.escape(
          t.contract
        )}, token_id=${t.token_id}, token_count=${t.token_count}, value=${
          t.value
        }`;
        await execSQL(sql);
      })
    );
    console.log(
      new Date(),
      '[TRANSACTIONS]',
      `[ALL ${transactions.length} TRANSACTIONS PERSISTED]`
    );
  }
}

export async function persistTransactionsREMAKE(transactions: Transaction[]) {
  if (transactions.length > 0) {
    console.log(
      new Date(),
      '[TRANSACTIONS REMAKE]',
      `[PERSISTING ${transactions.length} TRANSACTIONS]`
    );
    await Promise.all(
      transactions.map(async (t) => {
        let sql = `REPLACE INTO ${TRANSACTIONS_REMAKE_TABLE} SET transaction=${mysql.escape(
          t.transaction
        )}, block=${t.block}, transaction_date=${mysql.escape(
          t.transaction_date
        )}, from_address=${mysql.escape(
          t.from_address
        )}, to_address=${mysql.escape(t.to_address)}, contract=${mysql.escape(
          t.contract
        )}, token_id=${t.token_id}, token_count=${t.token_count}, value=${
          t.value
        }`;
        await execSQL(sql);
      })
    );
    console.log(
      new Date(),
      '[TRANSACTIONS REMAKE]',
      `[ALL ${transactions.length} TRANSACTIONS PERSISTED]`
    );
  }
}

export async function persistLabNFTS(nfts: BaseNFT[]) {
  if (nfts.length > 0) {
    console.log('[NFTS]', `[PERSISTING ${nfts.length} NFTS]`);
    await Promise.all(
      nfts.map(async (nft) => {
        let sql = `REPLACE INTO ${NFTS_MEME_LAB_TABLE} SET id=${
          nft.id
        }, created_at=${mysql.escape(new Date())}, contract=${mysql.escape(
          nft.contract
        )}, mint_date=${mysql.escape(new Date(nft.mint_date))}, mint_price=${
          nft.mint_price
        }, supply=${nft.supply}, name=${mysql.escape(
          nft.name
        )}, collection=${mysql.escape(
          nft.collection
        )}, token_type=${mysql.escape(
          nft.token_type
        )}, description=${mysql.escape(nft.description)}, artist=${mysql.escape(
          nft.artist
        )}, uri=${mysql.escape(nft.uri)}, icon=${mysql.escape(
          nft.icon
        )}, thumbnail=${mysql.escape(nft.thumbnail)}, scaled=${mysql.escape(
          nft.scaled
        )}, image=${mysql.escape(
          nft.image
        )}, compressed_animation=${mysql.escape(
          nft.compressed_animation
        )}, animation=${mysql.escape(nft.animation)}, metadata=${mysql.escape(
          JSON.stringify(nft.metadata)
        )}`;
        await execSQL(sql);
      })
    );
    console.log(
      new Date(),
      '[NFTS]',
      `[ALL ${nfts.length} NEW NFTS PERSISTED]`
    );
  }
}

export async function persistNFTS(nfts: NFTWithTDH[]) {
  if (nfts.length > 0) {
    console.log('[NFTS]', `[PERSISTING ${nfts.length} NFTS]`);
    await Promise.all(
      nfts.map(async (nft) => {
        let sql = `REPLACE INTO ${NFTS_TABLE} SET id=${
          nft.id
        }, created_at=${mysql.escape(new Date())}, contract=${mysql.escape(
          nft.contract
        )}, mint_date=${mysql.escape(new Date(nft.mint_date))}, mint_price=${
          nft.mint_price
        }, supply=${nft.supply}, name=${mysql.escape(
          nft.name
        )}, collection=${mysql.escape(
          nft.collection
        )}, token_type=${mysql.escape(nft.token_type)}, hodl_rate=${
          nft.hodl_rate
        }, description=${mysql.escape(nft.description)}, artist=${mysql.escape(
          nft.artist
        )}, uri=${mysql.escape(nft.uri)}, icon=${mysql.escape(
          nft.icon
        )}, thumbnail=${mysql.escape(nft.thumbnail)}, scaled=${mysql.escape(
          nft.scaled
        )}, image=${mysql.escape(
          nft.image
        )}, compressed_animation=${mysql.escape(
          nft.compressed_animation
        )}, animation=${mysql.escape(nft.animation)}, metadata=${mysql.escape(
          JSON.stringify(nft.metadata)
        )}, tdh = ${nft.tdh}, tdh_rank = ${nft.tdh_rank}, tdh__raw = ${
          nft.tdh__raw
        }, market_cap = ${nft.market_cap}, floor_price = ${nft.floor_price}`;
        await execSQL(sql);
      })
    );
    console.log(
      new Date(),
      '[NFTS]',
      `[ALL ${nfts.length} NEW NFTS PERSISTED]`
    );
  }
}

export async function persistArtists(artists: Artist[]) {
  if (artists.length > 0) {
    console.log(
      new Date(),
      '[ARTISTS]',
      `[PERSISTING ${artists.length} ARTISTS]`
    );
    await Promise.all(
      artists.map(async (artist) => {
        let sql = `REPLACE INTO ${ARTISTS_TABLE} SET name=${mysql.escape(
          artist.name
        )}, created_at=${mysql.escape(new Date())}, memes=${mysql.escape(
          JSON.stringify(artist.memes)
        )}, gradients=${mysql.escape(
          JSON.stringify(artist.gradients)
        )}, memelab=${mysql.escape(
          JSON.stringify(artist.memelab)
        )}, bio=${mysql.escape(artist.bio)}, pfp=${mysql.escape(
          artist.pfp
        )}, work=${mysql.escape(
          JSON.stringify(artist.work)
        )}, social_links=${mysql.escape(JSON.stringify(artist.social_links))}`;
        await execSQL(sql);
      })
    );
    console.log(
      new Date(),
      '[ARTISTS]',
      `[ALL ${artists.length} ARTISTS PERSISTED]`
    );
  }
}

export async function persistOwners(owners: Owner[], isLab?: boolean) {
  if (owners.length > 0) {
    console.log('[OWNERS]', `[PERSISTING ${owners.length} OWNERS]`);

    await Promise.all(
      owners.map(async (owner) => {
        let sql;
        if (0 >= owner.balance) {
          sql = `DELETE FROM ${
            isLab ? OWNERS_MEME_LAB_TABLE : OWNERS_TABLE
          } WHERE wallet=${mysql.escape(owner.wallet)} AND token_id=${
            owner.token_id
          } AND contract=${mysql.escape(owner.contract)}`;
        } else {
          sql = `REPLACE INTO ${
            isLab ? OWNERS_MEME_LAB_TABLE : OWNERS_TABLE
          } SET created_at=${mysql.escape(new Date())}, wallet=${mysql.escape(
            owner.wallet
          )}, token_id=${owner.token_id}, contract=${mysql.escape(
            owner.contract
          )}, balance=${owner.balance}`;
        }

        await execSQL(sql);
      })
    );

    console.log(
      new Date(),
      '[OWNERS]',
      `[ALL ${owners.length} OWNERS PERSISTED]`
    );
  }
}

export async function persistOwnerMetrics(ownerMetrics: OwnerMetric[]) {
  if (ownerMetrics.length > 0) {
    console.log(
      new Date(),
      '[OWNERS METRICS]',
      `[PERSISTING ${ownerMetrics.length} WALLETS]`
    );

    await Promise.all(
      ownerMetrics.map(async (ownerMetric) => {
        let sql;
        if (0 >= ownerMetric.balance) {
          sql = `DELETE FROM ${OWNERS_METRICS_TABLE} WHERE wallet=${mysql.escape(
            ownerMetric.wallet
          )}`;
        } else {
          sql = `REPLACE INTO ${OWNERS_METRICS_TABLE} SET created_at=${mysql.escape(
            new Date()
          )}, wallet=${mysql.escape(ownerMetric.wallet)}, balance=${
            ownerMetric.balance
          }, memes_balance=${
            ownerMetric.memes_balance
          }, memes_balance_season1=${
            ownerMetric.memes_balance_season1
          }, memes_balance_season2=${
            ownerMetric.memes_balance_season2
          }, gradients_balance=${
            ownerMetric.gradients_balance
          }, purchases_value=${ownerMetric.purchases_value}, purchases_count=${
            ownerMetric.purchases_count
          }, purchases_value_memes=${
            ownerMetric.purchases_value_memes
          }, purchases_count_memes=${
            ownerMetric.purchases_count_memes
          }, purchases_value_memes_season1=${
            ownerMetric.purchases_value_memes_season1
          }, purchases_count_memes_season1=${
            ownerMetric.purchases_count_memes_season1
          }, purchases_value_memes_season2=${
            ownerMetric.purchases_value_memes_season2
          }, purchases_count_memes_season2=${
            ownerMetric.purchases_count_memes_season2
          }, purchases_value_gradients=${
            ownerMetric.purchases_value_gradients
          }, purchases_count_gradients=${
            ownerMetric.purchases_count_gradients
          }, purchases_value_primary=${
            ownerMetric.purchases_value_primary
          }, purchases_count_primary=${
            ownerMetric.purchases_count_primary
          }, purchases_value_primary_memes=${
            ownerMetric.purchases_value_primary_memes
          }, purchases_count_primary_memes=${
            ownerMetric.purchases_count_primary_memes
          }, purchases_value_primary_memes_season1=${
            ownerMetric.purchases_value_primary_memes_season1
          }, purchases_count_primary_memes_season1=${
            ownerMetric.purchases_count_primary_memes_season1
          }, purchases_value_primary_memes_season2=${
            ownerMetric.purchases_value_primary_memes_season2
          }, purchases_count_primary_memes_season2=${
            ownerMetric.purchases_count_primary_memes_season2
          }, purchases_value_primary_gradients=${
            ownerMetric.purchases_value_primary_gradients
          }, purchases_count_primary_gradients=${
            ownerMetric.purchases_count_primary_gradients
          }, purchases_value_secondary=${
            ownerMetric.purchases_value_secondary
          }, purchases_count_secondary=${
            ownerMetric.purchases_count_secondary
          }, purchases_value_secondary_memes=${
            ownerMetric.purchases_value_secondary_memes
          }, purchases_count_secondary_memes=${
            ownerMetric.purchases_count_secondary_memes
          }, purchases_value_secondary_memes_season1=${
            ownerMetric.purchases_value_secondary_memes_season1
          }, purchases_count_secondary_memes_season1=${
            ownerMetric.purchases_count_secondary_memes_season1
          }, purchases_value_secondary_memes_season2=${
            ownerMetric.purchases_value_secondary_memes_season2
          }, purchases_count_secondary_memes_season2=${
            ownerMetric.purchases_count_secondary_memes_season2
          }, purchases_value_secondary_gradients=${
            ownerMetric.purchases_value_secondary_gradients
          }, purchases_count_secondary_gradients=${
            ownerMetric.purchases_count_secondary_gradients
          }, sales_value=${ownerMetric.sales_value}, sales_count=${
            ownerMetric.sales_count
          }, sales_value_memes=${
            ownerMetric.sales_value_memes
          }, sales_count_memes=${
            ownerMetric.sales_count_memes
          }, sales_value_memes_season1=${
            ownerMetric.sales_value_memes_season1
          }, sales_count_memes_season1=${
            ownerMetric.sales_count_memes_season1
          }, sales_value_memes_season2=${
            ownerMetric.sales_value_memes_season2
          }, sales_count_memes_season2=${
            ownerMetric.sales_count_memes_season2
          }, sales_value_gradients=${
            ownerMetric.sales_value_gradients
          }, sales_count_gradients=${
            ownerMetric.sales_count_gradients
          }, transfers_in=${ownerMetric.transfers_in}, transfers_out=${
            ownerMetric.transfers_out
          }, transfers_in_memes=${
            ownerMetric.transfers_in_memes
          }, transfers_out_memes=${
            ownerMetric.transfers_out_memes
          }, transfers_in_memes_season1=${
            ownerMetric.transfers_in_memes_season1
          }, transfers_out_memes_season1=${
            ownerMetric.transfers_out_memes_season1
          }, transfers_in_memes_season2=${
            ownerMetric.transfers_in_memes_season2
          }, transfers_out_memes_season2=${
            ownerMetric.transfers_out_memes_season2
          }, transfers_in_gradients=${
            ownerMetric.transfers_in_gradients
          }, transfers_out_gradients=${ownerMetric.transfers_out_gradients}`;
        }

        await execSQL(sql);
      })
    );

    console.log(
      new Date(),
      '[OWNERS METRICS]',
      `[ALL ${ownerMetrics.length} WALLETS PERSISTED]`
    );
  }
}

export async function persistOwnerTags(ownersTags: OwnerTags[]) {
  if (ownersTags.length > 0) {
    console.log(
      new Date(),
      '[OWNERS TAGS]',
      `[PERSISTING ${ownersTags.length} WALLETS]`
    );

    await Promise.all(
      ownersTags.map(async (owner) => {
        let sql;
        if (0 >= owner.memes_balance && 0 >= owner.gradients_balance) {
          sql = `DELETE FROM ${OWNERS_TAGS_TABLE} WHERE wallet=${mysql.escape(
            owner.wallet
          )}`;
        } else {
          sql = `REPLACE INTO ${OWNERS_TAGS_TABLE} SET created_at=${mysql.escape(
            new Date()
          )}, wallet=${mysql.escape(owner.wallet)}, memes_balance=${
            owner.memes_balance
          }, unique_memes=${owner.unique_memes}, unique_memes_szn1=${
            owner.unique_memes_szn1
          }, unique_memes_szn2=${owner.unique_memes_szn2}, gradients_balance=${
            owner.gradients_balance
          }, genesis=${owner.genesis}, nakamoto=${
            owner.nakamoto
          }, memes_cards_sets=${
            owner.memes_cards_sets
          }, memes_cards_sets_minus1=${
            owner.memes_cards_sets_minus1
          }, memes_cards_sets_minus2=${
            owner.memes_cards_sets_minus2
          }, memes_cards_sets_szn1=${
            owner.memes_cards_sets_szn1
          }, memes_cards_sets_szn2=${owner.memes_cards_sets_szn2}`;
        }

        await execSQL(sql);
      })
    );

    console.log(
      new Date(),
      '[OWNERS TAGS]',
      `[ALL ${ownersTags.length} WALLETS PERSISTED]`
    );
  }
}

export async function persistMemesExtendedData(data: MemesExtendedData[]) {
  if (data.length > 0) {
    console.log(
      new Date(),
      '[MEMES EXTENDED DATA]',
      `[PERSISTING ${data.length} MEMES EXTENDED DATA]`
    );
    await Promise.all(
      data.map(async (md) => {
        let sql = `REPLACE INTO ${MEMES_EXTENDED_DATA_TABLE} SET id=${
          md.id
        }, created_at=${mysql.escape(new Date())}, season=${md.season}, meme=${
          md.meme
        }, meme_name=${mysql.escape(md.meme_name)}, collection_size=${
          md.collection_size
        }, edition_size=${md.edition_size}, edition_size_rank=${
          md.edition_size_rank
        }, museum_holdings=${md.museum_holdings}, museum_holdings_rank=${
          md.museum_holdings_rank
        }, edition_size_cleaned=${
          md.edition_size_cleaned
        }, edition_size_cleaned_rank=${md.edition_size_cleaned_rank}, hodlers=${
          md.hodlers
        }, hodlers_rank=${md.hodlers_rank}, percent_unique=${
          md.percent_unique
        }, percent_unique_rank=${
          md.percent_unique_rank
        }, percent_unique_cleaned=${
          md.percent_unique_cleaned
        }, percent_unique_cleaned_rank=${md.percent_unique_cleaned_rank}`;
        await execSQL(sql);
      })
    );
    console.log(
      new Date(),
      '[MEMES EXTENDED DATA]',
      `[ALL ${data.length} MEMES EXTENDED DATA PERSISTED]`
    );
  }
}

export async function persistNftMarketStats(stats: any[]) {
  await Promise.all(
    stats.map(async (s) => {
      const sql = `UPDATE ${NFTS_TABLE} SET 
            market_cap = ${s.market_cap}, floor_price=${
        s.floor_price
      } WHERE contract=${mysql.escape(s.contract)} AND id=${s.id}`;
      await execSQL(sql);
    })
  );
}

export async function persistNftTdh(nftTdh: NftTDH[]) {
  console.log(
    new Date(),
    '[NFT TDH]',
    `PERSISTING NFTS TDH [${nftTdh.length}]`
  );
  await Promise.all(
    nftTdh.map(async (n) => {
      const sql = `UPDATE ${NFTS_TABLE} SET 
            tdh = ${n.tdh}, tdh_rank = ${n.tdh_rank}, tdh__raw = ${
        n.tdh__raw
      } WHERE contract=${mysql.escape(n.contract)} AND id=${n.id}`;
      await execSQL(sql);
    })
  );

  console.log(
    new Date(),
    '[NFT TDH]',
    `PERSISTED ALL NFTS TDH [${nftTdh.length}]`
  );
}

export async function persistTdhUpload(
  block: number,
  dateString: string,
  location: string
) {
  const sql = `REPLACE INTO ${UPLOADS_TABLE} SET 
    date = ${mysql.escape(dateString)},
    block = ${block},
    tdh = ${mysql.escape(location)}`;
  await execSQL(sql);

  console.log('[TDH UPLOAD PERSISTED]');
}

export async function persistTDH(block: number, timestamp: Date, tdh: TDH[]) {
  console.log('[TDH]', `PERSISTING WALLETS TDH [${tdh.length}]`);

  const sortedTdh = tdh.sort((a: TDH, b: TDH) => {
    if (a.tdh > b.tdh) return -1;
    else if (a.tdh < b.tdh) return 1;
    else if (a.memes_tdh_season1 > b.memes_tdh_season1) return -1;
    else if (a.memes_tdh_season1 < b.memes_tdh_season1) return 1;
    else if (a.gradients_tdh > b.gradients_tdh) return -1;
    else if (a.gradients_tdh < b.gradients_tdh) return 1;
    else return -1;
  });
  await Promise.all(
    sortedTdh.map(async (t) => {
      const wallet = mysql.escape(t.wallet);
      const tdh_rank = t.tdh_rank;
      const tdh_rank_memes = t.tdh_rank_memes;
      const tdh_rank_memes_szn1 = t.tdh_rank_memes_szn1;
      const tdh_rank_memes_szn2 = t.tdh_rank_memes_szn2;
      const tdh_rank_gradients = t.tdh_rank_gradients;
      const tdh = t.tdh;
      const boost = t.boost;
      const boosted_tdh = t.boosted_tdh;
      const tdh__raw = t.tdh__raw;
      const balance = t.balance;
      const memes_cards_sets = t.memes_cards_sets;
      const genesis = t.genesis;
      const unique_memes = t.unique_memes;
      const boosted_memes_tdh = t.boosted_memes_tdh;
      const memes_tdh = t.memes_tdh;
      const memes_tdh__raw = t.memes_tdh__raw;
      const memes_balance = t.memes_balance;
      const boosted_memes_tdh_season1 = t.boosted_memes_tdh_season1;
      const memes_tdh_season1 = t.memes_tdh_season1;
      const memes_tdh_season1__raw = t.memes_tdh_season1__raw;
      const memes_balance_season1 = t.memes_balance_season1;
      const boosted_memes_tdh_season2 = t.boosted_memes_tdh_season2;
      const memes_tdh_season2 = t.memes_tdh_season2;
      const memes_tdh_season2__raw = t.memes_tdh_season2__raw;
      const memes_balance_season2 = t.memes_balance_season2;
      const memes = mysql.escape(JSON.stringify(t.memes));
      const memes_ranks = mysql.escape(JSON.stringify(t.memes_ranks));
      const boosted_gradients_tdh = t.boosted_gradients_tdh;
      const gradients_tdh = t.gradients_tdh;
      const gradients_tdh__raw = t.gradients_tdh__raw;
      const gradients_balance = t.gradients_balance;
      const gradients = mysql.escape(JSON.stringify(t.gradients));
      const gradients_ranks = mysql.escape(JSON.stringify(t.gradients_ranks));

      const sql = `REPLACE INTO ${WALLETS_TDH_TABLE} SET 
          wallet = ${wallet},
          tdh_rank = ${tdh_rank},
          tdh_rank_memes = ${tdh_rank_memes},
          tdh_rank_memes_szn1 = ${tdh_rank_memes_szn1},
          tdh_rank_memes_szn2 = ${tdh_rank_memes_szn2},
          tdh_rank_gradients = ${tdh_rank_gradients},
          block = ${t.block}, 
          tdh = ${tdh}, 
          boost = ${boost}, 
          boosted_tdh = ${boosted_tdh}, 
          tdh__raw = ${tdh__raw}, 
          balance = ${balance}, 
          memes_cards_sets = ${memes_cards_sets}, 
          genesis = ${genesis}, 
          unique_memes = ${unique_memes},
          boosted_memes_tdh = ${boosted_memes_tdh}, 
          memes_tdh = ${memes_tdh}, 
          memes_tdh__raw = ${memes_tdh__raw}, 
          memes_balance=${memes_balance}, 
          boosted_memes_tdh_season1 = ${boosted_memes_tdh_season1}, 
          memes_tdh_season1 = ${memes_tdh_season1}, 
          memes_tdh_season1__raw = ${memes_tdh_season1__raw}, 
          memes_balance_season1=${memes_balance_season1}, 
          boosted_memes_tdh_season2 = ${boosted_memes_tdh_season2}, 
          memes_tdh_season2 = ${memes_tdh_season2}, 
          memes_tdh_season2__raw = ${memes_tdh_season2__raw}, 
          memes_balance_season2=${memes_balance_season2}, 
          memes = ${memes}, 
          memes_ranks = ${memes_ranks}, 
          boosted_gradients_tdh = ${boosted_gradients_tdh}, 
          gradients_tdh = ${gradients_tdh}, 
          gradients_tdh__raw = ${gradients_tdh__raw}, 
          gradients_balance = ${gradients_balance}, 
          gradients = ${gradients}, 
          gradients_ranks = ${gradients_ranks}`;
      await execSQL(sql);
    })
  );
  console.log('[TDH]', `PERSISTED ALL WALLETS TDH [${tdh.length}]`);

  const sqlBlock = `REPLACE INTO ${TDH_BLOCKS_TABLE} SET block_number=${block}, timestamp=${mysql.escape(
    timestamp
  )}`;
  await execSQL(sqlBlock);
}

export async function persistENS(ens: ENS[]) {
  console.log('[ENS]', `PERSISTING ENS [${ens.length}]`);

  await Promise.all(
    ens.map(async (t) => {
      if ((t.display && t.display.length < 150) || !t.display) {
        const wallet = mysql.escape(t.wallet);
        const display = mysql.escape(t.display);

        const sql = `REPLACE INTO ${ENS_TABLE} SET 
          wallet = ${wallet},
          display = ${display}`;
        await execSQL(sql);
      }
    })
  );

  console.log('[ENS]', `PERSISTED ALL [${ens.length}]`);
}
