import { findRoyalties } from '../royalties';
import { loadEnv } from '../secrets';

const Arweave = require('arweave');
const csvParser = require('csv-parser');

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export const handler = async (event?: any, context?: any) => {
  console.log('[RUNNING ROYALTIES]');
  await loadEnv();
  await findRoyalties();
  // await saveTeam();
  // await uploadTeam();
  console.log('[ROYALTIES COMPLETE]');
};
