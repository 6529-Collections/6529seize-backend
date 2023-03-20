import { ALCHEMY_SETTINGS, ROYALTIES_ADDRESS } from './constants';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  AssetTransfersWithMetadataResult
} from 'alchemy-sdk';
import { fetchRoyalties, persistRoyaltiesUpload } from './db';
import converter from 'json-2-csv';

const EthDater = require('ethereum-block-by-date');
const fetch = require('node-fetch');

let alchemy: Alchemy;
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

const findRoyaltiesAddressTransactionsForPage = async (
  alchemy: Alchemy,
  startingBlockHex: string,
  endingBlockHex: string,
  pageKey: any
) => {
  const settings: AssetTransfersWithMetadataParams = {
    category: [
      AssetTransfersCategory.ERC20,
      AssetTransfersCategory.INTERNAL,
      AssetTransfersCategory.EXTERNAL
    ],
    excludeZeroValue: true,
    withMetadata: true,
    maxCount: 250,
    fromBlock: startingBlockHex,
    toBlock: endingBlockHex,
    toAddress: ROYALTIES_ADDRESS
  };

  if (pageKey) {
    settings.pageKey = pageKey;
  }

  const response = await alchemy.core.getAssetTransfers(settings);
  return response;
};

const findRoyaltiesAddressTransactions = async (
  alchemy: Alchemy,
  startingBlockHex: string,
  endingBlockHex: string,
  transfers: AssetTransfersWithMetadataResult[] = [],
  pageKey: string = ''
): Promise<AssetTransfersWithMetadataResult[]> => {
  const response = await findRoyaltiesAddressTransactionsForPage(
    alchemy,
    startingBlockHex,
    endingBlockHex,
    pageKey
  );

  const newKey = response.pageKey;
  transfers = transfers.concat(response.transfers);

  if (newKey) {
    return findRoyaltiesAddressTransactions(
      alchemy,
      startingBlockHex,
      endingBlockHex,
      transfers,
      pageKey
    );
  }

  return transfers;
};

function getDate() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);

  yesterday.setUTCMonth(today.getUTCMonth());
  yesterday.setUTCFullYear(today.getUTCFullYear());
  return yesterday;
}

export const findRoyalties = async () => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const royaltiesDate = getDate();

  const provider = await alchemy.config.getProvider();
  const dater = new EthDater(provider);

  const date = new Date(royaltiesDate);
  const start = date.setUTCHours(0, 0, 0);
  const end = date.setUTCHours(23, 59, 59);

  const startingBlock = await dater.getDate(start, true);
  const endingBlock = await dater.getDate(end, false);

  console.log(
    '[ROYALTIES]',
    `[START BLOCK ${startingBlock.block} - ${new Date(
      startingBlock.timestamp * 1000
    ).toUTCString()}]`,
    `[END BLOCK ${endingBlock.block} - ${new Date(
      endingBlock.timestamp * 1000
    ).toUTCString()}]`
  );

  const royalties = await fetchRoyalties(
    startingBlock.block,
    endingBlock.block
  );

  const year = royaltiesDate.getFullYear();
  const month = ('0' + (royaltiesDate.getMonth() + 1)).slice(-2);
  const day = ('0' + royaltiesDate.getDate()).slice(-2);
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
  await persistRoyaltiesUpload(royaltiesDate, url);
};

async function uploadRoyalties(formattedDate: String, royalties: Royalty[]) {
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

  let transaction = await myarweave.createTransaction(
    { data: Buffer.from(csv) },
    arweaveKey
  );

  transaction.addTag('Content-Type', 'text/csv');

  console.log(
    new Date(),
    `[ROYALTIES UPLOAD]`,
    `[SIGNING ARWEAVE TRANSACTION]`
  );

  await myarweave.transactions.sign(transaction, arweaveKey);

  let uploader = await myarweave.transactions.getUploader(transaction);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    console.log(
      '[ROYALTIES UPLOAD]',
      `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
    );
  }

  const url = `https://arweave.net/${transaction.id}`;
  return url;
}
