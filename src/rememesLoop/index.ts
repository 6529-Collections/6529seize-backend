import { createReadStream } from 'fs';
import { loadEnv } from '../secrets';
import { Rememe, RememeUpload } from '../entities/IRememe';
import { Alchemy } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS, CLOUDFRONT_LINK } from '../constants';
import {
  deleteRememes,
  fetchRememes,
  persistRememe,
  persistRememesUpload
} from '../db';
import converter from 'json-2-csv';
import { persistRememesS3 } from '../s3_rememes';
import { areEqualAddresses, getContentType } from '../helpers';

const Arweave = require('arweave');
const csvParser = require('csv-parser');

const FILE_DIR = `${__dirname}/rememes.csv`;

interface CSVData {
  contract: string;
  id: number;
  memes: number[];
}

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export const handler = async (event?: any, context?: any) => {
  console.log('[RUNNING REMEMES]');
  const start = new Date().getTime();
  await loadEnv([Rememe, RememeUpload]);
  const rememes: Rememe[] = await fetchRememes();
  const csvData = await loadRememes();

  // await processRememes(rememes, csvData);
  // await uploadRememes();
  await persistS3();

  console.log(
    '[REMEMES COMPLETE]',
    `[${(new Date().getTime() - start) / 1000} seconds]`
  );
};

async function loadRememes() {
  const csvData: CSVData[] = [];

  const csv = await readCsvFile(FILE_DIR);
  csv.map((r) => {
    const contract = r[0].trim();
    const tokenIdStr = r[1].trim();
    if (tokenIdStr.includes('to')) {
      const tokenIdArr = tokenIdStr.split(' to ');
      for (
        let tokenId = parseInt(tokenIdArr[0]);
        tokenId <= parseInt(tokenIdArr[1]);
        tokenId++
      ) {
        const memes = r[2].split(',').map((m: string) => parseInt(m));
        csvData.push({ contract, id: tokenId, memes });
      }
    } else {
      const id = parseInt(tokenIdStr);
      const memes = r[2].split(',').map((m: string) => parseInt(m));
      csvData.push({ contract, id, memes });
    }
  });
  return csvData;
}

async function processRememes(rememes: Rememe[], csvData: CSVData[]) {
  const alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const deleteRememesList = [...rememes].filter(
    (r) =>
      !csvData.some(
        (d) => areEqualAddresses(r.contract, d.contract) && r.id == d.id
      )
  );

  const addDataList = [...csvData].filter(
    (d) =>
      !rememes.some(
        (r) => areEqualAddresses(r.contract, d.contract) && r.id == d.id
      )
  );

  console.log(
    `[REMEMES PROCESSING]`,
    `[EXISTING ${rememes.length}]`,
    `[FILE ${csvData.length}]`,
    `[ADD ${addDataList.length}]`,
    `[DELETE ${deleteRememesList.length}]`
  );

  let addRememesCount = 0;

  await Promise.all(
    addDataList.map(async (d) => {
      try {
        const nftMeta = await alchemy.nft.getNftMetadata(d.contract, d.id, {});
        if (!nftMeta.metadataError) {
          const contractOpenseaData = nftMeta.contract.openSea;
          const deployer = nftMeta.contract.contractDeployer;
          const tokenUri = nftMeta.tokenUri;
          const tokenType = nftMeta.contract.tokenType;
          const media = nftMeta.media;
          const metadata = nftMeta.rawMetadata;

          const image = metadata
            ? metadata.image
              ? metadata.image
              : metadata.image_url
              ? metadata.image_url
              : ''
            : '';
          const animation = metadata
            ? metadata.animation
              ? metadata.animation
              : metadata.animation_url
              ? metadata.animation_url
              : ''
            : '';

          const originalFormat = await getContentType(image);

          let s3Original = null;
          let s3Scaled = null;
          let s3Thumbnail = null;
          let s3Icon = null;

          if (originalFormat) {
            s3Original = `${CLOUDFRONT_LINK}/rememes/images/original/${d.contract}-${d.id}.${originalFormat}`;
            s3Scaled = `${CLOUDFRONT_LINK}/rememes/images/scaled/${d.contract}-${d.id}.${originalFormat}`;
            s3Thumbnail = `${CLOUDFRONT_LINK}/rememes/images/thumbnail/${d.contract}-${d.id}.${originalFormat}`;
            s3Icon = `${CLOUDFRONT_LINK}/rememes/images/icon/${d.contract}-${d.id}.${originalFormat}`;
          }

          const r: Rememe = {
            created_at: new Date(),
            contract: d.contract,
            id: d.id,
            deployer: deployer,
            token_uri: tokenUri ? tokenUri.raw : ``,
            token_type: tokenType,
            meme_references: d.memes,
            metadata,
            image,
            animation,
            contract_opensea_data: contractOpenseaData,
            media: media,
            s3_image_original: s3Original,
            s3_image_scaled: s3Scaled,
            s3_image_thumbnail: s3Thumbnail,
            s3_image_icon: s3Icon
          };
          console.log(
            '[REMEME PROCESSED]',
            `[CONTRACT ${d.contract}]`,
            `[ID ${d.id}]`
          );
          await persistRememe(r);
          addRememesCount++;
        } else {
          console.log(
            '[REMEMES]',
            `[METADATA ERROR]`,
            `[CONTRACT ${d.contract}]`,
            `[ID ${d.id}]`,
            `[ERROR ${nftMeta.metadataError}]`
          );
        }
      } catch (e) {
        console.log(
          '[REMEMES ERROR]',
          `[CONTRACT ${d.contract}]`,
          `[ID ${d.id}]`,
          `[ERROR ${e}]`
        );
      }
    })
  );

  await deleteRememes(deleteRememesList);

  console.log(
    `[REMEMES PROCESSED]`,
    `[ADDED ${addRememesCount}]`,
    `[DELETED ${deleteRememesList.length}]`
  );
}

async function upload(rememes: Rememe[]) {
  const arweaveKey = process.env.ARWEAVE_KEY
    ? JSON.parse(process.env.ARWEAVE_KEY)
    : {};

  console.log('[REMEMES]', `[UPLOADING TO ARWEAVE]`);

  const csv = await converter.json2csvAsync(rememes);

  let transaction = await myarweave.createTransaction(
    { data: Buffer.from(csv) },
    arweaveKey
  );

  transaction.addTag('Content-Type', 'text/csv');

  console.log(`[REMEMES]`, `[SIGNING ARWEAVE TRANSACTION]`);

  await myarweave.transactions.sign(transaction, arweaveKey);

  let uploader = await myarweave.transactions.getUploader(transaction);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    console.log(
      new Date(),
      '[REMEMES]',
      `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
    );
  }

  const url = `https://arweave.net/${transaction.id}`;
  console.log(`[REMEMES]`, `[ARWEAVE LINK ${url}]`);

  await persistRememesUpload(`https://arweave.net/${transaction.id}`);
}

async function readCsvFile(filePath: string): Promise<any[]> {
  const results: any[] = [];
  return new Promise((resolve, reject) => {
    createReadStream(filePath)
      .pipe(csvParser({ headers: false }))
      .on('data', (data: any) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

async function uploadRememes() {
  const rememes: Rememe[] = await fetchRememes();
  await upload(rememes);
}

async function persistS3() {
  if (process.env.NODE_ENV == 'local') {
    const rememes: Rememe[] = await fetchRememes();
    await persistRememesS3(rememes);
  } else {
    console.log(`[REMEMES]`, `[SKIPPING S3 UPLOAD]`, `[NOT PRODUCTION]`);
  }
}
