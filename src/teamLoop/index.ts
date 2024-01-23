import { readFileSync, createReadStream } from 'fs';
import { replaceTeam } from '../db';
import { Team } from '../entities/ITeam';
import { loadEnv } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const Arweave = require('arweave');
const csvParser = require('csv-parser');

const logger = Logger.get('TEAM_LOOP');

const FILE_DIR = `${__dirname}/team.csv`;

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export const handler = sentryContext.wrapLambdaHandler(
  async (event?: any, context?: any) => {
    logger.info('[RUNNING]');
    await loadEnv([Team]);
    await saveTeam();
    await uploadTeam();
    logger.info('[COMPLETE]');
  }
);

async function saveTeam() {
  const team: Team[] = [];
  const csv = await readCsvFile(FILE_DIR);
  logger.info(`[TEAM MEMBERS ${csv.length}]`);
  csv.forEach((t) => {
    const data: any[] = Object.values(t);
    const tm = new Team();
    tm.name = data[0]!;
    tm.collection = data[1]!;
    tm.wallet = data[2];
    team.push(tm);
  });
  await replaceTeam(team);
}

async function uploadTeam() {
  const arweaveKey = process.env.ARWEAVE_KEY
    ? JSON.parse(process.env.ARWEAVE_KEY)
    : {};

  const fileData = readFileSync(FILE_DIR);

  logger.info(`[FILE LOADED]`);

  const transaction = await myarweave.createTransaction(
    { data: Buffer.from(fileData) },
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
