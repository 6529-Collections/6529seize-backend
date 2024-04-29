import { TRANSACTIONS_TABLE } from './constants';
import { Consolidation, Delegation } from './entities/IDelegation';
import { Transaction } from './entities/ITransaction';
import { Logger } from './logging';
import { loadEnv } from './secrets';
import { sqlExecutor } from './sql-executor';

const logger = Logger.get('RESTORE_DUMPS');

const BASE_PATH =
  'https://6529bucket.s3.eu-west-1.amazonaws.com/db-dumps/development';

export async function restoreDumps() {
  await loadEnv([Transaction, Delegation, Consolidation]);
  await restoreDump(TRANSACTIONS_TABLE);
}

async function restoreDump(tableName: string) {
  logger.info(`[TABLE ${tableName}] : [RESTORING...]`);

  const response = await fetch(`${BASE_PATH}/${tableName}.csv`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const csvText = await response.text();
  const rows = csvText.split('\n');

  logger.info(`[TABLE ${tableName}] : [FOUND ${rows.length} ROWS]`);

  await sqlExecutor.executeNativeQueriesInTransaction(
    async (wrappedConnection) => {
      await sqlExecutor.execute(`DELETE FROM ${tableName}`, [], {
        wrappedConnection
      });
      await Promise.all(
        queries.map((query) =>
          sqlExecutor.execute(query, undefined, { wrappedConnection })
        )
      );
    }
  );

  logger.info(`[TABLE ${tableName}] : [RESTORED]`);
}

restoreDumps();
