import {
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  PRENODES_TABLE,
  TDH_BLOCKS_TABLE,
  TDH_NFT_TABLE
} from '@/constants';
import { fetchPaginated } from '../../../db-api';
import { MemesExtendedData } from '../../../entities/INFT';
import { NftTDH } from '../../../entities/ITDH';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT
} from '../../../nextgen/nextgen_constants';
import { sqlExecutor } from '../../../sql-executor';
import { getIpInfo } from '../policies/policies';

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

const getMerkleRoot = async (block: number): Promise<string | null> => {
  const merkleRootResult = await sqlExecutor.oneOrNull<{ merkle_root: string }>(
    `SELECT merkle_root from ${TDH_BLOCKS_TABLE} WHERE block_number = ${block}`
  );
  return merkleRootResult?.merkle_root ?? null;
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
  const merkleRoot = await getMerkleRoot(block);
  const seasonTdh = await fetchSingleAddressTDHMemesSeasons(address);
  const addressTdh: any = {
    tdh: formatNumber(tdh[0]?.boosted_tdh ?? 0),
    boost,
    memes_tdh: formatNumber(tdh[0]?.boosted_memes_tdh ?? 0),
    gradients_tdh: formatNumber(tdh[0]?.boosted_gradients_tdh ?? 0),
    nextgen_tdh: formatNumber(tdh[0]?.boosted_nextgen_tdh ?? 0)
  };

  seasonTdh.seasons.forEach((s) => {
    addressTdh[`memes_tdh_szn${s.season}`] = s.tdh;
  });
  addressTdh['addresses'] = JSON.parse(
    tdh[0]?.wallets ?? JSON.stringify([address])
  ).map((w: string) => w.toLowerCase());

  addressTdh['block'] = block;
  addressTdh['merkle_root'] = merkleRoot;

  return addressTdh;
};

export const fetchSingleAddressTDHForNft = async (
  address: string,
  contract: string,
  id: number
) => {
  const { block, tdh } = await fetchBlockAndAddressTdh(address);
  const merkleRoot = await getMerkleRoot(block);
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
    block,
    merkle_root: merkleRoot
  };
};

export const fetchSingleAddressTDHBreakdown = async (address: string) => {
  const { block, tdh } = await fetchBlockAndAddressTdh(address);
  const boost = tdh[0]?.boost ?? 1;
  const merkleRoot = await getMerkleRoot(block);
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
    block,
    merkle_root: merkleRoot
  };
};

export const fetchTotalTDH = async () => {
  const block = await getBlock();
  const merkleRoot = await getMerkleRoot(block);
  const sql = `
    SELECT SUM(boosted_tdh) as boosted_tdh, SUM(boosted_memes_tdh) as memes_tdh, SUM(boosted_gradients_tdh) as gradients_tdh, SUM(boosted_nextgen_tdh) as nextgen_tdh from ${CONSOLIDATED_WALLETS_TDH_TABLE}
  `;
  const tdh = await sqlExecutor.execute(sql);
  const seasonTdh = await fetchSeasonsTDH();

  const totals: any = {
    tdh: formatNumber(tdh[0]?.boosted_tdh ?? 0),
    memes_tdh: formatNumber(tdh[0]?.memes_tdh ?? 0),
    gradients_tdh: formatNumber(tdh[0]?.gradients_tdh ?? 0),
    nextgen_tdh: formatNumber(tdh[0]?.nextgen_tdh ?? 0)
  };
  seasonTdh.seasons.forEach((s) => {
    totals[`memes_tdh_szn${s.season}`] = s.tdh;
  });
  totals['block'] = block;
  totals['merkle_root'] = merkleRoot;
  return totals;
};

export const fetchNfts = async (contract?: string, id?: string) => {
  const block = await getBlock();
  const merkleRoot = await getMerkleRoot(block);
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
    block,
    merkle_root: merkleRoot
  };
};

export const fetchSingleAddressTDHMemesSeasons = async (address: string) => {
  const { block, tdh } = await fetchBlockAndAddressTdh(address);
  const memeNfts = await fetchMemes();
  const boost = tdh[0]?.boost ?? 1;
  const merkleRoot = await getMerkleRoot(block);
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
    block,
    merkle_root: merkleRoot
  };
};

export async function fetchTDHAbove(value: number, includeEntries: boolean) {
  const block = await getBlock();
  const merkleRoot = await getMerkleRoot(block);
  const sql = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} 
    WHERE boosted_tdh >= ${value}
    ORDER BY boosted_tdh DESC
  `;
  const tdh = await sqlExecutor.execute(sql);
  const response: any = {
    count: tdh.length,
    block,
    merkle_root: merkleRoot
  };
  if (includeEntries) {
    response.entries = tdh.map((t: any) => {
      return {
        consolidation_key: t.consolidation_key,
        tdh: t.boosted_tdh,
        addresses: JSON.parse(t.wallets).map((w: string) => w.toLowerCase()),
        block,
        merkle_root: merkleRoot
      };
    });
  }

  return response;
}

export async function fetchTDHPercentile(percentile: number) {
  const block = await getBlock();
  const merkleRoot = await getMerkleRoot(block);
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
    block,
    merkle_root: merkleRoot
  };
}

export async function fetchTDHCutoff(cutoff: number) {
  const block = await getBlock();
  const merkleRoot = await getMerkleRoot(block);

  const query = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} 
    ORDER BY boosted_tdh DESC
    LIMIT :cutoff
  `;
  const tdh = await sqlExecutor.execute(query, { cutoff });
  const leastTdh = tdh.at(-1)?.boosted_tdh;
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
    block,
    merkle_root: merkleRoot
  };
}

export async function fetchSeasonsTDH(season?: string) {
  const block = await getBlock();
  const merkleRoot = await getMerkleRoot(block);
  let filters = 'WHERE season > 0';
  let params: any = {};
  if (season) {
    filters = `${filters} AND season = :season`;
    params = { season };
  }
  const query = `
    SELECT season, SUM(boosted_tdh) AS tdh
    FROM ${CONSOLIDATED_WALLETS_TDH_MEMES_TABLE}
    ${filters}
    GROUP BY season;
  `;

  const results = await sqlExecutor.execute(query, params);

  const seasons = results.map((r: any) => {
    return {
      season: r.season,
      tdh: formatNumber(r.tdh)
    };
  });
  return {
    seasons,
    block,
    merkle_root: merkleRoot
  };
}

export async function validatePrenode(
  ip: string,
  domain: string,
  prenodeTdh: number,
  prenodeBlock: number
) {
  const block = await getBlock();
  const tdh =
    (
      await sqlExecutor.execute(`
        SELECT SUM(boosted_tdh) as boosted_tdh FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
      `)
    )[0]?.boosted_tdh ?? 0;

  const tdh_sync = prenodeTdh === tdh;
  const block_sync = prenodeBlock === block;

  const ipInfo = await getIpInfo(ip);

  await sqlExecutor.execute(
    `
    INSERT INTO ${PRENODES_TABLE} (ip, domain, city, country, tdh_sync, block_sync)
    VALUES (:ip, :domain, :city, :country, :tdh_sync, :block_sync)
    ON DUPLICATE KEY UPDATE 
      domain = VALUES(domain), 
      city = VALUES(city),
      country = VALUES(country),
      tdh_sync = VALUES(tdh_sync), 
      block_sync = VALUES(block_sync),
      updated_at = UTC_TIMESTAMP(6)
  `,
    {
      ip,
      domain,
      city: ipInfo?.city_name,
      country: ipInfo?.country_name,
      tdh_sync,
      block_sync
    }
  );

  return {
    tdh_sync,
    block_sync
  };
}

export async function fetchPrenodes(pageSize: number, page: number) {
  return fetchPaginated(
    PRENODES_TABLE,
    {},
    `(tdh_sync AND block_sync) DESC,
    (tdh_sync OR block_sync) DESC,
    CASE 
        WHEN ping_status = 'green' THEN 1
        WHEN ping_status = 'orange' THEN 2
        ELSE 3
    END ASC,
    CASE 
        WHEN tdh_sync AND block_sync AND ping_status = 'green' THEN created_at
        ELSE NULL
    END ASC,
    updated_at DESC`,
    pageSize,
    page,
    '',
    `ip, 
    domain, 
    tdh_sync, 
    block_sync, 
    created_at, 
    updated_at, 
    city, 
    country,
    CASE 
        WHEN updated_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR THEN 'green'
        WHEN updated_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR THEN 'orange'
        ELSE 'red'
    END AS 'ping_status'`
  );
}
