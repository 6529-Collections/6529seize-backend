const transactions = require('./transactionsLoop');
const nfts = require('./nftsLoop');
const memeLab = require('./memeLabLoop');
const tdh = require('./tdhLoop');
const team = require('./teamLoop');
const rememes = require('./rememesLoop');
const ownerMetrics = require('./ownerMetricsLoop');
const s3 = require('./s3Loop');
const discoverEnsLoop = require('./discoverEnsLoop');
const refreshEnsLoop = require('./refreshEnsLoop');
const royaltiesLoop = require('./royaltiesLoop');
const delegations = require('./delegationsLoop');
const nftHistory = require('./nftHistoryLoop');

const { memeStats, memeLabStats, gradientStats } = require('./marketStatsLoop');

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

// PULL EVERY 2 MINUTES
cron.schedule('*/2 * * * *', async function () {
  if (!STARTING) {
    await delegations.handler();
  }
});

// PULL EVERY 30 MINUTES
cron.schedule('*/30 * * * *', async function () {
  if (!STARTING) {
    await nftHistory.handler();
  }
});

// PULL EVERY HOUR AT MIN 0
cron.schedule('0 * * * *', async function () {
  if (!STARTING) {
    // memeStats();
  }
});

// PULL EVERY 2 HOURS AT MIN 15
cron.schedule('15 */2 * * *', async function () {
  if (!STARTING) {
    // gradientStats();
  }
});

// PULL EVERY HOUR AT MIN 30
cron.schedule('30 * * * *', async function () {
  if (!STARTING) {
    // memeLabStats();
  }
});

// CALCULATE TDH AT 00:01,00:15,00:30,00:45
cron.schedule('1,15,30,45 0 * * *', async function () {
  tdh.handler();
});

// UPLOAD ROYALTIES AT 04:01
cron.schedule('1 4 * * *', async function () {
  await royaltiesLoop.handler();
});

async function start() {
  const now = new Date();
  console.log(
    now,
    `[CONFIG ${process.env.NODE_ENV}]`,
    `[EXECUTING START SCRIPT...]`
  );

  // Uncomment to call on start

  // await nftHistory.handler();
  // await delegations.handler();
  // await transactions.handler();
  // await nfts.handler();
  // await memeLab.handler();
  // await ownerMetrics.handler();
  await tdh.handler();
  // await memeStats();
  // await gradientStats();
  // await memeLabStats();
  // await s3.handler();
  // await team.handler();
  // await discoverEnsLoop.handler();
  // await refreshEnsLoop.handler();
  // await royaltiesLoop.handler();
  // await transactions.handlerValues();
  // await rememes.handler();

  STARTING = false;
  console.log(new Date(), `[START SCRIPT COMPLETE]`, `[SERVICE STARTED...]`);
}

start();
