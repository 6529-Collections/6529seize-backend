import { connect, disconnect } from './db';
import { prepEnvironment } from './env';
import { Logger } from './logging';
import { Time } from './time';

async function loadEnv(entities: any[] = []) {
  await prepEnvironment();
  await connect(entities);
}

export async function doInDbContext<T>(
  fn: () => Promise<T>,
  opts?: { entities?: any[]; logger?: Logger }
): Promise<T> {
  const start = Time.now();
  const logger = opts?.logger ?? Logger.get('MAIN');
  logger.info(`[RUNNING]`);
  await loadEnv(opts?.entities ?? []);
  try {
    return await fn();
  } finally {
    logger.info(`[FINISHED IN ${start.diffFromNow().formatAsDuration()}]`);
    await unload();
  }
}

async function unload() {
  await disconnect();
}
