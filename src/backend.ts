import * as dbMigrationsLoop from './dbMigrationsLoop';
import { Logger } from './logging';
import { doInDbContext } from './secrets';
import { dbSupplier } from './sql-executor';
import { recalculateXTdhUseCase } from './tdh-grants/recalculate-xtdh.use-case';
import {
  syncIdentitiesMetrics,
  syncIdentitiesWithTdhConsolidations
} from './identity';
import { Timer } from './time';
import { reReviewRatesInTdhGrantsUseCase } from './tdh-grants/re-review-rates-in-tdh-grants.use-case';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await dbMigrationsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );
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
              await syncIdentitiesWithTdhConsolidations(connection);
              const ctx = {
                connection: connection,
                timer: new Timer('PERSIST_TDH')
              };
              await reReviewRatesInTdhGrantsUseCase.handle(ctx);
              await recalculateXTdhUseCase.handle(ctx);
              await syncIdentitiesMetrics(connection);
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
