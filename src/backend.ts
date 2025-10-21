import * as dbMigrationsLoop from './dbMigrationsLoop';
import * as tdhLoop from './tdhLoop';
import { Logger } from './logging';
import { doInDbContext } from './secrets';
import { dbSupplier } from './sql-executor';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await dbMigrationsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );
  await tdhLoop.handler(undefined as any, undefined as any, undefined as any);
  await testInLocal();

  process.exit(0);
}

async function testInLocal() {
  if (process.env.TEST_XTDH_LOCALLY) {
    await doInDbContext(
      async () => {
        await dbSupplier().executeNativeQueriesInTransaction(
          async (connection) => {
            const run = true;
            if (run) {
              //await syncIdentitiesWithTdhConsolidations(connection);
              //const ctx = {
              //  connection: connection,
              //  timer: new Timer('PERSIST_TDH')
              //};
              //await syncIdentitiesWithTdhConsolidations(connection);
              //await reReviewRatesInTdhGrantsUseCase.handle(ctx);
              //await recalculateXTdhUseCase.handle(ctx);
              //await syncIdentitiesMetrics(connection);
            }
          }
        );
      },
      {
        logger
      }
    );
  }
}

start();
