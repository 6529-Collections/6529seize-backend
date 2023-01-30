import { TDHENS } from './entities/ITDH';
import { OwnerMetric } from './entities/IOwner';
import { areEqualAddresses } from './helpers';
import { SIX529_MUSEUM } from './constants';
import Arweave from 'arweave/node';

const arweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

const converter = require('json-2-csv');

const config = require('./config');

export const uploadTDH = async (
  tdh: TDHENS[],
  ownerMetrics: OwnerMetric[],
  db: any
) => {
  const block = tdh[0].block;
  const dateString = formatDate(new Date());

  const lastUpload = await db.findLastUpload(dateString);

  const exists = lastUpload && lastUpload.date == dateString;

  if (!exists) {
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
        memes_tdh_season2,
        memes_tdh_season2__raw,
        memes_balance_season2,
        ...rest
      } = tdh;
      if (!rest.ens) {
        if (areEqualAddresses(rest.wallet, SIX529_MUSEUM)) {
          rest.ens = '6529Museum';
        } else {
          rest.ens = '';
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
        const ownerMetric = ownerMetricProcessed.find((om) =>
          areEqualAddresses(om.wallet, tdhProcessed.wallet)
        );
        if (ownerMetric) {
          combined.push({ ...tdhProcessed, ...ownerMetric });
        }
        return combined;
      },
      []
    );

    combinedArray.sort((a, b) => a.tdh_rank - b.tdh_rank);

    converter.json2csv(combinedArray, async (err: any, csv: any) => {
      if (err) throw err;

      let transaction = await arweave.createTransaction(
        { data: Buffer.from(csv) },
        config.arweave.ARWEAVE_KEY
      );
      transaction.addTag('Content-Type', 'text/csv');

      await arweave.transactions.sign(transaction, config.arweave.ARWEAVE_KEY);

      let uploader = await arweave.transactions.getUploader(transaction);

      while (!uploader.isComplete) {
        await uploader.uploadChunk();
        console.log(
          new Date(),
          '[TDH UPLOAD]',
          `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
        );
      }

      await db.persistTdhUpload(
        block,
        dateString,
        `https://arweave.net/${transaction.id}`
      );
    });
  } else {
    console.log(
      new Date(),
      '[TDH UPLOAD]',
      `[BLOCK ${block}]`,
      `[TDH ${tdh.length}]`,
      `[OWNER METRICS ${ownerMetrics.length}]`
    );
    console.log(
      new Date(),
      `[TDH UPLOAD]`,
      `[TODAY'S TDH UPLOAD ALREADY EXISTS AT ${lastUpload.tdh}]`,
      `[SKIPPING...]`
    );
  }
};

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
