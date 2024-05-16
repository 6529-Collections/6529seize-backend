import * as mysql from 'mysql';
import { DbQueryOptions, DbPoolName } from './db-query.options';
import { Logger } from './logging';
import { setSqlExecutor, ConnectionWrapper, sqlExecutor } from './sql-executor';
import { Time } from './time';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  NFTS_TABLE,
  MEMES_CONTRACT,
  GRADIENT_CONTRACT,
  NEXTGEN_CONTRACT
} from './constants';
import { NFT } from './entities/INFT';

let read_pool: mysql.Pool;

const logger = Logger.get('DB_API');

export async function connect() {
  if (
    !process.env.DB_HOST_READ ||
    !process.env.DB_USER_READ ||
    !process.env.DB_PASS_READ ||
    !process.env.DB_PORT
  ) {
    logger.error('[MISSING CONFIGURATION FOR READ DB] [EXITING]');
    process.exit(1);
  }
  const port = +process.env.DB_PORT;
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

function getDbConnection(): Promise<mysql.PoolConnection> {
  return new Promise((resolve, reject) => {
    read_pool.getConnection(function (
      err: mysql.MysqlError,
      dbcon: mysql.PoolConnection
    ) {
      if (err) {
        logger.error(`Failed to establish connection [${JSON.stringify(err)}]`);
        reject(err);
      }
      resolve(dbcon);
    });
  });
}

async function execNativeTransactionally<T>(
  executable: (connectionWrapper: ConnectionWrapper<any>) => Promise<T>
): Promise<T> {
  const connection = await getDbConnection();
  try {
    connection.beginTransaction();
    const result = await executable({ connection: connection });
    return await new Promise((resolve, reject) => {
      connection.commit((err: any) => {
        if (err) {
          reject(new Error(err));
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
    externallyGivenConnection || (await getDbConnection());
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
        reject(new Error(err));
      } else {
        resolve(Object.values(JSON.parse(JSON.stringify(result))));
      }
    });
  });
}

const formatNumber = (num: number) => {
  return parseFloat(num.toFixed(0));
};

const parseToken = (
  boost: number,
  token: {
    id: number;
    tdh: number;
  }
) => {
  return {
    id: token.id,
    tdh: formatNumber(token.tdh * boost)
  };
};

const getBlock = async () => {
  const blockResult = await sqlExecutor.execute(
    `SELECT MAX(block) as block from ${CONSOLIDATED_WALLETS_TDH_TABLE}`
  );
  return blockResult[0].block ?? 0;
};

const fetchBlockAndAddressTdh = async (address: string) => {
  const block = await getBlock();
  const sql = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} where LOWER(consolidation_key) like '%${address.toLowerCase()}%'
  `;
  const tdh = await sqlExecutor.execute(sql);

  return {
    block,
    tdh
  };
};

const fetchMemes = async (): Promise<NFT[]> => {
  const sql = `
    SELECT * from ${NFTS_TABLE} where LOWER(contract) = '${MEMES_CONTRACT.toLowerCase()}'
  `;
  return await sqlExecutor.execute(sql);
};

export const fetchSingleAddressTDH = async (address: string) => {
  const { block, tdh } = await fetchBlockAndAddressTdh(address);
  const boost = tdh[0]?.boost ?? 1;
  return {
    tdh: formatNumber(tdh[0]?.boosted_tdh ?? 0),
    boost,
    memes_tdh: formatNumber(tdh[0]?.boosted_memes_tdh ?? 0),
    gradients_tdh: formatNumber(tdh[0]?.boosted_gradients_tdh ?? 0),
    nextgen_tdh: formatNumber(tdh[0]?.boosted_nextgen_tdh ?? 0),
    addresses: JSON.parse(tdh[0]?.wallets ?? JSON.stringify([address])).map(
      (w: string) => w.toLowerCase()
    ),
    block
  };
};

export const fetchSingleAddressTDHBreakdown = async (address: string) => {
  const { block, tdh } = await fetchBlockAndAddressTdh(address);
  const boost = tdh[0]?.boost ?? 1;
  return {
    memes_balance: tdh[0]?.memes_balance ?? 0,
    memes: JSON.parse(tdh[0]?.memes ?? JSON.stringify([])).map((t: any) =>
      parseToken(boost, t)
    ),
    gradients_balance: tdh[0]?.gradients_balance ?? 0,
    gradients: JSON.parse(tdh[0]?.gradients ?? JSON.stringify([])).map(
      (t: any) => parseToken(boost, t)
    ),
    nextgen_balance: tdh[0]?.nextgen_balance ?? 0,
    nextgen: JSON.parse(tdh[0]?.nextgen ?? JSON.stringify([])).map((t: any) =>
      parseToken(boost, t)
    ),
    block
  };
};

export const fetchTotalTDH = async () => {
  const block = await getBlock();
  const sql = `
    SELECT SUM(boosted_tdh) as total_tdh, SUM(boosted_memes_tdh) as memes_tdh, SUM(boosted_gradients_tdh) as gradients_tdh, SUM(boosted_nextgen_tdh) as nextgen_tdh from ${CONSOLIDATED_WALLETS_TDH_TABLE}
  `;
  const tdh = await sqlExecutor.execute(sql);
  return {
    tdh: formatNumber(tdh[0]?.total_tdh ?? 0),
    memes_tdh: formatNumber(tdh[0]?.memes_tdh ?? 0),
    gradients_tdh: formatNumber(tdh[0]?.gradients_tdh ?? 0),
    nextgen_tdh: formatNumber(tdh[0]?.nextgen_tdh ?? 0),
    block
  };
};

export const fetchNfts = async (contract?: string) => {
  const block = await getBlock();
  let sql = `SELECT * FROM ${NFTS_TABLE}`;
  if (contract) {
    let contractQuery = contract.toLowerCase();
    if (contractQuery === 'memes') {
      contractQuery = MEMES_CONTRACT;
    } else if (contractQuery === 'gradients') {
      contractQuery = GRADIENT_CONTRACT;
    } else if (contractQuery === 'nextgen') {
      contractQuery = NEXTGEN_CONTRACT;
    }
    sql = `${sql} WHERE contract = '${contractQuery.toLowerCase()}'`;
  }
  sql = `${sql} ORDER BY contract ASC, id ASC`;
  const nftResponse = await sqlExecutor.execute(sql);
  const nfts = nftResponse.map((n: NFT) => {
    if (!n.season) {
      delete n.season;
    }
    return n;
  });

  return {
    nfts,
    block
  };
};

export const fetchSingleAddressTDHMemesSeasons = async (address: string) => {
  const { block, tdh } = await fetchBlockAndAddressTdh(address);
  const memeNfts = await fetchMemes();
  const boost = tdh[0]?.boost ?? 1;
  const memeSeasons = new Map<number, number[]>();
  memeNfts.forEach((m) => {
    const season = m.season;
    if (season) {
      const seasonArray = memeSeasons.get(season) || [];
      seasonArray.push(m.id);
      memeSeasons.set(season, seasonArray);
    }
  });

  const seasons: { season: number; tdh: number }[] = [];
  memeSeasons.forEach((ids, season) => {
    const seasonTdh = ids.reduce((acc, id) => {
      const addressMemes = JSON.parse(tdh[0]?.memes ?? JSON.stringify([]));
      const meme = addressMemes.find((m: any) => m.id === id);
      if (meme) {
        return acc + meme.tdh;
      }
      return acc;
    }, 0);
    seasons.push({
      season,
      tdh: formatNumber(seasonTdh * boost)
    });
  });

  return {
    seasons,
    block
  };
};

export async function fetchTDHAbove(value: number) {
  const block = await getBlock();

  const sql = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} 
    WHERE boosted_tdh >= ${value}
    ORDER BY boosted_tdh DESC
  `;
  const tdh = await sqlExecutor.execute(sql);
  const entries = tdh.map((t: any) => {
    return {
      consolidation_key: t.consolidation_key,
      tdh: t.boosted_tdh,
      addresses: JSON.parse(t.wallets.map((w: string) => w.toLowerCase())),
      block
    };
  });
  return {
    count: tdh.length,
    entries
  };
}

export async function fetchTDHPercentile(percentile: number) {
  const block = await getBlock();

  const percentileValue = percentile / 100;
  const query = `
    WITH ranked_data AS (
      SELECT 
        boosted_tdh,
        PERCENT_RANK() OVER (ORDER BY boosted_tdh DESC) AS percentile_rank
      FROM tdh_consolidation
    )
    SELECT
      threshold_value,
      (SELECT COUNT(*) FROM tdh_consolidation WHERE boosted_tdh >= threshold.threshold_value) AS count_in_percentile
    FROM (
      SELECT 
        boosted_tdh AS threshold_value
      FROM ranked_data
      WHERE percentile_rank <= :percentileValue
      ORDER BY percentile_rank DESC
      LIMIT 1
    ) AS threshold;
  `;

  const result = await sqlExecutor.execute(query, { percentileValue });
  const tdhPercentileValue = result[0]?.threshold_value || null;
  const countInPercentile = result[0]?.count_in_percentile || 0;

  return {
    percentile,
    tdh: tdhPercentileValue,
    count_in_percentile: countInPercentile,
    block
  };
}

export async function fetchTDHCutoff(cutoff: number) {
  const block = await getBlock();

  const query = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} 
    ORDER BY boosted_tdh DESC
    LIMIT :cutoff
  `;
  const tdh = await sqlExecutor.execute(query, { cutoff });
  const leastTdh = tdh[tdh.length - 1].boosted_tdh;
  const entries = tdh.map((t: any) => {
    return {
      consolidation_key: t.consolidation_key,
      tdh: t.boosted_tdh,
      addresses: JSON.parse(t.wallets.map((w: string) => w.toLowerCase()))
    };
  });
  return {
    tdh: leastTdh,
    entries,
    block
  };
}
