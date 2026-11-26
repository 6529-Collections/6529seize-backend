import { MEMES_MINT_PRICE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { IdentityDirectory } from '../identity/identity-directory';
import { assembleOpening, OpeningFiles } from './opening-assemble';
import { readLegacyTables, walletsInTables } from './legacy-tables';

/**
 * Cuts the opening file: reads every legacy table, the key-width guard's
 * waiting writes and the wallets' identities in one REPEATABLE READ
 * transaction, so the file is one moment of the tables.
 */
export async function cutOpeningFiles(
  directory: IdentityDirectory,
  nowMs: number = Date.now()
): Promise<OpeningFiles> {
  return sqlExecutor.executeNativeQueriesInTransaction(
    async (connection) => {
      const options = { wrappedConnection: connection };
      const { cut, tables } = await readLegacyTables(options);
      const byWallet = await directory.identitiesOf(
        walletsInTables(tables),
        options
      );
      return assembleOpening(
        {
          ...cut,
          at: new Date(nowMs).toISOString(),
          mintPrice: MEMES_MINT_PRICE
        },
        tables,
        byWallet
      );
    },
    { isolationLevel: 'REPEATABLE READ' }
  );
}
