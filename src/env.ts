import { Logger } from './logging';

const dotenv = require('dotenv');
const path = require('path');

export async function prepEnvironment() {
  const logger = Logger.get('ENV_READER');
  const envPath = path.join(__dirname, '..', `.env.lite`);
  logger.info(`[LOADING LOCAL CONFIG FROM ${envPath}]`);
  dotenv.config({
    path: envPath
  });
}
