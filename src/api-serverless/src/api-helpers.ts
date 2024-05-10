import { Response } from 'express';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_CONTRACT,
  NFTS_TABLE
} from '../../constants';
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

const fetchBlockAndWalletTdh = async (wallet: string) => {
  const block = await getBlock();
  const sql = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} where LOWER(consolidation_key) like '%${wallet.toLowerCase()}%'
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

export const fetchSingleWalletTDH = async (wallet: string) => {
  const { block, tdh } = await fetchBlockAndWalletTdh(wallet);
  const boost = tdh[0]?.boost ?? 1;
  return {
    tdh: formatNumber(tdh[0]?.boosted_tdh ?? 0),
    boost,
    memes_tdh: formatNumber(tdh[0]?.boosted_memes_tdh ?? 0),
    gradients_tdh: formatNumber(tdh[0]?.boosted_gradients_tdh ?? 0),
    nextgen_tdh: formatNumber(tdh[0]?.boosted_nextgen_tdh ?? 0),
    wallets: JSON.parse(tdh[0]?.wallets ?? JSON.stringify([wallet])),
    block
  };
};

export const fetchSingleWalletTDHBreakdown = async (wallet: string) => {
  const { block, tdh } = await fetchBlockAndWalletTdh(wallet);
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
  const block = await getBlock();
  let sql = `SELECT * FROM ${NFTS_TABLE}`;
  if (contract) {
    sql = `${sql} WHERE contract = '${contract.toLowerCase()}'`;
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

export const fetchSingleWalletTDHMemesSeasons = async (wallet: string) => {
  const { block, tdh } = await fetchBlockAndWalletTdh(wallet);
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
      const walletMemes = JSON.parse(tdh[0]?.memes ?? JSON.stringify([]));
      const meme = walletMemes.find((m: any) => m.id === id);
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
