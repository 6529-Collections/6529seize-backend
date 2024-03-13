import { connect, disconnect } from './db';
import { prepEnvironment } from './env';

export async function loadEnv(entities: any[] = []) {
  await prepEnvironment();
  await connect(entities);
}

export async function unload() {
  await disconnect();
}
