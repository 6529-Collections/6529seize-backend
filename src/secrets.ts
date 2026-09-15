import { connect, disconnect, type DbConnectionSelection } from './db';
import { prepEnvironment } from './env';
import { Logger } from './logging';
import { Time } from './time';
import { initRedis } from './redis';

async function loadEnv(
  entities: any[] = [],
  syncEntities = false,
  selection?: DbConnectionSelection
) {
  await prepEnvironment();
  if (selection) await connect(entities, syncEntities, selection);
  else await connect(entities, syncEntities);
}

export async function doInDbContext<T>(
  fn: () => Promise<T>,
  opts?: {
    entities?: any[];
    logger?: Logger;
    syncEntities?: boolean;
    skipRedis?: boolean;
    databaseSelection?: DbConnectionSelection;
  }
): Promise<T> {
  const start = Time.now();
  const logger = opts?.logger ?? Logger.get('MAIN');
  logger.info(`[RUNNING]`);
  // Capture this internal selection before loading mutable environment secrets.
  const selection = opts?.databaseSelection
    ? Object.freeze({ ...opts.databaseSelection })
    : undefined;
  await loadEnv(opts?.entities ?? [], opts?.syncEntities ?? false, selection);
  try {
    if (!opts?.skipRedis) await initRedis();
    return await fn();
  } finally {
    logger.info(`[FINISHED IN ${start.diffFromNow().formatAsDuration()}]`);
    await unload();
  }
}

async function unload() {
  await disconnect();
}
