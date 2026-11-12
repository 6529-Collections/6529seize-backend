import { connect, disconnect, type DbConnectionSelection } from './db';
import type { SchemaSyncOptions } from './db/bounded-schema-sync';

type SchemaSyncAcknowledgement = Pick<
  SchemaSyncOptions,
  'acknowledgedDestructivePlanSha256'
>;
import { prepEnvironment } from './env';
import { Logger } from './logging';
import { Time } from './time';
import { initRedis } from './redis';

async function loadEnv(
  entities: any[] = [],
  syncEntities = false,
  selection?: DbConnectionSelection,
  schemaSync?: SchemaSyncAcknowledgement
) {
  await prepEnvironment();
  if (selection) await connect(entities, syncEntities, selection);
  else if (schemaSync)
    await connect(entities, syncEntities, undefined, schemaSync);
  else await connect(entities, syncEntities);
}

export async function doInDbContext<T>(
  fn: () => Promise<T>,
  opts?: {
    entities?: any[];
    logger?: Logger;
    syncEntities?: boolean;
    skipRedis?: boolean;
    reportRedisConnectionRecovery?: boolean;
    databaseSelection?: DbConnectionSelection;
    /** Passed to the schema sync that `syncEntities` runs. */
    schemaSync?: SchemaSyncAcknowledgement;
  }
): Promise<T> {
  const start = Time.now();
  const logger = opts?.logger ?? Logger.get('MAIN');
  logger.info(`[RUNNING]`);
  // Capture this internal selection before loading mutable environment secrets.
  const selection = opts?.databaseSelection
    ? Object.freeze({ ...opts.databaseSelection })
    : undefined;
  await loadEnv(
    opts?.entities ?? [],
    opts?.syncEntities ?? false,
    selection,
    opts?.schemaSync
  );
  try {
    if (!opts?.skipRedis)
      await initRedis({
        reportConnectionRecovery: opts?.reportRedisConnectionRecovery
      });
    return await fn();
  } finally {
    logger.info(`[FINISHED IN ${start.diffFromNow().formatAsDuration()}]`);
    await unload();
  }
}

async function unload() {
  await disconnect();
}
