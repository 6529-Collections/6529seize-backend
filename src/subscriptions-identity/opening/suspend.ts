import { SUBSCRIPTIONS_ID_STATE_TABLE } from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import {
  OPENING_STATE_ID,
  subscriptionsIdentitySwitch,
  suspendIdentityTables
} from '../identity/identity-switch';
import { journal } from '../timeline/journal';

const logger = Logger.get('SUBSCRIPTIONS_OPENING');

/**
 * Rollback, journaled: the suspend goes into the journal (kind `suspend`)
 * in the transaction that sets it, so a rebuild sees where the opening
 * stopped taking writes. A rollback can't wait on the record log: if the
 * entry can't be written, the tables are suspended anyway, and it alerts.
 * Returns whether an opening is loaded (and now suspended).
 */
export async function suspendWithJournal(
  nowMs: number = Date.now()
): Promise<boolean> {
  try {
    let loaded = false;
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const options = { wrappedConnection: connection };
      const [state] = await sqlExecutor.execute<{
        suspended_at: number | string | null;
      }>(
        `SELECT suspended_at FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id FOR UPDATE`,
        { id: OPENING_STATE_ID },
        options
      );
      if (!state) {
        return;
      }
      loaded = true;
      if (state.suspended_at !== null) {
        return;
      }
      await journal(
        { kind: 'suspend', inputs: { suspended_at: nowMs }, atMs: nowMs },
        options
      );
      await sqlExecutor.execute(
        `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE} SET suspended_at = :nowMs WHERE id = :id`,
        { nowMs, id: OPENING_STATE_ID },
        options
      );
    });
    subscriptionsIdentitySwitch.invalidate();
    return loaded;
  } catch (error) {
    logger.errorWithCode(
      'SUBSCRIPTIONS_JOURNAL_APPEND_FAILED',
      `[SUSPEND NOT JOURNALED] suspending without a journal entry: ${(error as Error).message}`
    );
    return suspendIdentityTables(nowMs);
  }
}
