import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper, SqlTransactionOptions } from '@/sql-executor';
import type { DropsApiService } from '@/api/drops/drops.api.service';

type TransactionRunner = {
  executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<any>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T>;
};

/**
 * Reads a drop that this invocation has just committed from the writer, so
 * the caller no longer has to sleep for the read replica to catch up.
 *
 * The read runs in its own short READ COMMITTED transaction after the write
 * has committed. It only issues consistent reads, so it takes no row locks
 * and does not extend the write transaction.
 */
export function findCommittedDropOnWriter(
  {
    dropId,
    db,
    dropsService
  }: {
    dropId: string;
    db: TransactionRunner;
    dropsService: Pick<DropsApiService, 'findDropByIdOrThrow'>;
  },
  ctx: RequestContext
): Promise<ApiDrop> {
  return db.executeNativeQueriesInTransaction(
    (connection) =>
      dropsService.findDropByIdOrThrow(
        { dropId, skipEligibilityCheck: true },
        { ...ctx, connection }
      ),
    { isolationLevel: 'READ COMMITTED' }
  );
}
