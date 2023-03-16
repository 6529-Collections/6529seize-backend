import 'reflect-metadata';
import { DataSource } from 'typeorm';
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
  OWNERS_MEME_LAB_TABLE,
  MEMES_CONTRACT,
  DISTRIBUTION_TABLE
} from './constants';
import { Artist } from './entities/IArtist';
import { ENS } from './entities/IENS';
import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from './entities/INFT';
import { Owner, OwnerMetric, OwnerTags } from './entities/IOwner';
import { TDH } from './entities/ITDH';
import { Team } from './entities/ITeam';
import {
  Transaction,
  LabTransaction,
  BaseTransaction
} from './entities/ITransaction';
import { Royalties, RoyaltiesUpload } from './entities/IRoyalties';

const mysql = require('mysql');

let AppDataSource: DataSource;

export async function connect() {
  console.log('[DATABASE]', `[DB HOST ${process.env.DB_HOST}]`);

  AppDataSource = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT!),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    entities: [
      Owner,
      LabNFT,
      LabExtendedData,
      Transaction,
      OwnerMetric,
      NFT,
      Team,
      LabTransaction,
      Royalties,
      RoyaltiesUpload
    ],
    synchronize: true,
    logging: false
  });

  await AppDataSource.initialize().catch((error) => console.log(error));
  console.log('[DATABASE]', `[CONNECTION CREATED]`);
}

export async function disconnect() {
  await AppDataSource.destroy();
  console.log('[DATABASE]', `[DISCONNECTED]`);
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

function consolidateTransactions(
  transactions: BaseTransaction[]
): BaseTransaction[] {
  const consolidatedTransactions: BaseTransaction[] = Object.values(
    transactions.reduce((acc: any, transaction) => {
      const primaryKey = `${transaction.transaction}_${transaction.from_address}_${transaction.to_address}_${transaction.contract}_${transaction.token_id}`;

      if (acc[primaryKey]) {
        acc[primaryKey].token_count += transaction.token_count;
        acc[primaryKey].value += transaction.value;
      } else {
        acc[primaryKey] = transaction;
      }

      return acc;
    }, {})
  );
  return consolidatedTransactions;
}

export function execSQL(sql: string): Promise<any> {
  return new Promise(async (resolve, reject) => {
    try {
      const r = await AppDataSource.manager.query(sql);
      resolve(Object.values(JSON.parse(JSON.stringify(r))));
    } catch (err: any) {
      return reject(err);
    }
  });
}

export async function fetchLastUpload(): Promise<any> {
  let sql = `SELECT * FROM ${UPLOADS_TABLE} ORDER BY date DESC LIMIT 1;`;
  const results = await execSQL(sql);
  return results ? results[0] : [];
}

export async function fetchLastOwnerMetrics(): Promise<any> {
  let sql = `SELECT transaction_reference FROM ${OWNERS_METRICS_TABLE} ORDER BY transaction_reference DESC LIMIT 1;`;
  const results = await execSQL(sql);
  return results ? results[0].transaction_reference : null;
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

export async function fetchTdhReplayTimestamp(date: Date) {
  let sql = `SELECT timestamp FROM ${TDH_BLOCKS_TABLE} WHERE created_at > '2023-03-06' AND timestamp <= ${mysql.escape(
    date
  )} order by block_number asc limit 1;`;
  const r = await execSQL(sql);
  return r.length > 0 ? r[0].timestamp : null;
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
  let sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE value=0 LIMIT ${pageSize} OFFSET ${offset};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllMemeLabNFTs(orderBy?: string) {
  let sql = `SELECT * FROM ${NFTS_MEME_LAB_TABLE} `;
  if (orderBy) {
    sql += ` order by ${orderBy}`;
  }
  const results = await execSQL(sql);
  results.map((r: any) => {
    r.metadata = JSON.parse(r.metadata);
    r.meme_references = r.meme_references ? JSON.parse(r.meme_references) : [];
  });
  return results;
}

export async function fetchMemesWithSeason() {
  let sql = `SELECT * FROM ${NFTS_TABLE} LEFT JOIN ${MEMES_EXTENDED_DATA_TABLE} ON ${NFTS_TABLE}.id= ${MEMES_EXTENDED_DATA_TABLE}.id WHERE contract = ${mysql.escape(
    MEMES_CONTRACT
  )};`;
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
  let sql = `SELECT * FROM ${OWNERS_MEME_LAB_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchAllOwners() {
  let sql = `SELECT * FROM ${OWNERS_TABLE};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchDistinctOwnerWallets() {
  let sql = `SELECT DISTINCT ${OWNERS_TABLE}.wallet, 
    ${OWNERS_METRICS_TABLE}.created_at 
    FROM ${OWNERS_TABLE} LEFT JOIN ${OWNERS_METRICS_TABLE} 
    ON ${OWNERS_TABLE}.wallet = ${OWNERS_METRICS_TABLE}.wallet 
    WHERE ${OWNERS_TABLE}.wallet != ${mysql.escape(NULL_ADDRESS)};`;
  const results = await execSQL(sql);
  return results;
}

export async function fetchTransactionsFromDate(
  date: Date | undefined,
  limit?: number
) {
  let sql = `SELECT from_address, to_address FROM ${TRANSACTIONS_TABLE} `;
  if (date) {
    sql += ` WHERE ${TRANSACTIONS_TABLE}.created_at >= ${mysql.escape(date)}`;
  }
  if (limit) {
    sql += ` LIMIT ${limit}`;
  }

  const results = await execSQL(sql);
  return results;
}

export async function fetchTdhReplayOwners(datetime: Date) {
  let sql = `SELECT from_address, to_address from ${TRANSACTIONS_TABLE} WHERE transaction_date <= ${mysql.escape(
    datetime
  )};`;
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
  const sql = `SELECT * FROM ${TRANSACTIONS_TABLE}`;

  let filters = constructFilters(
    'filters',
    `(from_address = ${mysql.escape(wallet)} OR to_address = ${mysql.escape(
      wallet
    )})`
  );
  if (block) {
    filters = constructFilters(filters, `block <= ${block}`);
  }

  const fullSql = `${sql} ${filters}`;

  const results = await execSQL(fullSql);
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
  let sql = `SELECT DISTINCT address
    FROM (
      SELECT from_address AS address
      FROM ${TRANSACTIONS_TABLE}
      WHERE from_address NOT IN (SELECT wallet FROM ${ENS_TABLE})`;
  if (datetime) {
    sql += ` AND ${TRANSACTIONS_TABLE}.created_at > ${mysql.escape(datetime)}`;
  }
  sql += `UNION
      SELECT to_address AS address
      FROM ${TRANSACTIONS_TABLE}
      WHERE to_address NOT IN (SELECT wallet FROM ${ENS_TABLE})`;
  if (datetime) {
    sql += ` AND ${TRANSACTIONS_TABLE}.created_at > ${mysql.escape(datetime)}`;
  }
  sql += `) AS addresses LIMIT 200`;

  const results = await execSQL(sql);

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
      console.log(
        new Date(),
        '[LAB TRANSACTIONS]',
        `[PERSISTING ${consolidatedTransactions.length} TRANSACTIONS]`
      );
      await AppDataSource.getRepository(LabTransaction).save(
        consolidatedTransactions
      );
    } else {
      console.log(
        new Date(),
        '[TRANSACTIONS]',
        `[PERSISTING ${consolidatedTransactions.length} TRANSACTIONS]`
      );
      await AppDataSource.getRepository(Transaction).save(
        consolidatedTransactions
      );
    }

    console.log(
      new Date(),
      '[TRANSACTIONS]',
      `[ALL ${consolidatedTransactions.length} TRANSACTIONS PERSISTED]`
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

export async function persistOwnerMetrics(
  ownerMetrics: OwnerMetric[],
  reset?: boolean
) {
  if (ownerMetrics.length > 0) {
    console.log(
      '[OWNERS METRICS]',
      `[PERSISTING ${ownerMetrics.length} WALLETS]`
    );

    if (reset) {
      const walletIds = ownerMetrics.map((metric) => metric.wallet);

      const result = await AppDataSource.createQueryBuilder()
        .delete()
        .from(OwnerMetric)
        .where('wallet NOT IN (:...walletIds)', { walletIds })
        .execute();

      console.log(result);

      console.log('[OWNERS METRICS]', '[RESET]', `[${result}]`);
    }

    await Promise.all(
      ownerMetrics.map(async (ownerMetric) => {
        if (0 >= ownerMetric.balance) {
          console.log(
            '[OWNERS METRICS]',
            `[DELETING ${ownerMetric.wallet} BALANCE ${ownerMetric.balance}]`
          );
          await AppDataSource.getRepository(OwnerMetric).remove(ownerMetric);
        } else {
          await AppDataSource.getRepository(OwnerMetric).save(ownerMetric);
        }
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

export async function findVolumeNFTs(nft: NFT): Promise<{
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
    WHERE token_id = ${nft.id} and contract = ${mysql.escape(nft.contract)};`;
  const results = await execSQL(sql);
  return results[0];
}

export async function findVolumeLab(nft: LabNFT): Promise<{
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
    FROM ${TRANSACTIONS_MEME_LAB_TABLE}
    WHERE token_id = ${nft.id} and contract = ${mysql.escape(nft.contract)};`;
  const results = await execSQL(sql);
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
        try {
          await execSQL(sql);
        } catch {
          await execSQL(`REPLACE INTO ${ENS_TABLE} SET 
            wallet = ${wallet},
            display = ${mysql.escape(null)}`);
        }
      }
    })
  );

  console.log('[ENS]', `PERSISTED ALL [${ens.length}]`);
}

export async function persistLabNFTS(labnfts: LabNFT[]) {
  await AppDataSource.getRepository(LabNFT).save(labnfts);
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
  let sql = `SELECT ${ENS_TABLE}.display as ens, ${WALLETS_TDH_TABLE}.* FROM ${WALLETS_TDH_TABLE} LEFT JOIN ${ENS_TABLE} ON ${WALLETS_TDH_TABLE}.wallet=${ENS_TABLE}.wallet WHERE block=${block};`;
  const results = await execSQL(sql);
  results.map((r: any) => (r.memes = JSON.parse(r.memes)));
  results.map((r: any) => (r.gradients = JSON.parse(r.gradients)));
  return results;
}

export async function fetchOwnerMetricsTdhReplay(
  wallets: string[],
  block: number
) {
  const results = await Promise.all(
    wallets.map(async (wallet) => {
      const sql = `SELECT 
        (SELECT SUM(token_count) FROM transactions 
         WHERE block >= ${block}
         AND from_address = ${mysql.escape(
           wallet
         )} AND value = 0) AS transfers_out,
        (SELECT SUM(token_count) FROM transactions 
         WHERE block >= ${block}
         AND to_address = ${mysql.escape(
           wallet
         )} AND value = 0) AS transfers_in,
        (SELECT SUM(token_count) FROM transactions 
         WHERE block >= ${block}
         AND to_address = ${mysql.escape(
           wallet
         )} AND value > 0) AS purchases_count,
        (SELECT SUM(value) FROM transactions 
         WHERE block >= ${block}
         AND to_address = ${mysql.escape(
           wallet
         )} AND value > 0) AS purchases_value,
        (SELECT SUM(token_count) FROM transactions 
         WHERE block >= ${block}
         AND from_address = ${mysql.escape(
           wallet
         )} AND value > 0) AS sales_count,
        (SELECT SUM(value) FROM transactions 
         WHERE block >= ${block}
         AND from_address = ${mysql.escape(
           wallet
         )} AND value > 0) AS sales_value`;

      const [rows] = await execSQL(sql);
      if (rows[0]) {
        return {
          wallet,
          transfers_out: rows[0].transfers_out,
          transfers_in: rows[0].transfers_in,
          purchases_count: rows[0].purchases_count,
          purchases_value: rows[0].purchases_value,
          sales_count: rows[0].sales_count,
          sales_value: rows[0].sales_value
        };
      }
    })
  );

  return results;
}

export async function persistRoyalties(royalties: Royalties[]) {
  const repository = AppDataSource.getRepository(Royalties);
  const query = repository
    .createQueryBuilder()
    .insert()
    .into(Royalties)
    .values(royalties)
    .orUpdate(['id', 'date', 'contract', 'token_id', 'received_royalties']);
  await query.execute();
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
