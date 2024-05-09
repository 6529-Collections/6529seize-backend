import { Response } from 'express';
import { CONSOLIDATED_WALLETS_TDH_TABLE, NFTS_TABLE } from '../../constants';
import { sqlExecutor } from '../../sql-executor';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  corsOptions
} from './api-constants';
import { NFT } from '../../entities/INFT';

export function returnJsonResult(result: any, response: Response) {
  response.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  response.setHeader(
    ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
    corsOptions.allowedHeaders
  );
  response.json(result);
}

const formatNumber = (num: number) => {
  return parseFloat(num.toFixed(4));
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

const fetchBlockAndWalletTdh = async (wallet: string) => {
  const blockResult = await sqlExecutor.execute(
    `SELECT MAX(block) as block from ${CONSOLIDATED_WALLETS_TDH_TABLE}`
  );
  const block = blockResult[0].block ?? 0;
  const sql = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} where LOWER(consolidation_key) like '%${wallet.toLowerCase()}%'
  `;
  const tdh = await sqlExecutor.execute(sql);

  return {
    block,
    tdh
  };
};

export const fetchSingleWalletTDH = async (wallet: string) => {
  const { block, tdh } = await fetchBlockAndWalletTdh(wallet);
  const boost = tdh[0]?.boost ?? 1;
  return {
    tdh: formatNumber(tdh[0]?.boosted_tdh ?? 0),
    boost,
    memes_tdh: formatNumber(tdh[0]?.boosted_memes_tdh ?? 0),
    gradients_tdh: formatNumber(tdh[0]?.boosted_gradients_tdh ?? 0),
    nextgen_tdh: formatNumber(tdh[0]?.boosted_nextgen_tdh ?? 0),
    wallets: JSON.parse(tdh[0]?.wallets ?? []),
    block
  };
};

export const fetchSingleWalletTDHBreakdown = async (wallet: string) => {
  const { block, tdh } = await fetchBlockAndWalletTdh(wallet);
  const boost = tdh[0]?.boost ?? 1;
  return {
    memes_balance: tdh[0]?.memes_balance ?? 0,
    memes: JSON.parse(tdh[0]?.memes ?? []).map((t: any) =>
      parseToken(boost, t)
    ),
    gradients_balance: tdh[0]?.gradients_balance ?? 0,
    gradients: JSON.parse(tdh[0]?.gradients ?? []).map((t: any) =>
      parseToken(boost, t)
    ),
    nextgen_balance: tdh[0]?.nextgen_balance ?? 0,
    nextgen: JSON.parse(tdh[0]?.nextgen ?? []).map((t: any) =>
      parseToken(boost, t)
    ),
    block
  };
};

export const fetchTotalTDH = async () => {
  const blockResult = await sqlExecutor.execute(
    `SELECT MAX(block) as block from ${CONSOLIDATED_WALLETS_TDH_TABLE}`
  );
  const block = blockResult[0].block ?? 0;
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
  let sql = `SELECT * FROM ${NFTS_TABLE}`;
  if (contract) {
    sql = `${sql} WHERE contract = '${contract.toLowerCase()}'`;
  }
  sql = `${sql} ORDER BY contract ASC, id ASC`;
  const nfts = await sqlExecutor.execute(sql);
  return nfts.map((n: NFT) => {
    if (!n.season) {
      delete n.season;
    }
    return n;
  });
};
