import { ConsolidatedTDH, TDHENS } from './entities/ITDH';
import { OwnerMetric } from './entities/IOwner';
import { areEqualAddresses } from './helpers';
import { SIX529_MUSEUM } from './constants';
import converter from 'json-2-csv';
import {
  fetchAllTDH,
  fetchAllOwnerMetrics,
  fetchLastUpload,
  persistTdhUpload,
  fetchAllConsolidatedTdh
} from './db';

const Arweave = require('arweave');

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export async function uploadTDH(force?: boolean) {
  const tdh: ConsolidatedTDH[] = await fetchAllConsolidatedTdh();
  const ownerMetrics: OwnerMetric[] = await fetchAllOwnerMetrics();

  const block = tdh[0].block;
  const dateString = formatDate(new Date());

  const lastUpload = await fetchLastUpload();

  const exists = lastUpload && lastUpload.date == dateString;

  if (!exists || force) {
    console.log(
      new Date(),
      '[TDH UPLOAD]',
      `[BLOCK ${block}]`,
      `[TDH ${tdh.length}]`,
      `[OWNER METRICS ${ownerMetrics.length}]`
    );

    const tdhProcessed = tdh.map((tdh) => {
      const {
        date,
        memes_balance_season1,
        memes_balance_season2,
        memes_balance_season3,
        ...rest
      } = tdh;
      if (!rest.consolidation_display && rest.wallets.length == 1) {
        if (areEqualAddresses(rest.wallets[0], SIX529_MUSEUM)) {
          rest.consolidation_display = '6529Museum';
        }
      }
      return rest;
    });

    const ownerMetricProcessed = ownerMetrics.map((om) => {
      const { balance, ...rest } = om;
      return rest;
    });

    const combinedArray = tdhProcessed.reduce(
      (combined: any[], tdhProcessed) => {
        const ownerMetrics = [...ownerMetricProcessed].filter((om) =>
          tdhProcessed.wallets.some((w: string) =>
            areEqualAddresses(w, om.wallet)
          )
        );
        if (ownerMetrics.length > 0) {
          combined.push({ ...tdhProcessed, ...ownerMetrics[0] });
        }
        return combined;
      },
      []
    );

    combinedArray.sort((a, b) => a.tdh_rank - b.tdh_rank);

    console.log(new Date(), `[TDH UPLOAD]`, `[CREATING CSV]`);

    const csv = await converter.json2csvAsync(combinedArray);

    console.log(new Date(), `[TDH UPLOAD]`, `[CSV CREATED]`);

    const arweaveKey = process.env.ARWEAVE_KEY
      ? JSON.parse(process.env.ARWEAVE_KEY)
      : {};

    let transaction = await myarweave.createTransaction(
      { data: Buffer.from(csv) },
      arweaveKey
    );

    transaction.addTag('Content-Type', 'text/csv');

    console.log(new Date(), `[TDH UPLOAD]`, `[SIGNING ARWEAVE TRANSACTION]`);

    await myarweave.transactions.sign(transaction, arweaveKey);

    let uploader = await myarweave.transactions.getUploader(transaction);

    while (!uploader.isComplete) {
      await uploader.uploadChunk();
      console.log(
        new Date(),
        '[TDH UPLOAD]',
        `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
      );
    }

    const url = `https://arweave.net/${transaction.id}`;

    await persistTdhUpload(
      block,
      dateString,
      `https://arweave.net/${transaction.id}`
    );

    console.log(new Date(), `[TDH UPLOAD]`, `[ARWEAVE LINK ${url}]`);
  } else {
    console.log(
      new Date(),
      `[TDH UPLOAD]`,
      `[TODAY'S TDH UPLOAD ALREADY EXISTS AT ${lastUpload.tdh}]`,
      `[SKIPPING...]`
    );
  }
}

function padTo2Digits(num: number) {
  return num.toString().padStart(2, '0');
}

function formatDate(date: Date) {
  return [
    date.getFullYear(),
    padTo2Digits(date.getMonth() + 1),
    padTo2Digits(date.getDate())
  ].join('');
}
