import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams
} from 'alchemy-sdk';
import {
  CLOUDFRONT_DISTRIBUTION,
  CLOUDFRONT_LINK,
  NEXTGEN_CONTRACT,
  NULL_ADDRESS
} from './constants';
import {
  fetchLatestNextgenTransactionsBlockNumber,
  persistNextgenTransactionsBlockNumber
} from './db';
import { objectExists } from './helpers/s3_helpers';
import {
  ListObjectsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  CloudFrontClient,
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';
import { RequestInfo, RequestInit } from 'node-fetch';

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

let alchemy: Alchemy;
let cloudfront: CloudFrontClient;
let s3: S3Client;
let myBucket: string;

const NEXTGEN_S3_PATH = 'nextgen/tokens/images';

function load() {
  alchemy = new Alchemy({
    network: NEXTGEN_CONTRACT.network,
    maxRetries: 10,
    apiKey: process.env.ALCHEMY_API_KEY
  });
  s3 = new S3Client({ region: 'eu-west-1' });
  cloudfront = new CloudFrontClient({ region: 'eu-west-1' });
  myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;
}

export const findNextgenTokens = async (pageKey?: string) => {
  load();

  let startBlock: number;
  const startBlockEnv = process.env.NEXTGEN_START_BLOCK
    ? parseInt(process.env.NEXTGEN_START_BLOCK)
    : null;

  if (startBlockEnv) {
    startBlock = startBlockEnv;
  } else {
    startBlock = await fetchLatestNextgenTransactionsBlockNumber();
  }
  const latestBlock = await alchemy.core.getBlockNumber();
  console.log(
    '[NEXTGEN TOKEN TRANSACTIONS]',
    `[START BLOCK ${startBlock}]`,
    `[LATEST BLOCK ON CHAIN ${latestBlock}]`
  );

  await findTransactions(startBlock, latestBlock, pageKey);
};

export const refreshNextgenTokens = async () => {
  load();

  const enabled = process.env.NEXTGEN_REFRESH_ENABLED === 'true';
  if (!enabled) {
    console.log('[NEXTGEN TOKEN REFRESH]', `[REFRESH DISABLED]`);
    return;
  }

  const imageResponse = await s3.send(
    new ListObjectsCommand({
      Bucket: myBucket,
      Prefix: NEXTGEN_S3_PATH
    })
  );

  if (imageResponse.Contents) {
    console.log(
      '[NEXTGEN TOKEN REFRESH]',
      `[TOKENS TO REFRESH ${imageResponse.Contents.length}]`
    );

    await Promise.all(
      imageResponse.Contents.map(async (i) => {
        const tokenId = parseInt(i.Key!.split('/')[3].split('.')[0]);
        await persistImage(tokenId, getCFLink(tokenId));
      })
    );
  } else {
    console.log(
      '[NEXTGEN TOKEN REFRESH]',
      `[NO TOKENS FOUND ON S3 AT ${NEXTGEN_S3_PATH}]`
    );
  }
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

  transactionsResponse.transfers
    .sort((a, b) =>
      a.metadata.blockTimestamp.localeCompare(b.metadata.blockTimestamp)
    )
    .map((t) => {
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
      await persistImage(tokenId);
    })
  );
}

async function persistImage(tokenId: number, url?: string) {
  const imageKey = `${NEXTGEN_S3_PATH}/${tokenId}.png`;
  const imageExists = await objectExists(s3, myBucket, imageKey);
  const generatorUrl = `https://nextgen-generator.seize.io/png/${tokenId}`;

  let imageCompare: boolean;
  if (url && imageExists) {
    imageCompare = await compareImages(url, generatorUrl);
  } else {
    imageCompare = true;
  }

  console.log(
    '[S3]',
    `[TOKEN ${tokenId}]`,
    `[EXISTS ${imageExists}]`,
    `[COMPARE ${imageCompare}]`
  );

  if (!imageExists || !imageCompare) {
    const blob = await fetchImage(generatorUrl);
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
      '[NEXTGEN TOKEN IMAGE]',
      `[TOKEN ${tokenId}]`,
      `[IMAGE PERSISTED AT ${uploadedImage.ETag}`
    );

    if (!imageCompare) {
      await cloudfront.send(
        new CreateInvalidationCommand({
          DistributionId: CLOUDFRONT_DISTRIBUTION,
          InvalidationBatch: {
            CallerReference: Date.now().toString(),
            Paths: {
              Quantity: 1,
              Items: [`/${imageKey}`]
            }
          }
        })
      );

      console.log(
        '[NEXTGEN TOKEN IMAGE]',
        `[TOKEN ${tokenId}]`,
        `[IMAGE URL INVALIDATED]`
      );
    }
  }
}

async function fetchImage(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  return await response.arrayBuffer();
}

async function compareImages(url1: string, url2: string): Promise<boolean> {
  try {
    const [image1, image2] = await Promise.all([
      fetchImage(url1),
      fetchImage(url2)
    ]);
    const data1 = new Uint8Array(image1);
    const data2 = new Uint8Array(image2);
    const areImagesEqual = JSON.stringify(data1) === JSON.stringify(data2);
    return areImagesEqual;
  } catch (error) {
    console.error('Error fetching or comparing images:', error);
    return false;
  }
}

function getCFLink(tokenId: number) {
  return `${CLOUDFRONT_LINK}/${NEXTGEN_S3_PATH}/${tokenId}.png`;
}
