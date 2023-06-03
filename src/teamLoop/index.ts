import { readFileSync, createReadStream } from 'fs';
import { replaceTeam } from '../db';
import { Team } from '../entities/ITeam';
import { loadEnv } from '../secrets';

const Arweave = require('arweave');
const csvParser = require('csv-parser');

const FILE_DIR = `${__dirname}/team.csv`;

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING UPLOAD TEAM]');
  await loadEnv([Team]);
  await saveTeam();
  await uploadTeam();
  console.log(new Date(), '[UPLOAD TEAM COMPLETE]');
};

async function saveTeam() {
  const team: Team[] = [];
  const csv = await readCsvFile(FILE_DIR);
  console.log(`[TEAM MEMBERS ${csv.length}]`);
  csv.map((t) => {
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

  console.log(new Date(), `[TEAM UPLOAD]`, `[FILE LOADED]`);

  let transaction = await myarweave.createTransaction(
    { data: Buffer.from(fileData) },
    arweaveKey
  );

  transaction.addTag('Content-Type', 'text/csv');

  console.log(new Date(), `[TEAM UPLOAD]`, `[SIGNING ARWEAVE TRANSACTION]`);

  await myarweave.transactions.sign(transaction, arweaveKey);

  let uploader = await myarweave.transactions.getUploader(transaction);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    console.log(
      new Date(),
      '[TEAM UPLOAD]',
      `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
    );
  }

  const url = `https://arweave.net/${transaction.id}`;
  console.log(new Date(), `[TEAM UPLOADED]`, `[ARWEAVE LINK ${url}]`);
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
