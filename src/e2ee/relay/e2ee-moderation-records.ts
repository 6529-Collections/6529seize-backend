import { afterCommit } from '@/db/after-commit';
import { E2eeRecordFamily } from '@/e2ee/relay/e2ee-record-event';
import {
  e2eeRecordRowReader,
  E2eeRecordWhere,
  E2eeRecordWriters,
  e2eeRecordWriters
} from '@/e2ee/relay/e2ee-record-writers';
import {
  E2eeStreamPublisher,
  e2eeStreamPublisher,
  E2eeTransactionRunner
} from '@/e2ee/relay/e2ee-stream-publisher';
import { Logger } from '@/logging';
import { ConnectionWrapper } from '@/sql-executor';

const logger = Logger.get('E2EE_MODERATION_RECORDS');

export interface E2eeModerationRecorderDeps {
  readonly publisher: Pick<
    E2eeStreamPublisher,
    'mode' | 'batch' | 'publishLater' | 'queueDeletion'
  >;
  readonly writers: Pick<E2eeRecordWriters, 'moderationRowsChanged'>;
  readonly runner: E2eeTransactionRunner;
}

/**
 * Records writes of the report tables in the moderators' inbox, sealed
 * to the moderation service key. Moderators keep reading reports in
 * 6529.io's moderation tool, from MySQL, as today; the records are what a
 * rebuild restores the tables from.
 *
 * The report services own their transactions, and a report must never fail
 * because a relay is down. So the record is written after the report's
 * transaction commits, in a short transaction of its own that locks the
 * inbox before it reads the rows (the later of two writers reads the later
 * rows), and is published best effort; the outbox retries it. A record that
 * could not be written at all is logged, and the `md` backfill copies it.
 */
export class E2eeModerationRecorder {
  constructor(private readonly deps: () => E2eeModerationRecorderDeps) {}

  /**
   * Records the rows of `table` matching `where` once the transaction that
   * owns `connection` commits (at once without one). Never throws, and does
   * nothing while E2EE_RELAY_MODE is off.
   */
  async changed(
    table: string,
    where: E2eeRecordWhere,
    connection?: ConnectionWrapper<any>,
    options: { readonly dropOlder?: boolean } = {}
  ): Promise<void> {
    try {
      if (this.deps().publisher.mode() === 'off') return;
      await afterCommit(
        connection,
        () => this.record(table, where, options.dropOlder),
        `e2ee-moderation:${table}:${JSON.stringify(where)}`
      );
    } catch (error) {
      logger.warn(
        `[REPORT RECORD] ${table} not recorded: ${(error as Error).message}`
      );
    }
  }

  /**
   * Items the delivery service deleted or expired outside a record batch
   * (its prunes): DELs are queued for the records that carry them. Never
   * throws, and does nothing while records are off.
   */
  async deleted(
    family: E2eeRecordFamily,
    owner: string,
    keys: readonly string[]
  ): Promise<void> {
    try {
      await this.deps().publisher.queueDeletion(family, owner, keys);
    } catch (error) {
      logger.warn(
        `[DEL] ${family}/${owner} not queued: ${(error as Error).message}`
      );
    }
  }

  /**
   * Writes the record now, with one retry (a lock wait that timed out);
   * returns the rows copied, 0 when it could not be written.
   */
  async record(
    table: string,
    where: E2eeRecordWhere,
    dropOlder = false
  ): Promise<number> {
    const { publisher, writers, runner } = this.deps();
    let failure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const batch = publisher.batch();
        if (!batch) return 0;
        const copied = await runner.executeNativeQueriesInTransaction(
          (connection) =>
            writers.moderationRowsChanged(batch, connection, {
              table,
              where,
              dropOlder
            })
        );
        publisher.publishLater(batch);
        return copied;
      } catch (error) {
        failure = error;
      }
    }
    logger.warn(
      `[REPORT RECORD] ${table} not recorded; the md backfill copies it: ${(failure as Error).message}`
    );
    return 0;
  }
}

export const e2eeModerationRecorder = new E2eeModerationRecorder(() => ({
  publisher: e2eeStreamPublisher,
  writers: e2eeRecordWriters,
  runner: e2eeRecordRowReader
}));
