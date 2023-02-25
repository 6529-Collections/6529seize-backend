import { MEMES_CONTRACT } from './constants';

const transactions = require('./transactionsLoop');
const transactionsReplay = require('./transactionsReplayLoop');
const nfts = require('./nftsLoop');
const memeLab = require('./memeLabLoop');
const tdh = require('./tdhLoop');
const ownerMetrics = require('./ownerMetricsLoop');
const s3 = require('./s3Loop');
const { memeStats, memeLabStats } = require('./marketStatsLoop');

const cron = require('node-cron');

let STARTING = true;

// PULL EVERY 4 MINUTES
cron.schedule('*/4 * * * *', async function () {
  if (!STARTING) {
    nfts.handler();
  }
});

// PULL EVERY 3 MINUTES
cron.schedule('*/3 * * * *', async function () {
  if (!STARTING) {
    transactions.handler();
  }
});

// PULL EVERY 5 MINUTES
cron.schedule('*/5 * * * *', async function () {
  if (!STARTING) {
    memeLab.handler();
  }
});

// PULL EVERY 4 MINUTES
cron.schedule('*/4 * * * *', async function () {
  if (!STARTING) {
    ownerMetrics.handler();
  }
});

// PULL EVERY HOUR AT MIN 0
cron.schedule('0 * * * *', async function () {
  if (!STARTING) {
    memeStats();
  }
});

// PULL EVERY HOUR AT MIN 30
cron.schedule('30 * * * *', async function () {
  if (!STARTING) {
    memeLabStats();
  }
});

// CALCULATE TDH AT 00:01,00:15,00:30,00:45
cron.schedule('1,15,30,45 0 * * *', async function () {
  tdh.handler();
});

async function start() {
  const now = new Date();
  console.log(
    now,
    `[CONFIG ${process.env.NODE_ENV}]`,
    `[EXECUTING START SCRIPT...]`
  );

  // Uncomment to call on start

  // await transactionsReplay.handler();
  // await transactions.handler();
  // await nfts.handler();
  // await memeLab.handler();
  // await ownerMetrics.handler();
  // await tdh.handler();
  // memeStats();
  // memeLabStats();
  // await s3.handler();

  STARTING = false;
  console.log(new Date(), `[START SCRIPT COMPLETE]`, `[SERVICE STARTED...]`);
}

start();
