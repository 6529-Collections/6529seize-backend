import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper, SqlTransactionOptions } from '@/sql-executor';
import type { DropsApiService } from '@/api/drops/drops.api.service';
import { withPrimaryReads } from '@/db/primary-read-scope';

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

/**
 * Reads a drop this invocation has just committed from the primary, with no
 * transaction (waves 1.8). The drop is already committed, so it needs no
 * snapshot; without one, the mapper's parallel queries each take a pooled
 * primary connection instead of queueing on a single transaction connection.
 */
export function findCommittedDropOnPrimary(
  {
    dropId,
    dropsService
  }: {
    dropId: string;
    dropsService: Pick<DropsApiService, 'findDropByIdOrThrow'>;
  },
  ctx: RequestContext,
  primaryReads: <T>(work: () => Promise<T>) => Promise<T> = withPrimaryReads
): Promise<ApiDrop> {
  return primaryReads(() =>
    dropsService.findDropByIdOrThrow(
      { dropId, skipEligibilityCheck: true },
      { ...ctx, connection: undefined }
    )
  );
}
