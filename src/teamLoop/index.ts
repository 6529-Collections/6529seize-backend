import { arweaveFileUploader } from '@/arweave';
import { createReadStream, readFileSync } from 'fs';
import { replaceTeam } from '../db';
import { Team } from '../entities/ITeam';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

const csvParser = require('csv-parser');

const logger = Logger.get('TEAM_LOOP');

const FILE_DIR = `${__dirname}/team.csv`;

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await saveTeam();
      await uploadTeam();
    },
    { logger, entities: [Team] }
  );
});

/** Fills the team table from team.csv in this folder, the list's source. */
export async function saveTeam() {
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
  const { url } = await arweaveFileUploader.uploadFile(
    readFileSync(FILE_DIR),
    'text/csv'
  );
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
