import { fetchRoyalties, persistRoyaltiesUpload } from './db';
import converter from 'json-2-csv';
import { Logger } from './logging';

const logger = Logger.get('ROYALTIES');

const Arweave = require('arweave');

interface Royalty {
  date: string;
  contract: string;
  card_id: number;
  artist: string;
  transactions_count: number;
  token_count: number;
  received_royalties: number;
}

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

function getDate() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);

  yesterday.setUTCMonth(today.getUTCMonth());
  yesterday.setUTCFullYear(today.getUTCFullYear());
  return yesterday;
}

export const findRoyalties = async () => {
  const startDate = getDate();
  startDate.setUTCHours(0, 0, 0, 0);
  const endDate = getDate();
  endDate.setUTCHours(23, 59, 59, 999);
  logger.info(
    `[START DATE ${startDate.toUTCString()}] [END DATE ${endDate.toUTCString()}]`
  );

  const royalties = await fetchRoyalties(startDate, endDate);

  const year = startDate.getFullYear();
  const month = ('0' + (startDate.getMonth() + 1)).slice(-2);
  const day = ('0' + startDate.getDate()).slice(-2);
  const formattedDate = `${year}-${month}-${day}`;

  const myRoyalties: Royalty[] = [];
  royalties.map((r: any) => {
    const newR: Royalty = {
      date: formattedDate,
      contract: r.contract,
      card_id: parseInt(r.token_id),
      artist: r.artist,
      transactions_count: parseInt(r.transactions_count),
      token_count: parseInt(r.token_count),
      received_royalties:
        Math.round(parseFloat(r.total_royalties) * 100000000) / 100000000
    };
    myRoyalties.push(newR);
  });

  const url = await uploadRoyalties(formattedDate, myRoyalties);
  await persistRoyaltiesUpload(startDate, url);
};

async function uploadRoyalties(formattedDate: string, royalties: Royalty[]) {
  const uploadArray: any[] = [];
  royalties.map((r) => {
    const uploadRoyalty: any = r;
    uploadRoyalty.date = formattedDate;
    delete uploadRoyalty.created_at;
    delete uploadRoyalty.id;
    uploadArray.push(uploadRoyalty);
  });

  uploadArray.sort((a, b) => {
    if (a.contract < b.contract) {
      return 1;
    }
    if (a.contract > b.contract) {
      return -1;
    }
    if (a.token_id < b.token_id) {
      return 1;
    }
    if (a.token_id > b.token_id) {
      return -1;
    }
    return 0;
  });

  const csv = await converter.json2csvAsync(uploadArray);

  const arweaveKey = process.env.ARWEAVE_KEY
    ? JSON.parse(process.env.ARWEAVE_KEY)
    : {};

  const transaction = await myarweave.createTransaction(
    { data: Buffer.from(csv) },
    arweaveKey
  );

  transaction.addTag('Content-Type', 'text/csv');

  logger.info(`[SIGNING ARWEAVE TRANSACTION]`);

  await myarweave.transactions.sign(transaction, arweaveKey);

  const uploader = await myarweave.transactions.getUploader(transaction);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    logger.info(
      `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
    );
  }

  const url = `https://arweave.net/${transaction.id}`;
  return url;
}
