import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams
} from 'alchemy-sdk';
import { NEXTGEN_CONTRACT, NULL_ADDRESS } from './constants';
import {
  fetchLatestNextgenTransactionsBlockNumber,
  persistNextgenTransactionsBlockNumber
} from './db';
import { objectExists } from './helpers/s3_helpers';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RequestInfo, RequestInit } from 'node-fetch';

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

let alchemy: Alchemy;
let s3: S3Client;
let myBucket: string;

export const findNextgenTokens = async (pageKey?: string) => {
  alchemy = new Alchemy({
    network: NEXTGEN_CONTRACT.network,
    maxRetries: 10,
    // ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });
  s3 = new S3Client({ region: 'eu-west-1' });
  myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

  const startingBlock = await fetchLatestNextgenTransactionsBlockNumber();
  const latestBlock = await alchemy.core.getBlockNumber();
  console.log(
    '[NEXTGEN TOKEN TRANSACTIONS]',
    `[STARTING BLOCK ${startingBlock}]`,
    `[LATEST BLOCK ON CHAIN ${latestBlock}]`
  );

  await findTransactions(startingBlock, latestBlock, pageKey);
};

export const findTransactions = async (
  startingBlock: number,
  latestBlock: number,
  pageKey?: string
) => {
  const transactionsResponse = await getAllTransactions(
    startingBlock,
    latestBlock,
    pageKey
  );

  console.log(
    new Date(),
    '[NEXTGEN TOKEN TRANSACTIONS]',
    `[FOUND ${transactionsResponse.transfers.length} NEW TRANSACTIONS]`
  );

  const newTokens: number[] = [];

  transactionsResponse.transfers.map((t) => {
    if (t.erc721TokenId) {
      const tokenId = parseInt(t.erc721TokenId, 16);
      newTokens.push(tokenId);
    }
  });

  await persistNewTokens(newTokens);

  if (transactionsResponse.pageKey) {
    await findTransactions(startingBlock, latestBlock, pageKey);
  } else {
    await persistNextgenTransactionsBlockNumber(latestBlock);
  }
};

async function getAllTransactions(
  startingBlock: number,
  latestBlock: number,
  key: any
) {
  const startingBlockHex = `0x${startingBlock.toString(16)}`;
  const latestBlockHex = `0x${latestBlock.toString(16)}`;

  console.log(
    new Date(),
    '[NEXTGEN TOKEN TRANSACTIONS]',
    `[FROM BLOCK ${startingBlockHex}]`,
    `[TO BLOCK ${latestBlockHex}]`,
    `[PAGE KEY ${key}]`
  );

  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.ERC721],
    contractAddresses: [NEXTGEN_CONTRACT.contract],
    withMetadata: true,
    maxCount: 150,
    fromBlock: startingBlockHex,
    toBlock: latestBlockHex,
    fromAddress: NULL_ADDRESS,
    pageKey: key ? key : undefined
  };

  const response = await alchemy.core.getAssetTransfers(settings);
  return response;
}

async function persistNewTokens(newTokens: number[]) {
  console.log(
    '[NEXTGEN TOKEN TRANSACTIONS]',
    `[PROCESSING IMAGES FOR ${newTokens.length} NEW TOKENS]`
  );
  await Promise.all(
    newTokens.map(async (tokenId) => {
      const imageKey = `nextgen/tokens/${tokenId}.png`;
      const imageExists = await objectExists(s3, myBucket, imageKey);

      if (!imageExists) {
        console.log('[S3]', `[MISSING IMAGE FOR ${tokenId}]`);

        const imageURL = `https://nextgen-generator.seize.io/png/${tokenId}`;
        const res = await fetch(imageURL);
        const blob = await res.arrayBuffer();
        console.log(
          '[NEXTGEN TOKEN TRANSACTIONS]',
          `[IMAGE ${tokenId} DOWNLOADED]`
        );

        const uploadedImage = await s3.send(
          new PutObjectCommand({
            Bucket: myBucket,
            Key: imageKey,
            Body: Buffer.from(blob),
            ContentType: `image/png`
          })
        );

        console.log(
          '[NEXTGEN TOKEN TRANSACTIONS]',
          `[IMAGE PERSISTED AT ${uploadedImage.ETag}`
        );
      }
    })
  );
}
