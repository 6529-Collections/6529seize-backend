import { afterCommit } from '@/db/after-commit';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import {
  E2eeRecordWriters,
  e2eeRecordWriters
} from '@/e2ee/relay/e2ee-record-writers';
import {
  E2eeRecordBatch,
  E2eeRelayQuorumError,
  E2eeStreamPublisher,
  e2eeStreamPublisher,
  E2eeTransactionRunner
} from '@/e2ee/relay/e2ee-stream-publisher';
import { ConnectionWrapper } from '@/sql-executor';

type Conn = ConnectionWrapper<unknown>;

/** The delivery service's relay records: the publisher and the builders. */
export interface E2eeRecords {
  readonly publisher: E2eeStreamPublisher;
  readonly writers: E2eeRecordWriters;
}

export const defaultE2eeRecords: E2eeRecords = {
  publisher: e2eeStreamPublisher,
  writers: e2eeRecordWriters
};

/**
 * Runs a write's own transaction with a record batch (null while
 * E2EE_RELAY_MODE is off). In `primary` mode a write whose records the
 * relays cannot confirm rolls back and answers 503.
 */
export async function runE2eeRecordTransaction<T>(
  records: E2eeRecords | undefined,
  runner: E2eeTransactionRunner,
  work: (connection: Conn, batch: E2eeRecordBatch | null) => Promise<T>
): Promise<T> {
  if (!records) {
    return runner.executeNativeQueriesInTransaction((connection) =>
      work(connection, null)
    );
  }
  try {
    return await records.publisher.run(runner, work);
  } catch (error) {
    if (error instanceof E2eeRelayQuorumError) {
      throw e2eeErrors.relaysUnavailable();
    }
    throw error;
  }
}

/** Runs `record` only when records are on (a batch exists). */
export async function recordE2ee(
  records: E2eeRecords | undefined,
  batch: E2eeRecordBatch | null,
  record: (writers: E2eeRecordWriters, batch: E2eeRecordBatch) => Promise<void>
): Promise<void> {
  if (batch && records) await record(records.writers, batch);
}

/**
 * A record batch inside a transaction another service owns. Its records
 * are published once that transaction commits, in every mode: the caller,
 * not the delivery service, decides when it commits.
 */
export async function e2eeRecordBatchIn(
  records: E2eeRecords | undefined,
  connection: Conn
): Promise<E2eeRecordBatch | null> {
  const batch = records?.publisher.batch() ?? null;
  if (batch && records) {
    await afterCommit(connection, () => records.publisher.afterCommit(batch));
  }
  return batch;
}
