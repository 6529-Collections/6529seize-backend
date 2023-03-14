import { TDH } from '../entities/ITDH';
import { areEqualAddresses } from '../helpers';
import converter from 'json-2-csv';
import { persistTdhUpload } from '../db';
import { OwnerMetric } from '../entities/IOwner';

const Arweave = require('arweave');

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export async function uploadTDH(tdhResponse: {
  tdhDate: Date;
  block: any;
  date: Date;
  tdh: TDH[];
  ownerMetrics: OwnerMetric[];
}) {
  console.log(
    '[TDH REPLAY UPLOAD]',
    `[BLOCK ${tdhResponse.block}]`,
    `[TDH REPLAY ${tdhResponse.tdh.length}]`,
    `[OWNER METRICS ${tdhResponse.ownerMetrics.length}]`
  );

  const ownerMetricProcessed = tdhResponse.ownerMetrics.map((om) => {
    const { balance, ...rest } = om;
    return rest;
  });

  const combinedArray = tdhResponse.tdh.reduce(
    (combined: any[], tdhProcessed) => {
      const ownerMetric = ownerMetricProcessed.find((om) =>
        areEqualAddresses(om.wallet, tdhProcessed.wallet)
      );
      if (ownerMetric) {
        const newCombined: any = { ...tdhProcessed, ...ownerMetric };
        delete newCombined.date;
        delete newCombined.transaction_reference;
        newCombined.created_at = tdhResponse.tdhDate.toISOString();
        combined.push(newCombined);
      }
      return combined;
    },
    []
  );

  combinedArray.sort((a, b) => a.tdh_rank - b.tdh_rank);

  combinedArray.sort((a, b) => a.tdh_rank - b.tdh_rank);

  console.log(`[TDH REPLAY UPLOAD]`, `[CREATING CSV]`);

  const csv = await converter.json2csvAsync(combinedArray);

  console.log(`[TDH REPLAY UPLOAD]`, `[CSV CREATED]`);

  const arweaveKey = process.env.ARWEAVE_KEY
    ? JSON.parse(process.env.ARWEAVE_KEY)
    : {};

  let transaction = await myarweave.createTransaction(
    { data: Buffer.from(csv) },
    arweaveKey
  );

  transaction.addTag('Content-Type', 'text/csv');

  console.log(`[TDH REPLAY UPLOAD]`, `[SIGNING ARWEAVE TRANSACTION]`);

  await myarweave.transactions.sign(transaction, arweaveKey);

  let uploader = await myarweave.transactions.getUploader(transaction);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    console.log(
      '[TDH REPLAY UPLOAD]',
      `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
    );
  }

  const url = `https://arweave.net/${transaction.id}`;

  await persistTdhUpload(
    tdhResponse.block,
    formatDate(tdhResponse.tdhDate),
    `https://arweave.net/${transaction.id}`
  );

  console.log(`[TDH REPLAY UPLOAD]`, `[ARWEAVE LINK ${url}]`);
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
