import { RequestInfo, RequestInit } from 'node-fetch';
import { persistGlobalTDHHistory, persistTDHHistory } from '../db';
import {
  ConsolidatedTDH,
  GlobalTDHHistory,
  TDHHistory,
  TokenTDH
} from '../entities/ITDH';
import { areEqualAddresses, formatDateAsString } from '../helpers';
import { loadEnv, unload } from '../secrets';
import { ConsolidatedTDHUpload } from '../entities/IUpload';
import axios from 'axios';
import { Readable } from 'stream';

const csvParser = require('csv-parser');

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

export const handler = async (event?: any, context?: any) => {
  await loadEnv([TDHHistory, GlobalTDHHistory]);
  const iterations = parseInt(process.env.TDH_HISTORY_ITERATIONS || '1');
  console.log(
    new Date(),
    '[RUNNING TDH HISTORY LOOP]',
    `[ITERATIONS ${iterations}]`
  );
  await tdhHistoryLoop(iterations);
  await unload();
  console.log(new Date(), '[TDH HISTORY LOOP COMPLETE]');
};

export async function tdhHistoryLoop(iterations: number) {
  for (let i = 0; i < iterations; i++) {
    const myDate = new Date();
    myDate.setDate(myDate.getDate() - i);

    const historyResult = await tdhHistory(myDate);

    await calculateGlobalTDHHistory(
      myDate,
      historyResult.block,
      historyResult.history,
      historyResult.tdh
    );

    console.log(
      '[TDH HISTORY]',
      `[DATE ${myDate.toISOString().split('T')[0]}]`,
      '[ALL DONE!]'
    );
  }
}

async function fetchUploads(date: string): Promise<ConsolidatedTDHUpload[]> {
  const uploads = await fetch(
    `https://api.seize.io/api/consolidated_uploads?date=${date}&page_size=5`
  );
  const json = await uploads.json();
  return json.data;
}

async function fetchAndParseCSV(url: string): Promise<ConsolidatedTDH[]> {
  try {
    const response = await axios.get(url);
    const csvData: any[] = [];

    return new Promise((resolve, reject) => {
      const readableStream = Readable.from(response.data);
      readableStream
        .pipe(csvParser())
        .on('data', (row: any) => {
          csvData.push(row);
        })
        .on('end', () => {
          resolve(csvData);
        })
        .on('error', (error: any) => {
          reject(error);
        });
    });
  } catch (error) {
    throw error;
  }
}

async function tdhHistory(date: Date) {
  const dateString = formatDateAsString(date);
  const uploads = await fetchUploads(dateString);

  console.log(
    '\n[TDH HISTORY]',
    `[DATE ${date.toISOString().split('T')[0]}]`,
    '[FETCHING UPLOADS...]'
  );

  const today = uploads[0];
  const yesterday = uploads[1];

  const todayData = await fetchAndParseCSV(today.tdh);
  const yesterdayData = await fetchAndParseCSV(yesterday.tdh);

  const tdhHistory: TDHHistory[] = [];

  console.log(
    '[TDH HISTORY]',
    `[DATE ${date.toISOString().split('T')[0]}]`,
    '[MAPPING...]'
  );

  todayData.map((d) => {
    d.memes = JSON.parse(d.memes);
    d.gradients = JSON.parse(d.gradients);
    d.wallets = JSON.parse(d.wallets);

    let tdhCreated = 0;
    let tdhDestroyed = 0;
    let boostedTdhCreated = 0;
    let boostedTdhDestroyed = 0;
    let rawTdhCreated = 0;
    let rawTdhDestroyed = 0;
    let balanceCreated = 0;
    let balanceDestroyed = 0;

    const yesterdayTdh = yesterdayData.find(
      (y) =>
        areEqualAddresses(d.consolidation_display, y.consolidation_display) ||
        d.wallets.some((w: any) => JSON.parse(y.wallets).includes(w))
    );

    if (yesterdayTdh) {
      yesterdayTdh.memes = JSON.parse(yesterdayTdh.memes);
      yesterdayTdh.gradients = JSON.parse(yesterdayTdh.gradients);
    }

    d.memes.map((m: TokenTDH) => {
      const existing: TokenTDH = yesterdayTdh
        ? yesterdayTdh.memes.find((em: TokenTDH) => em.id == m.id)
        : null;

      let previousTdh: TokenTDH;

      if (existing) {
        previousTdh = existing;
      } else {
        previousTdh = {
          id: m.id,
          tdh: 0,
          tdh__raw: 0,
          balance: 0
        };
      }

      const change = m.tdh - previousTdh.tdh;
      const previousBoost = yesterdayTdh ? yesterdayTdh.boost : 1;

      if (change > 0) {
        tdhCreated += m.tdh - previousTdh.tdh;
        rawTdhCreated += m.tdh__raw - previousTdh.tdh__raw;
        boostedTdhCreated += m.tdh * d.boost - previousTdh.tdh * previousBoost;
        balanceCreated += m.balance - previousTdh.balance;
      } else {
        tdhDestroyed += previousTdh.tdh - m.tdh;
        rawTdhDestroyed += previousTdh.tdh__raw - m.tdh__raw;
        boostedTdhDestroyed +=
          previousTdh.tdh * previousBoost - m.tdh * d.boost;
        balanceDestroyed += previousTdh.balance - m.balance;
      }
    });

    d.gradients.map((m: TokenTDH) => {
      const existing: TokenTDH = yesterdayTdh
        ? yesterdayTdh.gradients.find((em: TokenTDH) => em.id == m.id)
        : null;

      let previousTdh: TokenTDH;

      if (existing) {
        previousTdh = existing;
      } else {
        previousTdh = {
          id: m.id,
          tdh: 0,
          tdh__raw: 0,
          balance: 0
        };
      }

      const change = m.tdh - previousTdh.tdh;
      const previousBoost = yesterdayTdh ? yesterdayTdh.boost : 1;

      if (change > 0) {
        tdhCreated += m.tdh - previousTdh.tdh;
        rawTdhCreated += m.tdh__raw - previousTdh.tdh__raw;
        boostedTdhCreated += m.tdh * d.boost - previousTdh.tdh * previousBoost;
        balanceCreated += m.balance - previousTdh.balance;
      } else {
        tdhDestroyed += previousTdh.tdh - m.tdh;
        rawTdhDestroyed += previousTdh.tdh__raw - m.tdh__raw;
        boostedTdhDestroyed +=
          previousTdh.tdh * previousBoost - m.tdh * d.boost;
        balanceDestroyed += previousTdh.balance - m.balance;
      }
    });

    const tdhNet = tdhCreated - tdhDestroyed;
    const rawTdhNet = rawTdhCreated - rawTdhDestroyed;
    const boostedTdhNet = boostedTdhCreated - boostedTdhDestroyed;
    const balanceNet = balanceCreated - balanceDestroyed;

    const tdhH = {
      date: date,
      consolidation_display: d.consolidation_display,
      wallets: d.wallets,
      block: d.block,
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

  console.log(
    '[TDH HISTORY]',
    `[DATE ${date.toISOString().split('T')[0]}]`,
    `[COUNT ${tdhHistory.length}]`,
    '[PERSISTNG...]'
  );
  await persistTDHHistory(tdhHistory);

  return {
    block: today.block,
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
  console.log(
    '[TDH HISTORY]',
    `[DATE ${date.toISOString().split('T')[0]}]`,
    '[CALCULATING GLOBAL TDH HISTORY...]'
  );

  const sums = tdhHistory.reduce(
    (accumulator, current) => {
      accumulator.created_tdh += current.created_tdh;
      accumulator.destroyed_tdh += current.destroyed_tdh;
      accumulator.net_tdh += current.net_tdh;

      accumulator.created_boosted_tdh += current.created_boosted_tdh;
      accumulator.destroyed_boosted_tdh += current.destroyed_boosted_tdh;
      accumulator.net_boosted_tdh += current.net_boosted_tdh;

      accumulator.created_tdh__raw += current.created_tdh__raw;
      accumulator.destroyed_tdh__raw += current.destroyed_tdh__raw;
      accumulator.net_tdh__raw += current.net_tdh__raw;

      accumulator.created_balance += current.created_balance;
      accumulator.destroyed_balance += current.destroyed_balance;
      accumulator.net_balance += current.net_balance;

      return accumulator;
    },
    {
      created_tdh: 0,
      destroyed_tdh: 0,
      net_tdh: 0,
      created_boosted_tdh: 0,
      destroyed_boosted_tdh: 0,
      net_boosted_tdh: 0,
      created_tdh__raw: 0,
      destroyed_tdh__raw: 0,
      net_tdh__raw: 0,
      created_balance: 0,
      destroyed_balance: 0,
      net_balance: 0
    }
  );

  const tdh_sums = tdhData.reduce(
    (accumulator, current: any) => {
      accumulator.boosted_tdh += parseFloat(current.boosted_tdh);
      accumulator.tdh += parseFloat(current.tdh);
      accumulator.tdh__raw += parseFloat(current.tdh__raw);
      accumulator.boosted_gradients_tdh += parseFloat(
        current.boosted_gradients_tdh
      );
      accumulator.gradients_tdh += parseFloat(current.gradients_tdh);
      accumulator.gradients_tdh__raw += parseFloat(current.gradients_tdh__raw);
      accumulator.boosted_memes_tdh += parseFloat(current.boosted_memes_tdh);
      accumulator.memes_tdh += parseFloat(current.memes_tdh);
      accumulator.memes_tdh__raw += parseFloat(current.memes_tdh__raw);

      return accumulator;
    },
    {
      boosted_tdh: 0,
      tdh: 0,
      tdh__raw: 0,
      boosted_gradients_tdh: 0,
      gradients_tdh: 0,
      gradients_tdh__raw: 0,
      boosted_memes_tdh: 0,
      memes_tdh: 0,
      memes_tdh__raw: 0
    }
  );

  const consolidationWallets = tdhData.length;

  const arraysLength = tdhData.reduce(
    (accumulator, current: any) => {
      accumulator.wallets += current.wallets.length;
      accumulator.memes += current.memes.length;
      accumulator.gradients += current.gradients.length;
      return accumulator;
    },
    { wallets: 0, memes: 0, gradients: 0 }
  );

  const globalHistory: GlobalTDHHistory = {
    date: date,
    block,
    created_tdh: sums.created_tdh,
    destroyed_tdh: sums.destroyed_tdh,
    net_tdh: sums.net_tdh,
    created_boosted_tdh: sums.created_boosted_tdh,
    destroyed_boosted_tdh: sums.destroyed_boosted_tdh,
    net_boosted_tdh: sums.net_boosted_tdh,
    created_tdh__raw: sums.created_tdh__raw,
    destroyed_tdh__raw: sums.destroyed_tdh__raw,
    net_tdh__raw: sums.net_tdh__raw,
    created_balance: sums.created_balance,
    destroyed_balance: sums.destroyed_balance,
    net_balance: sums.net_balance,
    memes_balance: arraysLength.memes,
    gradients_balance: arraysLength.gradients,
    total_boosted_tdh: tdh_sums.boosted_tdh,
    total_tdh: tdh_sums.tdh,
    total_tdh__raw: tdh_sums.tdh__raw,
    gradients_boosted_tdh: tdh_sums.boosted_gradients_tdh,
    gradients_tdh: tdh_sums.gradients_tdh,
    gradients_tdh__raw: tdh_sums.gradients_tdh__raw,
    memes_boosted_tdh: tdh_sums.boosted_memes_tdh,
    memes_tdh: tdh_sums.memes_tdh,
    memes_tdh__raw: tdh_sums.memes_tdh__raw,
    total_consolidated_wallets: consolidationWallets,
    total_wallets: arraysLength.wallets
  };

  await persistGlobalTDHHistory(globalHistory);
}
