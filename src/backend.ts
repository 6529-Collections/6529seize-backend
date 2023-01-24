import { findArtists } from './artists';
import { GRADIENT_CONTRACT, MEMES_CONTRACT } from './constants';
import * as db from './db';
import { findExistingEns, findNewEns } from './ens';
import { Artist } from './entities/IArtist';
import { ENS } from './entities/IENS';
import { NFT, NFTWithTDH } from './entities/INFT';
import { Owner, OwnerTags } from './entities/IOwner';
import { Transaction } from './entities/ITransaction';
import { delay, getLastTDH } from './helpers';
import { findMemesExtendedData } from './memes_extended_data';
import { findNFTs } from './nfts';
import { findNftMarketStats } from './nft_market_stats';
import { findNftTDH } from './nft_tdh';
import { findOwners } from './owners';
import { findOwnerTags } from './owners_tags';
import { findOwnerMetrics } from './owner_metrics';
import { persistS3 } from './s3';
import { findTDH } from './tdh';
import { uploadTDH } from './tdh_upload';
import { findTransactions } from './transactions';
import { findTransactionValues, runValues } from './transaction_values';

const cron = require('node-cron');

let STARTING = true;

// PULL EVERY 2 MINUTES
cron.schedule('*/2 * * * *', async function () {
  if (!STARTING) {
    nftsLoop();
  }
});

async function nftsLoop() {
  console.log(new Date(), '[RUNNING NFTS LOOP]');
  await nfts();
  await owners();
  await memesExtendedData();
  await ownerTags();
  nftS3();
}

// PULL EVERY 3 MINUTES
cron.schedule('*/3 * * * *', async function () {
  if (!STARTING) {
    transactionsLoop();
  }
});

async function transactionsLoop() {
  const now = new Date();
  console.log(now, '[RUNNING TRANSACTIONS LOOP]');
  await transactions();
  discoverEns(now);
}

// PULL EVERY 7 MINUTES
cron.schedule('*/7 * * * *', async function () {
  if (!STARTING) {
    ownerMetrics();
  }
});

// MARKET STATS MEMES
// - PULL EVERY 2 HOURS IN STAGING
// - PULL EVERY 8 MINUTES IN PROD
let memesMarketStatsCron;
if (process.env.NODE_ENV == 'development') {
  memesMarketStatsCron = '8 */2 * * *';
} else if (process.env.NODE_ENV == 'production') {
  memesMarketStatsCron = '*/8 * * * *';
}

if (memesMarketStatsCron) {
  cron.schedule(memesMarketStatsCron, async function () {
    if (!STARTING) {
      marketStats(MEMES_CONTRACT);
    }
  });
} else {
  console.log(
    new Date(),
    `[CONFIG ${process.env.NODE_ENV}]`,
    '[SKIPPING MARKET STATS MEMES]'
  );
}

// MARKET STATS GRADIENTS
// - PULL EVERY 4 HOURS IN STAGING
// - PULL EVERY 30 MINUTES IN PROD
let gradientsMarketStatsCron;
if (process.env.NODE_ENV == 'development') {
  gradientsMarketStatsCron = '38 */4 * * *';
} else if (process.env.NODE_ENV == 'production') {
  gradientsMarketStatsCron = '*/30 * * * *';
}

if (gradientsMarketStatsCron) {
  cron.schedule(gradientsMarketStatsCron, async function () {
    if (!STARTING) {
      marketStats(GRADIENT_CONTRACT);
    }
  });
} else {
  console.log(
    new Date(),
    `[CONFIG ${process.env.NODE_ENV}]`,
    '[SKIPPING MARKET STATS GRADIENTS]'
  );
}

// DISCOVER ENS AT 5:29
cron.schedule('29 5 * * *', async function () {
  discoverEns();
});

// REFRESH ENS AT 6:29
cron.schedule('29 6 * * *', async function () {
  refreshEns();
});

// CALCULATE TDH AT 00:01
cron.schedule('1 0 * * *', async function () {
  tdh();
});

// CALCULATE TDH AT 00:30
cron.schedule('30 0 * * *', async function () {
  nftTdh();
});

// UPLOAD TDH AT 01:01
cron.schedule('1 1 * * *', async function () {
  tdhUpload();
});

async function replayTransactionValues(
  transactions?: Transaction[],
  index?: number
) {
  if (!transactions || !index) {
    const transactionHashes = await db.findDuplicateTransactionHashes();
    transactions = await db.findTransactionsByHash(transactionHashes);
    // transactions = await db.findReplayTransactions();
    index = 0;
  }

  try {
    const chunkSize = 100;
    console.log(
      new Date(),
      `[TRANSACTIONS REPLAY ${transactions.length}]`,
      `[CHUNK ${index / chunkSize + 1} / ${Math.ceil(
        transactions.length / chunkSize
      )}]`
    );
    const chunk = transactions!.slice(index, index + chunkSize);
    const transactionsWithValues = await findTransactionValues(chunk);
    await db.persistTransactions(transactionsWithValues);
    if (transactions.length / chunkSize > index / chunkSize + 1) {
      await replayTransactionValues(transactions, index + chunkSize);
    }
  } catch (err: any) {
    console.log(
      new Date(),
      '[TRANSACTIONS REPLAY]',
      `[EXCEPTION AT ${index}]`,
      `[RETRYING]`,
      `[${err}]`
    );
    await replayTransactionValues(transactions, index);
  }
}

async function transactions(
  startingBlock?: number,
  latestBlock?: number,
  pagKey?: string
) {
  try {
    let startingBlockResolved;
    if (startingBlock == undefined) {
      startingBlockResolved = await db.fetchLatestTransactionsBlockNumber();
    } else {
      startingBlockResolved = startingBlock;
    }

    const response = await findTransactions(
      startingBlockResolved,
      latestBlock,
      pagKey
    );

    const transactionsWithValues = await findTransactionValues(
      response.transactions
    );

    await db.persistTransactions(transactionsWithValues);

    if (response.pageKey) {
      await transactions(
        startingBlockResolved,
        response.latestBlock,
        response.pageKey
      );
    }
  } catch (e: any) {
    console.log(
      new Date(),
      '[TRANSACTIONS]',
      '[ETIMEDOUT!]',
      e,
      '[RETRYING PROCESS]'
    );
    await transactions(startingBlock, latestBlock, pagKey);
  }
}

async function transactionsREMAKE(
  startingBlock: number,
  latestBlock?: number,
  pagKey?: string
) {
  try {
    let startingBlockResolved;
    if (startingBlock == undefined) {
      startingBlockResolved = await db.fetchLatestTransactionsBlockNumber();
    } else {
      startingBlockResolved = startingBlock;
    }

    const response = await findTransactions(
      startingBlockResolved,
      latestBlock,
      pagKey
    );

    const transactionsWithValues = await findTransactionValues(
      response.transactions
    );

    await db.persistTransactionsREMAKE(transactionsWithValues);

    if (response.pageKey) {
      await transactionsREMAKE(
        startingBlockResolved,
        response.latestBlock,
        response.pageKey
      );
    } else {
      console.log(new Date(), '[TRANSACTIONS REMAKE]', '[DONE!]');
    }
  } catch (e: any) {
    console.log(
      new Date(),
      '[TRANSACTIONS REMAKE]',
      '[ETIMEDOUT!]',
      e,
      '[RETRYING PROCESS]'
    );
    await transactionsREMAKE(startingBlock, latestBlock, pagKey);
  }
}

async function nfts(reset = false) {
  const nfts: NFTWithTDH[] = await db.fetchAllNFTs();
  const transactions: Transaction[] = await db.fetchAllTransactions();
  const artists: Artist[] = await db.fetchAllArtists();
  artists.map((a: any) => {
    a.memes = JSON.parse(a.memes);
    a.gradients = JSON.parse(a.gradients);
  });

  const newNfts = await findNFTs(nfts, transactions, reset);
  const newArtists = await findArtists(artists, newNfts);
  await db.persistNFTS(newNfts);
  await db.persistArtists(newArtists);
  if (reset) {
    await nftTdh();
  }
}

async function marketStats(contract: string) {
  const nfts: NFT[] = await db.fetchNftsForContract(contract);
  const stats = await findNftMarketStats(contract, nfts);
  await db.persistNftMarketStats(stats);
}

async function owners() {
  const owners: Owner[] = await db.fetchAllOwners();
  const newOwners = await findOwners(owners);
  await db.persistOwners(newOwners);
}

async function ownerMetrics(reset?: boolean) {
  const owners = await db.fetchAllOwnersAddresses();
  const ownerMetrics = await db.fetchAllOwnerMetrics();
  const newOwnerMetrics = await findOwnerMetrics(
    owners,
    ownerMetrics,
    db,
    reset
  );
  await db.persistOwnerMetrics(newOwnerMetrics);
}

async function ownerTags() {
  const nfts = await db.fetchAllNFTs();
  const owners: Owner[] = await db.fetchAllOwners();
  const ownersTags: OwnerTags[] = await db.fetchAllOwnerTags();
  const ownerTagsDelta = await findOwnerTags(nfts, owners, ownersTags);
  await db.persistOwnerTags(ownerTagsDelta);
}

async function memesExtendedData() {
  const nfts = await db.fetchAllNFTs();
  const owners = await db.fetchAllOwners();
  const newMeta = await findMemesExtendedData(nfts, owners);
  await db.persistMemesExtendedData(newMeta);
}

async function tdh() {
  const lastTDHCalc = getLastTDH();

  const block = await db.fetchLatestTransactionsBlockNumber(lastTDHCalc);
  const nfts = await db.fetchAllNFTs();
  const owners = await db.fetchAllOwnersAddresses();

  const tdhResponse = await findTDH(block, lastTDHCalc, nfts, owners, db);
  await db.persistTDH(
    tdhResponse.block,
    tdhResponse.timestamp,
    tdhResponse.tdh
  );
}

async function refetchTransactionValues(page: number) {
  try {
    const transactions: Transaction[] = await db.fetchTransactionsWithoutValue(
      200,
      page
    );
    const transactionsWithValues = await findTransactionValues(transactions);
    await db.persistTransactions(transactionsWithValues);
    if (transactions.length == 200) {
      await refetchTransactionValues(page + 1);
    } else {
      console.log(new Date(), '[TRANSACTION VALUES]', '[ALL REFETCHED!]');
    }
  } catch (e: any) {
    console.log(
      new Date(),
      '[TRANSACTION VALUES]',
      '[CRASH!]',
      `[RESTARTING FROM PAGE ${page} IN 5 SECONDS]`
    );
    await delay(5000);
    await refetchTransactionValues(page);
  }
}

async function nftTdh() {
  const tdh = await db.fetchAllTDH();

  const nftTdh = await findNftTDH(tdh);

  await db.persistNftTdh(nftTdh);
}

async function nftS3() {
  if (process.env.NODE_ENV == 'production') {
    const nfts = await db.fetchAllNFTs();
    persistS3(nfts);
  } else {
    console.log(
      new Date(),
      '[S3]',
      '[SKIPPING]',
      `[CONFIG ${process.env.NODE_ENV}]`
    );
  }
}

async function discoverEns(datetime?: Date) {
  try {
    const missingEns = await db.fetchMissingEns(datetime);
    if (missingEns.length > 0) {
      const newEns = await findNewEns(missingEns);
      await db.persistENS(newEns);
      await discoverEns(datetime);
    }
  } catch (e: any) {
    if (e.message.includes('ETIMEDOUT') || e.message.includes('429')) {
      console.log(
        new Date(),
        '[ENS NEW]',
        '[ETIMEDOUT!]',
        '[RETRYING PROCESS]'
      );
      await discoverEns(datetime);
    }
  }
}

async function refreshEns() {
  try {
    const startingEns: ENS[] = await db.fetchEnsRefresh();
    if (startingEns.length > 0) {
      const deltaEns = await findExistingEns(startingEns);
      await db.persistENS(deltaEns);
      refreshEns();
    } else {
      console.log(new Date(), '[ENS REFRESH]', '[DONE!]');
    }
  } catch (e: any) {
    if (e.message.includes('ETIMEDOUT') || e.message.includes('429')) {
      console.log(
        new Date(),
        '[ENS EXISTING]',
        '[ETIMEDOUT!]',
        '[RETRYING PROCESS]'
      );
      refreshEns();
    }
  }
}

async function tdhUpload() {
  const tdh = await db.fetchAllTDH();
  const ownerMetrics = await db.fetchAllOwnerMetrics();
  uploadTDH(tdh, ownerMetrics, db);
}

async function start() {
  const now = new Date();
  console.log(
    now,
    `[CONFIG ${process.env.NODE_ENV}]`,
    `[EXECUTING START SCRIPT...]`
  );
  // Uncomment to call on start
  // await transactions();
  // await discoverEns(now);
  // await nfts();
  // await memesExtendedData();
  // await owners();
  // await ownerTags();
  // await tdh();
  // await nftTdh();
  // tdhUpload();
  // discoverEns();
  // runValues();
  // await replayTransactionValues();
  // await ownerMetrics(true);
  STARTING = false;
  console.log(new Date(), `[START SCRIPT COMPLETE]`, `[SERVICE STARTED...]`);
}

start();
