import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  Network
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
import { Logger } from './logging';

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

let alchemy: Alchemy;
let cloudfront: CloudFrontClient;
let s3: S3Client;
let myBucket: string;
let network: Network.ETH_GOERLI | Network.ETH_MAINNET;
let s3Path: string;
let generatorNetworkPath: string;

const logger = Logger.get('NEXTGEN');

export function getNextGenNetwork() {
  if (process.env.NEXTGEN_CHAIN_ID) {
    const chainId: number = parseInt(process.env.NEXTGEN_CHAIN_ID);
    if (chainId === 5) {
      return Network.ETH_GOERLI;
    }
  }
  return Network.ETH_MAINNET;
}

function load() {
  network = getNextGenNetwork();
  s3Path = `nextgen/tokens/images/${network}-${NEXTGEN_CONTRACT[network]}`;
  generatorNetworkPath = network === Network.ETH_GOERLI ? 'testnet' : 'mainnet';

  alchemy = new Alchemy({
    network: network,
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
  logger.info({
    task: 'FIND NEXTGEN TOKENS',
    start_block: startBlock,
    latest_block: latestBlock,
    network: network
  });

  await findTransactions(startBlock, latestBlock, pageKey);
};

export const refreshNextgenTokens = async () => {
  load();

  const enabled = process.env.NEXTGEN_REFRESH_ENABLED === 'true';
  if (!enabled) {
    logger.info(`[REFRESH TOKENS DISABLED]`);
    return;
  }

  const imageResponse = await s3.send(
    new ListObjectsCommand({
      Bucket: myBucket,
      Prefix: s3Path
    })
  );

  if (imageResponse.Contents) {
    logger.info(`[TOKENS TO REFRESH ${imageResponse.Contents.length}]`);

    await Promise.all(
      imageResponse.Contents.map(async (i) => {
        const key = i.Key!.split('/');
        const image = key[key.length - 1];
        const tokenId = parseInt(image.split('.')[0]);
        await persistImage(tokenId);
      })
    );
  } else {
    logger.info(`[NO TOKENS TO REFRESH]`);
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

  logger.info(`[TRANSACTIONS FOUND ${transactionsResponse.transfers.length}]`);

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

  logger.info({
    task: 'GET ALL TRANSACTIONS',
    from_block: startingBlockHex,
    to_block: latestBlockHex,
    page_key: key
  });

  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.ERC721],
    contractAddresses: [NEXTGEN_CONTRACT[network]],
    withMetadata: true,
    maxCount: 150,
    fromBlock: startingBlockHex,
    toBlock: latestBlockHex,
    fromAddress: NULL_ADDRESS,
    pageKey: key
  };

  const response = await alchemy.core.getAssetTransfers(settings);
  return response;
}

async function persistNewTokens(newTokens: number[]) {
  logger.info(`[PROCESSING IMAGES FOR ${newTokens.length} NEW TOKENS]`);
  await Promise.all(
    newTokens.map(async (tokenId) => {
      await persistImage(tokenId);
    })
  );
}

async function persistImage(tokenId: number) {
  const imageKey = `${s3Path}/${tokenId}.png`;
  const imageExists = await objectExists(s3, myBucket, imageKey);
  const generatorUrl = `https://nextgen-generator.seize.io/${generatorNetworkPath}/png/${tokenId}`;
  const cfUrl = getCFLink(tokenId);

  let imageCompare: boolean;
  if (imageExists) {
    imageCompare = await compareImages(cfUrl, generatorUrl);
  } else {
    imageCompare = false;
  }

  logger.info({
    task: 'PERSIST IMAGE',
    token_id: tokenId,
    image_exists: imageExists,
    image_compare: imageCompare
  });

  if (!imageExists || !imageCompare) {
    const blob = await fetchImage(generatorUrl);
    logger.info(`[IMAGE ${tokenId} DOWNLOADED]`);

    const uploadedImage = await s3.send(
      new PutObjectCommand({
        Bucket: myBucket,
        Key: imageKey,
        Body: Buffer.from(blob),
        ContentType: `image/png`
      })
    );

    logger.info(
      `[TOKEN ${tokenId}] [IMAGE PERSISTED AT ${uploadedImage.ETag}]`
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

      logger.info(`[TOKEN ${tokenId}] [IMAGE INVALIDATED]`);
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
  return `${CLOUDFRONT_LINK}/${s3Path}/${tokenId}.png`;
}
