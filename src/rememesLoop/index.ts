import { createReadStream } from 'fs';
import { doInDbContext } from '../secrets';
import { Rememe, RememeSource, RememeUpload } from '../entities/IRememe';
import { Alchemy } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS, CLOUDFRONT_LINK } from '@/constants';
import {
  deleteRememes,
  fetchMissingS3Rememes,
  fetchRememes,
  persistRememes,
  persistRememesUpload
} from '../db';
import converter from 'json-2-csv';
import { persistRememesS3 } from '../s3_rememes';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { equalIgnoreCase } from '../strings';
import { mediaChecker } from '../media-checker';

const Arweave = require('arweave');
const csvParser = require('csv-parser');

const logger = Logger.get('REMEMES_LOOP');

const FILE_DIR = `${__dirname}/rememes.csv`;

interface CSVData {
  contract: string;
  id: string;
  memes: number[];
}

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

let alchemy: Alchemy;

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const loadFile = process.env.REMEMES_LOAD_FILE == 'true';
      const rememesS3 = process.env.REMEMES_S3 == 'true';

      alchemy = new Alchemy({
        ...ALCHEMY_SETTINGS,
        apiKey: process.env.ALCHEMY_API_KEY
      });

      const rememes: Rememe[] = await fetchRememes();

      if (rememesS3) {
        await persistS3();
      } else if (loadFile) {
        const csvData = await loadRememes();
        await processRememes(rememes, csvData);
        await uploadRememes();
      } else {
        await refreshRememes(rememes);
        await uploadRememes();
      }
    },
    {
      logger,
      entities: [Rememe, RememeUpload]
    }
  );
});

async function loadRememes() {
  const csvData: CSVData[] = [];

  const csv = await readCsvFile(FILE_DIR);
  csv.forEach((r) => {
    const contract = r[0].trim();
    const tokenIdStr = r[1].trim().replaceAll(' ', '');
    if (tokenIdStr.includes('to')) {
      const range = getRange(tokenIdStr, 'to');
      for (let tokenId = range.start; tokenId <= range.end; tokenId++) {
        const memes = r[2].split(',').map((m: string) => parseInt(m));
        csvData.push({ contract, id: tokenId.toString(), memes });
      }
    } else if (tokenIdStr.includes('-')) {
      const range = getRange(tokenIdStr, '-');
      for (let tokenId = range.start; tokenId <= range.end; tokenId++) {
        const memes = r[2].split(',').map((m: string) => parseInt(m));
        csvData.push({ contract, id: tokenId.toString(), memes });
      }
    } else if (tokenIdStr.includes(',')) {
      const tokens = tokenIdStr.split(',').map((m: string) => parseInt(m));
      const memes = r[2].split(',').map((m: string) => parseInt(m));
      tokens.map((tokenId: number) => {
        csvData.push({ contract, id: tokenId.toString(), memes });
      });
    } else {
      const memes = r[2].split(',').map((m: string) => parseInt(m));
      csvData.push({ contract, id: tokenIdStr, memes });
    }
  });
  return csvData;
}

function getRange(tokenIdStr: string, delim: string) {
  const tokenIdArr = tokenIdStr.split(delim);

  return {
    start: parseInt(tokenIdArr[0]),
    end: parseInt(tokenIdArr[1])
  };
}

async function processRememes(rememes: Rememe[], csvData: CSVData[]) {
  const deleteRememesList = [...rememes].filter(
    (r) =>
      !csvData.some(
        (d) => equalIgnoreCase(r.contract, d.contract) && r.id == d.id
      )
  );

  const addDataList = [...csvData].filter(
    (d) =>
      !rememes.some(
        (r) => equalIgnoreCase(r.contract, d.contract) && r.id == d.id
      )
  );

  logger.info(
    `[FILE PROCESSING] [EXISTING ${rememes.length}] [FILE ${csvData.length}] [ADD ${addDataList.length}] [DELETE ${deleteRememesList.length}]`
  );

  let addRememesCount = 0;

  await Promise.all(
    addDataList.map(async (d) => {
      try {
        const r = await buildRememe(d.contract, d.id, d.memes);
        if (r) {
          await persistRememes([r]);
          addRememesCount++;
        }
      } catch (e) {
        logger.error(`[CONTRACT ${d.contract}] [ID ${d.id}]`, e);
      }
    })
  );

  await deleteRememes(deleteRememesList);

  logger.info(
    `[FILE PROCESSED] [ADDED ${addRememesCount}] [DELETED ${deleteRememesList.length}]`
  );
}

async function refreshRememes(rememes: Rememe[]) {
  logger.info(`[REFRESHING] [EXISTING ${rememes.length}]`);

  const updateRememesList: Rememe[] = [];
  const retryRememesList: Rememe[] = [];

  await Promise.all(
    rememes.map(async (d) => {
      try {
        const r = await buildRememe(d.contract, d.id, d.meme_references);
        if (r) {
          updateRememesList.push(r);
        }
      } catch (e) {
        logger.error(`[CONTRACT ${d.contract}] [ID ${d.id}]`, e);
        retryRememesList.push(d);
      }
    })
  );

  logger.info(`[REFRESHING] [RETRYING ${retryRememesList.length}]`);

  await Promise.all(
    retryRememesList.map(async (d) => {
      try {
        const r = await buildRememe(d.contract, d.id, d.meme_references);
        if (r) {
          updateRememesList.push(r);
        }
      } catch (e) {
        logger.error(`[RETRY ERROR] [CONTRACT ${d.contract}] [ID ${d.id}]`, e);
      }
    })
  );

  logger.info(`[REFRESHED ${updateRememesList.length}] [PERSISTING...]`);

  await persistRememes(updateRememesList);

  logger.info(`[REFRESH COMPLETE] [REFRESHED ${updateRememesList.length}]`);
}

async function buildRememe(contract: string, id: string, memes: number[]) {
  const nftMeta = await alchemy.nft.getNftMetadata(contract, id, {
    refreshCache: true
  });
  if (!nftMeta.raw.error) {
    const contractOpenseaData = nftMeta.contract.openSeaMetadata;
    const deployer = nftMeta.contract.contractDeployer;
    const tokenUri = nftMeta.tokenUri ? nftMeta.tokenUri : nftMeta.raw.tokenUri;
    const tokenType = nftMeta.contract.tokenType;
    const media = nftMeta.image;
    const metadata = nftMeta.raw.metadata;

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

    const originalFormat = await mediaChecker.getContentType(image);

    let s3Original: string | null = null;
    let s3Scaled: string | null = null;
    let s3Thumbnail: string | null = null;
    let s3Icon: string | null = null;

    if (originalFormat) {
      s3Original = `${CLOUDFRONT_LINK}/rememes/images/original/${contract}-${id}.${originalFormat}`;
      s3Scaled = `${CLOUDFRONT_LINK}/rememes/images/scaled/${contract}-${id}.${originalFormat}`;
      s3Thumbnail = `${CLOUDFRONT_LINK}/rememes/images/thumbnail/${contract}-${id}.${originalFormat}`;
      s3Icon = `${CLOUDFRONT_LINK}/rememes/images/icon/${contract}-${id}.${originalFormat}`;
    }

    const r: Rememe = {
      contract: contract,
      id: id,
      deployer: deployer,
      token_uri: tokenUri || ``,
      token_type: tokenType,
      meme_references: memes,
      metadata,
      image,
      animation,
      contract_opensea_data: contractOpenseaData,
      media: media,
      s3_image_original: s3Original,
      s3_image_scaled: s3Scaled,
      s3_image_thumbnail: s3Thumbnail,
      s3_image_icon: s3Icon,
      source: RememeSource.FILE
    };
    return r;
  } else {
    logger.error(
      `[METADATA ERROR] [CONTRACT ${contract}] [ID ${id}] [ERROR ${nftMeta.raw.error}]`
    );
    return undefined;
  }
}

async function upload(rememes: Rememe[]) {
  const arweaveKey = process.env.ARWEAVE_KEY
    ? JSON.parse(process.env.ARWEAVE_KEY)
    : {};

  logger.info(`[UPLOADING TO ARWEAVE]`);

  const csv = await converter.json2csvAsync(rememes);

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
  logger.info(`[ARWEAVE LINK ${url}]`);

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
  const rememes: Rememe[] = await fetchMissingS3Rememes();
  await persistRememesS3(rememes);
}
