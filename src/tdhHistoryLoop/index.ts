import { RequestInfo, RequestInit } from 'node-fetch';
import { Readable } from 'stream';
import { consolidationTools } from '../consolidation-tools';
import {
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
  TDH_BLOCKS_TABLE
} from '@/constants';
import { persistGlobalTDHHistory, persistTDHHistory } from '../db';
import { ConsolidatedTDH, TDHBlock, TokenTDH } from '../entities/ITDH';
import {
  GlobalTDHHistory,
  LatestGlobalTDHHistory,
  LatestTDHHistory,
  RecentTDHHistory,
  TDHHistory
} from '../entities/ITDHHistory';
import { Logger } from '../logging';
import * as priorityAlertsContext from '../priority-alerts.context';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { sqlExecutor } from '../sql-executor';
import { parseTdhDataFromDB } from '../sql_helpers';
import { equalIgnoreCase } from '../strings';
import { Time } from '../time';

const csvParser = require('csv-parser');

const logger = Logger.get('TDH_HISTORY_LOOP');
const ALERT_TITLE = 'TDH History Loop';

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
      const iterations = Number.parseInt(
        process.env.TDH_HISTORY_ITERATIONS ?? '1'
      );
      logger.info(`[ITERATIONS ${iterations}]`);
      await tdhHistoryLoop(iterations);
    }),
    {
      logger,
      entities: [
        TDHHistory,
        GlobalTDHHistory,
        LatestTDHHistory,
        LatestGlobalTDHHistory,
        RecentTDHHistory
      ]
    }
  );
});

async function tdhHistoryLoop(iterations: number) {
  for (let i = iterations - 1; i >= 0; i--) {
    const start = Time.now();
    const myDate = new Date();
    myDate.setDate(myDate.getDate() - i);

    const historyResult = await tdhHistory(myDate);

    await calculateGlobalTDHHistory(
      myDate,
      historyResult.block,
      historyResult.history,
      historyResult.tdh
    );

    logger.info(
      `[DATE ${
        myDate.toISOString().split('T')[0]
      }] [ALL DONE!] [${start.diffFromNow()}]`
    );
  }
}

async function fetchTDHBlock(start: Time): Promise<TDHBlock> {
  const end = start.minusDays(1);
  const blocks = await sqlExecutor.execute<TDHBlock>(
    `SELECT * FROM 
    ${TDH_BLOCKS_TABLE} 
    WHERE timestamp < :start 
    AND timestamp > :end
    ORDER BY block_number DESC`,
    {
      start: start.toIsoDateString(),
      end: end.toIsoDateString()
    }
  );
  if (blocks.length !== 1) {
    throw new Error(
      `Expected 1 TDH block found ${blocks.length} for date ${start.toIsoDateString()}`
    );
  }
  return blocks[0];
}

function matchesConsolidationKey(d: any, yd: any) {
  return (
    equalIgnoreCase(d.consolidation_key, yd.consolidation_key) ||
    equalIgnoreCase(
      d.consolidation_key,
      consolidationTools.buildConsolidationKey(yd.wallets)
    )
  );
}

async function fetchConsolidatedTDH(block: number): Promise<ConsolidatedTDH[]> {
  // Primary: Try to get data from historic_tdh_consolidation table
  const results = await sqlExecutor.execute<ConsolidatedTDH>(
    `SELECT * FROM ${HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE} WHERE block = :block`,
    { block }
  );

  if (results.length > 0) {
    return results.map(parseTdhDataFromDB);
  }

  // Fallback: If no results in DB, try to fetch from arweave uploads
  logger.info(
    `[BLOCK ${block}] [NO RESULTS IN DB] [FALLING BACK TO ARWEAVE UPLOADS]`
  );

  try {
    // Call the consolidated_uploads API endpoint
    const apiUrl = `https://api.6529.io/api/consolidated_uploads?block=${block}&page_size=1`;
    const apiResponse = await fetch(apiUrl);

    if (!apiResponse.ok) {
      throw new Error(
        `Failed to fetch consolidated uploads: ${apiResponse.status} ${apiResponse.statusText}`
      );
    }

    const apiData = await apiResponse.json();

    // Validate that results[0] block matches the requested block
    if (!apiData.data || apiData.data.length === 0) {
      throw new Error(
        `No consolidated uploads found for block ${block} in API response`
      );
    }

    const uploadEntry = apiData.data[0];
    if (uploadEntry.block !== block) {
      throw new Error(
        `Block mismatch: requested ${block}, but API returned block ${uploadEntry.block}`
      );
    }

    if (!uploadEntry.url) {
      throw new Error(
        `No URL found in consolidated uploads response for block ${block}`
      );
    }

    logger.info(
      `[BLOCK ${block}] [FOUND ARWEAVE URL] [${uploadEntry.url}] [FETCHING CSV DATA]`
    );

    // Fetch CSV data from arweave URL
    const csvResponse = await fetch(uploadEntry.url);
    if (!csvResponse.ok) {
      throw new Error(
        `Failed to fetch CSV from arweave: ${csvResponse.status} ${csvResponse.statusText}`
      );
    }

    // Parse CSV data
    const csvText = await csvResponse.text();
    const csvData = await parseCsvFromText(csvText);

    // Convert CSV rows to ConsolidatedTDH format
    const consolidatedTdh: ConsolidatedTDH[] = csvData.map((row: any) => {
      // Map CSV fields to ConsolidatedTDH structure
      const tdh: any = {
        block: Number.parseInt(row.block) || block,
        date: new Date(
          row.date
            ? `${row.date.substring(0, 4)}-${row.date.substring(4, 6)}-${row.date.substring(6, 8)}`
            : new Date()
        ),
        consolidation_key: row.consolidation_key || '',
        consolidation_display: row.consolidation_display || '',
        wallets: row.wallets || '[]',
        balance: Number.parseInt(row.total_balance) || 0,
        unique_memes: Number.parseInt(row.unique_memes) || 0,
        memes_cards_sets: Number.parseInt(row.memes_cards_sets) || 0,
        tdh: Number.parseInt(row.tdh) || 0,
        boost: Number.parseFloat(row.boost) || 0,
        boosted_tdh: Number.parseInt(row.boosted_tdh) || 0,
        tdh__raw: Number.parseInt(row.tdh__raw) || 0,
        tdh_rank: Number.parseInt(row.tdh_rank) || 0,
        tdh_rank_memes: Number.parseInt(row.tdh_rank_memes) || 0,
        tdh_rank_gradients: Number.parseInt(row.tdh_rank_gradients) || 0,
        tdh_rank_nextgen: 0, // Not in CSV, default to 0
        genesis: Number.parseInt(row.genesis) || 0,
        nakamoto: Number.parseInt(row.nakamoto) || 0,
        boosted_memes_tdh: Number.parseInt(row.boosted_memes_tdh) || 0,
        memes_tdh: Number.parseInt(row.memes_tdh) || 0,
        memes_tdh__raw: Number.parseInt(row.memes_tdh__raw) || 0,
        memes_balance: Number.parseInt(row.memes_balance) || 0,
        memes: row.memes || '[]',
        memes_ranks: '[]', // Not in CSV, default to empty array
        gradients_balance: Number.parseInt(row.gradients_balance) || 0,
        boosted_gradients_tdh: Number.parseInt(row.boosted_gradients_tdh) || 0,
        gradients_tdh: Number.parseInt(row.gradients_tdh) || 0,
        gradients_tdh__raw: Number.parseInt(row.gradients_tdh__raw) || 0,
        gradients: row.gradients || '[]',
        gradients_ranks: '[]', // Not in CSV, default to empty array
        nextgen_balance: Number.parseInt(row.nextgen_balance) || 0,
        boosted_nextgen_tdh: Number.parseInt(row.boosted_nextgen_tdh) || 0,
        nextgen_tdh: Number.parseInt(row.nextgen_tdh) || 0,
        nextgen_tdh__raw: Number.parseInt(row.nextgen_tdh__raw) || 0,
        nextgen: row.nextgen || '[]',
        nextgen_ranks: '[]', // Not in CSV, default to empty array
        boost_breakdown: row.boost_breakdown || '{}'
      };
      return tdh;
    });

    // Apply parseTdhDataFromDB to parse JSON fields
    return consolidatedTdh.map(parseTdhDataFromDB);
  } catch (error: any) {
    logger.error(
      `[BLOCK ${block}] [FALLBACK FAILED] [${error.message}] [THROWING ERROR]`
    );
    throw new Error(
      `No results found in historic_tdh_consolidation table and no valid arweave URL from uploads endpoint for block ${block}: ${error.message}`
    );
  }
}

async function parseCsvFromText(csvText: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    const stream = Readable.from([csvText]);

    stream
      .pipe(csvParser())
      .on('data', (data: any) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

function hasMatchingWallet(d: any, yd: any) {
  const dWallets = d.consolidation_key.split('-');
  const ydWallets = yd.consolidation_key.split('-');
  return dWallets.some((dw: string) =>
    ydWallets.some((yw: string) => equalIgnoreCase(dw, yw))
  );
}

interface YesterdayDataIndex {
  byConsolidationKey: Map<string, ConsolidatedTDH[]>;
  byWallet: Map<string, ConsolidatedTDH[]>;
  walletSets: Map<ConsolidatedTDH, Set<string>>;
  alternativeKeys: Map<ConsolidatedTDH, string>;
}

function buildYesterdayDataIndex(
  yesterdayData: ConsolidatedTDH[]
): YesterdayDataIndex {
  const byConsolidationKey = new Map<string, ConsolidatedTDH[]>();
  const byWallet = new Map<string, ConsolidatedTDH[]>();
  const walletSets = new Map<ConsolidatedTDH, Set<string>>();
  const alternativeKeys = new Map<ConsolidatedTDH, string>();

  for (const yd of yesterdayData) {
    const keyLower = yd.consolidation_key.toLowerCase();
    if (!byConsolidationKey.has(keyLower)) {
      byConsolidationKey.set(keyLower, []);
    }
    byConsolidationKey.get(keyLower)!.push(yd);

    const alternativeKey = consolidationTools.buildConsolidationKey(yd.wallets);
    const alternativeKeyLower = alternativeKey.toLowerCase();
    if (!byConsolidationKey.has(alternativeKeyLower)) {
      byConsolidationKey.set(alternativeKeyLower, []);
    }
    byConsolidationKey.get(alternativeKeyLower)!.push(yd);
    alternativeKeys.set(yd, alternativeKey);

    const wallets = yd.consolidation_key.split('-');
    const walletSet = new Set<string>();
    for (const wallet of wallets) {
      const walletLower = wallet.toLowerCase();
      walletSet.add(walletLower);
      if (!byWallet.has(walletLower)) {
        byWallet.set(walletLower, []);
      }
      byWallet.get(walletLower)!.push(yd);
    }
    walletSets.set(yd, walletSet);
  }

  return {
    byConsolidationKey,
    byWallet,
    walletSets,
    alternativeKeys
  };
}

function addDirectMatches(
  matches: Set<ConsolidatedTDH>,
  dKeyLower: string,
  index: YesterdayDataIndex
) {
  const directMatches = index.byConsolidationKey.get(dKeyLower);
  if (directMatches) {
    for (const match of directMatches) {
      matches.add(match);
    }
  }
}

function hasWalletOverlap(
  match: ConsolidatedTDH,
  dWalletSet: Set<string>,
  index: YesterdayDataIndex
): boolean {
  const matchWalletSet = index.walletSets.get(match);
  if (!matchWalletSet) {
    return false;
  }
  const matchWalletsArray = Array.from(matchWalletSet);
  for (const matchWallet of matchWalletsArray) {
    if (dWalletSet.has(matchWallet)) {
      return true;
    }
  }
  return false;
}

function addWalletMatches(
  matches: Set<ConsolidatedTDH>,
  dWallets: string[],
  dWalletSet: Set<string>,
  index: YesterdayDataIndex
) {
  for (const wallet of dWallets) {
    const walletMatches = index.byWallet.get(wallet);
    if (walletMatches) {
      for (const match of walletMatches) {
        if (hasWalletOverlap(match, dWalletSet, index)) {
          matches.add(match);
        }
      }
    }
  }
}

function findMatchingYesterdayEntries(
  d: ConsolidatedTDH,
  index: YesterdayDataIndex
): ConsolidatedTDH[] {
  const matches = new Set<ConsolidatedTDH>();

  const dKeyLower = d.consolidation_key.toLowerCase();
  addDirectMatches(matches, dKeyLower, index);

  const dWallets = d.consolidation_key.split('-').map((w) => w.toLowerCase());
  const dWalletSet = new Set(dWallets);
  addWalletMatches(matches, dWallets, dWalletSet, index);

  return Array.from(matches);
}

async function tdhHistory(date: Date) {
  const todayTime = Time.fromDate(date);
  const yesterdayTime = todayTime.minusDays(1);
  const todayBlock = await fetchTDHBlock(todayTime);
  const yesterdayBlock = await fetchTDHBlock(yesterdayTime);

  logger.info(
    [
      'CALCULATING TDH CHANGE',
      `[FROM BLOCK ${todayBlock.block_number} (${todayTime.toIsoDateString()})]`,
      `[TO BLOCK ${yesterdayBlock.block_number} (${yesterdayTime.toIsoDateString()})]`
    ].join(' ')
  );

  const todayData: ConsolidatedTDH[] = await fetchConsolidatedTDH(
    todayBlock.block_number
  );
  const yesterdayData: ConsolidatedTDH[] = await fetchConsolidatedTDH(
    yesterdayBlock.block_number
  );

  const tdhHistory: TDHHistory[] = [];

  logger.info(`[DATE ${date.toISOString().split('T')[0]}] [MAPPING...]`);

  const yesterdayDataIndex = buildYesterdayDataIndex(yesterdayData);
  const yesterdayEntries = new Set<string>();

  todayData.forEach((d) => {
    const dMemes = d.memes;
    const dGradients = d.gradients;
    const dNextgen = d.nextgen;

    const yesterdayTdh = findMatchingYesterdayEntries(d, yesterdayDataIndex);

    if (yesterdayTdh.length > 0) {
      yesterdayTdh.forEach((y) => {
        yesterdayEntries.add(y.consolidation_key);
      });
    }

    const indexedYesterdayTdh = buildTokenIndex(yesterdayTdh);

    const memesResult = processTokenTDHArray(
      'memes',
      d.boost,
      dMemes,
      indexedYesterdayTdh
    );
    const gradientsResult = processTokenTDHArray(
      'gradients',
      d.boost,
      dGradients,
      indexedYesterdayTdh
    );
    const nextgenResult = processTokenTDHArray(
      'nextgen',
      d.boost,
      dNextgen,
      indexedYesterdayTdh
    );

    const tdhCreated =
      memesResult.tdhCreated +
      gradientsResult.tdhCreated +
      nextgenResult.tdhCreated;
    const tdhDestroyed =
      memesResult.tdhDestroyed +
      gradientsResult.tdhDestroyed +
      nextgenResult.tdhDestroyed;
    const rawTdhCreated =
      memesResult.rawTdhCreated +
      gradientsResult.rawTdhCreated +
      nextgenResult.rawTdhCreated;
    const rawTdhDestroyed =
      memesResult.rawTdhDestroyed +
      gradientsResult.rawTdhDestroyed +
      nextgenResult.rawTdhDestroyed;
    const boostedTdhCreated =
      memesResult.boostedTdhCreated +
      gradientsResult.boostedTdhCreated +
      nextgenResult.boostedTdhCreated;
    const boostedTdhDestroyed =
      memesResult.boostedTdhDestroyed +
      gradientsResult.boostedTdhDestroyed +
      nextgenResult.boostedTdhDestroyed;
    const balanceCreated =
      memesResult.balanceCreated +
      gradientsResult.balanceCreated +
      nextgenResult.balanceCreated;
    const balanceDestroyed =
      memesResult.balanceDestroyed +
      gradientsResult.balanceDestroyed +
      nextgenResult.balanceDestroyed;

    const tdhNet = tdhCreated - tdhDestroyed;
    const rawTdhNet = rawTdhCreated - rawTdhDestroyed;
    const boostedTdhNet = boostedTdhCreated - boostedTdhDestroyed;
    const balanceNet = balanceCreated - balanceDestroyed;

    const tdhH: TDHHistory = {
      date: date,
      consolidation_display: d.consolidation_display,
      consolidation_key: d.consolidation_key,
      wallets: d.wallets,
      block: todayBlock.block_number,
      boosted_tdh: d.boosted_tdh,
      tdh: d.tdh,
      tdh__raw: d.tdh__raw,
      created_tdh: tdhCreated,
      destroyed_tdh: tdhDestroyed,
      net_tdh: tdhNet,
      created_boosted_tdh: boostedTdhCreated,
      destroyed_boosted_tdh: boostedTdhDestroyed,
      net_boosted_tdh: boostedTdhNet,
      created_tdh__raw: rawTdhCreated,
      destroyed_tdh__raw: rawTdhDestroyed,
      net_tdh__raw: rawTdhNet,
      created_balance: balanceCreated,
      destroyed_balance: balanceDestroyed,
      net_balance: balanceNet
    };
    tdhHistory.push(tdhH);
  });

  yesterdayData.forEach((yd) => {
    if (!yesterdayEntries.has(yd.consolidation_key)) {
      logger.info(
        `[DATE ${date.toISOString().split('T')[0]}] [KEY LOST ${
          yd.consolidation_key
        } ${yd.boosted_tdh} TDH]`
      );

      const ydtdhRaw = yd.tdh__raw;
      const ydtdh = yd.tdh;
      const ydboostedTdh = yd.boosted_tdh;
      const ydbalance = yd.balance;

      const tdhH: TDHHistory = {
        date: date,
        consolidation_display: yd.consolidation_display,
        consolidation_key: yd.consolidation_key,
        wallets: yd.wallets,
        block: todayBlock.block_number,
        boosted_tdh: 0,
        tdh: 0,
        tdh__raw: 0,
        created_tdh: 0,
        destroyed_tdh: ydtdh,
        net_tdh: -ydtdh,
        created_boosted_tdh: 0,
        destroyed_boosted_tdh: ydboostedTdh,
        net_boosted_tdh: -ydboostedTdh,
        created_tdh__raw: 0,
        destroyed_tdh__raw: ydtdhRaw,
        net_tdh__raw: -ydtdhRaw,
        created_balance: 0,
        destroyed_balance: ydbalance,
        net_balance: ydbalance
      };
      tdhHistory.push(tdhH);
    }
  });

  logger.info(
    `[DATE ${date.toISOString().split('T')[0]}] [COUNT ${
      tdhHistory.length
    }] [PERSISTING...]`
  );

  await persistTDHHistory(date, tdhHistory);

  return {
    block: todayBlock.block_number,
    history: tdhHistory,
    tdh: todayData
  };
}

async function calculateGlobalTDHHistory(
  date: Date,
  block: number,
  tdhHistory: TDHHistory[],
  tdhData: ConsolidatedTDH[]
) {
  logger.info(
    `[DATE ${
      date.toISOString().split('T')[0]
    }] [CALCULATING GLOBAL TDH HISTORY...]`
  );

  let totalCreatedTdh = 0;
  let totalDestroyedTdh = 0;
  let totalNetTdh = 0;
  let totalCreatedBoostedTdh = 0;
  let totalDestroyedBoostedTdh = 0;
  let totalNetBoostedTdh = 0;
  let totalCreatedTdhRaw = 0;
  let totalDestroyedTdhRaw = 0;
  let totalNetTdhRaw = 0;
  let totalCreatedBalance = 0;
  let totalDestroyedBalance = 0;
  let totalNetBalance = 0;

  tdhHistory.forEach((h: any) => {
    totalCreatedTdh += Number.parseFloat(h.created_tdh);
    totalDestroyedTdh += Number.parseFloat(h.destroyed_tdh);
    totalNetTdh += Number.parseFloat(h.net_tdh);
    totalCreatedBoostedTdh += Number.parseFloat(h.created_boosted_tdh);
    totalDestroyedBoostedTdh += Number.parseFloat(h.destroyed_boosted_tdh);
    totalNetBoostedTdh += Number.parseFloat(h.net_boosted_tdh);
    totalCreatedTdhRaw += Number.parseFloat(h.created_tdh__raw);
    totalDestroyedTdhRaw += Number.parseFloat(h.destroyed_tdh__raw);
    totalNetTdhRaw += Number.parseFloat(h.net_tdh__raw);
    totalCreatedBalance += Number.parseFloat(h.created_balance);
    totalDestroyedBalance += Number.parseFloat(h.destroyed_balance);
    totalNetBalance += Number.parseFloat(h.net_balance);
  });

  let totalBoostedTdh = 0;
  let totalTdh = 0;
  let totalTdhRaw = 0;
  let totalGradientsBoostedTdh = 0;
  let totalGradientsTdh = 0;
  let totalGradientsTdhRaw = 0;
  let totalMemesBoostedTdh = 0;
  let totalMemesTdh = 0;
  let totalMemesTdhRaw = 0;
  let walletsLength = 0;
  let memesLength = 0;
  let gradientsLength = 0;
  let nextgenLength = 0;

  tdhData.forEach((h: any) => {
    totalBoostedTdh += Number.parseFloat(h.boosted_tdh);
    totalTdh += Number.parseFloat(h.tdh);
    totalTdhRaw += Number.parseFloat(h.tdh__raw);
    totalGradientsBoostedTdh += Number.parseFloat(h.boosted_gradients_tdh);
    totalGradientsTdh += Number.parseFloat(h.gradients_tdh);
    totalGradientsTdhRaw += Number.parseFloat(h.gradients_tdh__raw);
    totalMemesBoostedTdh += Number.parseFloat(h.boosted_memes_tdh);
    totalMemesTdh += Number.parseFloat(h.memes_tdh);
    totalMemesTdhRaw += Number.parseFloat(h.memes_tdh__raw);

    walletsLength += h.wallets.length;
    memesLength += h.memes.length;
    gradientsLength += h.gradients.length;
    nextgenLength += h.nextgen?.length ?? 0;
  });

  const consolidationWallets = tdhData.length;

  const globalHistory: GlobalTDHHistory = {
    date: date,
    block,
    created_tdh: totalCreatedTdh,
    destroyed_tdh: totalDestroyedTdh,
    net_tdh: totalNetTdh,
    created_boosted_tdh: totalCreatedBoostedTdh,
    destroyed_boosted_tdh: totalDestroyedBoostedTdh,
    net_boosted_tdh: totalNetBoostedTdh,
    created_tdh__raw: totalCreatedTdhRaw,
    destroyed_tdh__raw: totalDestroyedTdhRaw,
    net_tdh__raw: totalNetTdhRaw,
    created_balance: totalCreatedBalance,
    destroyed_balance: totalDestroyedBalance,
    net_balance: totalNetBalance,
    memes_balance: memesLength,
    gradients_balance: gradientsLength,
    nextgen_balance: nextgenLength,
    total_boosted_tdh: totalBoostedTdh,
    total_tdh: totalTdh,
    total_tdh__raw: totalTdhRaw,
    gradients_boosted_tdh: totalGradientsBoostedTdh,
    gradients_tdh: totalGradientsTdh,
    gradients_tdh__raw: totalGradientsTdhRaw,
    memes_boosted_tdh: totalMemesBoostedTdh,
    memes_tdh: totalMemesTdh,
    memes_tdh__raw: totalMemesTdhRaw,
    total_consolidated_wallets: consolidationWallets,
    total_wallets: walletsLength
  };

  await persistGlobalTDHHistory(globalHistory);
}

interface IndexedToken {
  token: TokenTDH;
  boost: number;
}

interface IndexedYesterdayTdh {
  memes: Map<number, IndexedToken[]>;
  gradients: Map<number, IndexedToken[]>;
  nextgen: Map<number, IndexedToken[]>;
}

function indexTokensByType(
  tokenMap: Map<number, IndexedToken[]>,
  tokens: TokenTDH[] | undefined,
  boost: number
) {
  if (!tokens) {
    return;
  }
  for (const token of tokens) {
    if (!tokenMap.has(token.id)) {
      tokenMap.set(token.id, []);
    }
    tokenMap.get(token.id)!.push({
      token,
      boost
    });
  }
}

function buildTokenIndex(yesterdayTdh: ConsolidatedTDH[]): IndexedYesterdayTdh {
  const memes = new Map<number, IndexedToken[]>();
  const gradients = new Map<number, IndexedToken[]>();
  const nextgen = new Map<number, IndexedToken[]>();

  for (const yd of yesterdayTdh) {
    indexTokensByType(memes, yd.memes, yd.boost);
    indexTokensByType(gradients, yd.gradients, yd.boost);
    indexTokensByType(nextgen, yd.nextgen, yd.boost);
  }

  return { memes, gradients, nextgen };
}

function processTokenTDHArray(
  type: string,
  boost: number,
  tokens: TokenTDH[],
  indexedYesterdayTdh: IndexedYesterdayTdh
) {
  return tokens.reduce(
    (acc, token) => {
      const change = calculateChange(type, indexedYesterdayTdh, token, boost);
      acc.tdhCreated += change.tdhCreated;
      acc.tdhDestroyed += change.tdhDestroyed;
      acc.boostedTdhCreated += change.boostedTdhCreated;
      acc.boostedTdhDestroyed += change.boostedTdhDestroyed;
      acc.rawTdhCreated += change.rawTdhCreated;
      acc.rawTdhDestroyed += change.rawTdhDestroyed;
      acc.balanceCreated += change.balanceCreated;
      acc.balanceDestroyed += change.balanceDestroyed;
      return acc;
    },
    {
      tdhCreated: 0,
      tdhDestroyed: 0,
      boostedTdhCreated: 0,
      boostedTdhDestroyed: 0,
      rawTdhCreated: 0,
      rawTdhDestroyed: 0,
      balanceCreated: 0,
      balanceDestroyed: 0
    }
  );
}

function calculateChange(
  type: string,
  indexedYesterdayTdh: IndexedYesterdayTdh,
  m: TokenTDH,
  boost: number
) {
  let tokenMap: Map<number, IndexedToken[]> | undefined;
  if (type === 'memes') {
    tokenMap = indexedYesterdayTdh.memes;
  } else if (type === 'gradients') {
    tokenMap = indexedYesterdayTdh.gradients;
  } else if (type === 'nextgen') {
    tokenMap = indexedYesterdayTdh.nextgen;
  }

  const previousTdh = {
    id: m.id,
    boosted_tdh: 0,
    tdh: 0,
    tdh__raw: 0,
    balance: 0
  };

  if (tokenMap) {
    const indexedTokens = tokenMap.get(m.id);
    if (indexedTokens) {
      for (const indexedToken of indexedTokens) {
        const e = indexedToken.token;
        previousTdh.boosted_tdh += Math.round(e.tdh * indexedToken.boost);
        previousTdh.tdh += e.tdh;
        previousTdh.tdh__raw += e.tdh__raw;
        previousTdh.balance += e.balance;
      }
    }
  }

  const change = m.tdh - previousTdh.tdh;
  let tdhCreated = 0;
  let tdhDestroyed = 0;
  let boostedTdhCreated = 0;
  let boostedTdhDestroyed = 0;
  let rawTdhCreated = 0;
  let rawTdhDestroyed = 0;
  let balanceCreated = 0;
  let balanceDestroyed = 0;
  if (change > 0) {
    tdhCreated += m.tdh - previousTdh.tdh;
    rawTdhCreated += m.tdh__raw - previousTdh.tdh__raw;
    boostedTdhCreated += Math.round(m.tdh * boost) - previousTdh.boosted_tdh;
    balanceCreated += m.balance - previousTdh.balance;
  } else {
    tdhDestroyed += previousTdh.tdh - m.tdh;
    rawTdhDestroyed += previousTdh.tdh__raw - m.tdh__raw;
    boostedTdhDestroyed += previousTdh.boosted_tdh - Math.round(m.tdh * boost);
    balanceDestroyed += previousTdh.balance - m.balance;
  }
  return {
    tdhCreated,
    tdhDestroyed,
    boostedTdhCreated,
    boostedTdhDestroyed,
    rawTdhCreated,
    rawTdhDestroyed,
    balanceCreated,
    balanceDestroyed
  };
}
