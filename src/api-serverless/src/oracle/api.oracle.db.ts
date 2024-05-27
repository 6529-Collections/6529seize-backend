import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_CONTRACT,
  GRADIENT_CONTRACT,
  TDH_NFT_TABLE,
  MEMES_EXTENDED_DATA_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE
} from '../../../constants';
import { MemesExtendedData } from '../../../entities/INFT';
import { NftTDH } from '../../../entities/ITDH';
import {
  NEXTGEN_CORE_CONTRACT,
  getNextgenNetwork
} from '../../../nextgen/nextgen_constants';
import { sqlExecutor } from '../../../sql-executor';

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

const fetchMemes = async (): Promise<MemesExtendedData[]> => {
  const sql = `
    SELECT * FROM ${MEMES_EXTENDED_DATA_TABLE}
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

export const fetchSingleAddressTDHForNft = async (
  address: string,
  contract: string,
  id: number
) => {
  const { block, tdh } = await fetchBlockAndAddressTdh(address);
  const addressTdh = tdh[0]?.tdh;
  let nftTdh = 0;
  if (addressTdh) {
    const boost = addressTdh.boost ?? 1;
    let nfts = [];
    if (contract === 'memes') {
      nfts = JSON.parse(tdh[0]?.memes ?? JSON.stringify([]));
    } else if (contract === 'gradients') {
      nfts = JSON.parse(tdh[0]?.gradients ?? JSON.stringify([]));
    } else if (contract === 'nextgen') {
      nfts = JSON.parse(tdh[0]?.nextgen ?? JSON.stringify([]));
    }
    const nft = nfts.find((m: any) => m.id == id);
    if (nft) {
      nftTdh = parseToken(boost, nft).tdh;
    }
  }
  return {
    tdh: formatNumber(nftTdh),
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
  const seasonTdh = await fetchSeasonsTDH();

  const totals: any = {
    tdh: formatNumber(tdh[0]?.total_tdh ?? 0),
    memes_tdh: formatNumber(tdh[0]?.memes_tdh ?? 0),
    gradients_tdh: formatNumber(tdh[0]?.gradients_tdh ?? 0),
    nextgen_tdh: formatNumber(tdh[0]?.nextgen_tdh ?? 0)
  };
  seasonTdh.seasons.forEach((s) => {
    totals[`memes_tdh_szn${s.season}`] = s.tdh;
  });
  totals['block'] = block;
  return totals;
};

export const fetchNfts = async (contract?: string, id?: string) => {
  const block = await getBlock();
  let sql = `
    SELECT 
      contract,
      id,
      SUM(boosted_tdh) as tdh
    FROM ${TDH_NFT_TABLE}`;
  if (contract) {
    let contractQuery = contract.toLowerCase();
    if (contractQuery === 'memes') {
      contractQuery = MEMES_CONTRACT;
    } else if (contractQuery === 'gradients') {
      contractQuery = GRADIENT_CONTRACT;
    } else if (contractQuery === 'nextgen') {
      contractQuery = NEXTGEN_CORE_CONTRACT[getNextgenNetwork()];
    }
    sql = `${sql} WHERE contract = '${contractQuery.toLowerCase()}'`;

    if (id) {
      sql = `${sql} AND id = ${id}`;
    }
  }
  sql = `${sql} GROUP BY contract, id ORDER BY contract ASC, id ASC`;
  const nftResponse = await sqlExecutor.execute(sql);
  const nfts = nftResponse.map((n: NftTDH) => {
    return {
      id: n.id,
      contract: n.contract,
      tdh: n.tdh
    };
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
      addresses: JSON.parse(t.wallets).map((w: string) => w.toLowerCase()),
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
      addresses: JSON.parse(t.wallets).map((w: string) => w.toLowerCase())
    };
  });
  return {
    tdh: leastTdh,
    entries,
    block
  };
}

export async function fetchSeasonsTDH(season?: string) {
  const block = await getBlock();

  let filters = 'WHERE season > 0';
  let params: any = {};
  if (season) {
    filters = `${filters} AND season = :season`;
    params = { season };
  }
  const query = `
    SELECT season, SUM(tdh) AS tdh
    FROM ${CONSOLIDATED_WALLETS_TDH_MEMES_TABLE}
    ${filters}
    GROUP BY season;
  `;

  const results = await sqlExecutor.execute(query, params);

  const seasons = results.map((r: any) => {
    return {
      season: r.season,
      tdh: r.tdh
    };
  });
  return {
    seasons,
    block
  };
}
