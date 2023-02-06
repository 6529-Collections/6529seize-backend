const transactions = require('./transactionsLoop');
const nfts = require('./nftsloop');
const tdh = require('./tdhLoop');
const ownerMetrics = require('./ownerMetricsLoop');
const myS3 = require('./s3Loop');

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

// PULL EVERY 7 MINUTES
cron.schedule('*/7 * * * *', async function () {
  if (!STARTING) {
    ownerMetrics.handler();
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

  await transactions.handler();
  await nfts.handler();
  await tdh.handler();
  await ownerMetrics.handler();

  STARTING = false;
  console.log(new Date(), `[START SCRIPT COMPLETE]`, `[SERVICE STARTED...]`);
}

start();
