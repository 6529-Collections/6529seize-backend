import { connect, disconnect } from './db';
import { prepEnvironment } from './env';

export async function loadEnv() {
  await prepEnvironment();
  await connect();
}

export async function unload() {
  await disconnect();
}
