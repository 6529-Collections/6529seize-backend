import { createHash } from 'node:crypto';
import type { PoolConnection } from 'mysql';
import type { QueryRunner } from 'typeorm';
import { MEMES_CONTRACT } from '@/constants';
import { getDataSource } from '@/db';
import { SOURCE_QUERY_BUDGET_MS, WalletTransferAnalysisError } from './types';

export interface BackfillDatabaseIdentity {
  server_uuid: string;
  database_name: string;
}

export interface BackfillRunnerLease {
  assertHeld(): Promise<void>;
}

function runnerLockName(identity: BackfillDatabaseIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'wallet-transfer-backfill-v1',
        identity.server_uuid.toLowerCase(),
        identity.database_name,
        MEMES_CONTRACT.toLowerCase()
      ])
    )
    .digest('hex');
}

async function firstRow(
  runner: QueryRunner,
  statement: string,
  parameters: string[] = []
): Promise<Record<string, unknown> | undefined> {
  try {
    const rows: unknown = await runner.query(statement, parameters);
    return Array.isArray(rows) &&
      rows[0] !== null &&
      typeof rows[0] === 'object'
      ? (rows[0] as Record<string, unknown>)
      : undefined;
  } catch {
    throw new WalletTransferAnalysisError(
      'Backfill runner lease query failed; stop work'
    );
  }
}

function isTrue(value: unknown): boolean {
  return value === 1 || value === '1' || value === true;
}

async function verifyDatabase(
  runner: QueryRunner,
  expected: BackfillDatabaseIdentity
): Promise<void> {
  const actual = await firstRow(
    runner,
    `SELECT /*+ MAX_EXECUTION_TIME(${SOURCE_QUERY_BUDGET_MS}) */
     @@server_uuid AS server_uuid, DATABASE() AS database_name`
  );
  if (
    typeof actual?.server_uuid !== 'string' ||
    actual.server_uuid.toLowerCase() !== expected.server_uuid.toLowerCase() ||
    actual.database_name !== expected.database_name
  ) {
    throw new WalletTransferAnalysisError(
      'Backfill runner database identity changed; stop work'
    );
  }
}

function createLease(
  runner: QueryRunner,
  lockName: string
): BackfillRunnerLease {
  let lost = false;
  return {
    async assertHeld() {
      if (lost) {
        throw new WalletTransferAnalysisError(
          'Backfill runner lease was lost; stop work'
        );
      }
      try {
        const row = await firstRow(
          runner,
          `SELECT /*+ MAX_EXECUTION_TIME(${SOURCE_QUERY_BUDGET_MS}) */
           IS_USED_LOCK(?) = CONNECTION_ID() AS held`,
          [lockName]
        );
        if (!isTrue(row?.held)) {
          throw new WalletTransferAnalysisError(
            'Backfill runner lease was lost; stop work'
          );
        }
      } catch {
        lost = true;
        throw new WalletTransferAnalysisError(
          'Backfill runner lease was lost; stop work'
        );
      }
    }
  };
}

async function releaseLease(
  runner: QueryRunner,
  physical: PoolConnection,
  lockName: string
): Promise<void> {
  try {
    const row = await firstRow(runner, 'SELECT RELEASE_LOCK(?) AS released', [
      lockName
    ]);
    if (!isTrue(row?.released)) {
      throw new WalletTransferAnalysisError(
        'Could not release backfill runner lease'
      );
    }
  } catch {
    // Never return a live connection with an uncertain advisory lock to its pool.
    physical.destroy();
    throw new WalletTransferAnalysisError(
      'Backfill runner lease cleanup failed; connection discarded'
    );
  }
}

/** One server-wide runner per database/contract; holds no transaction snapshot. */
export async function withBackfillRunnerLock<T>(
  identity: BackfillDatabaseIdentity,
  work: (lease: BackfillRunnerLease) => Promise<T>
): Promise<T> {
  const runner = getDataSource().createQueryRunner();
  const lockName = runnerLockName(identity);
  let physical: PoolConnection | undefined;
  let releaseRequired = false;
  try {
    physical = (await runner.connect()) as PoolConnection;
    await verifyDatabase(runner, identity);
    // Even a failed response can follow a successful server-side acquisition.
    releaseRequired = true;
    const row = await firstRow(runner, 'SELECT GET_LOCK(?, 0) AS acquired', [
      lockName
    ]);
    if (row?.acquired === 0 || row?.acquired === '0') {
      releaseRequired = false;
      throw new WalletTransferAnalysisError(
        'Another backfill runner already holds the database lease'
      );
    }
    if (!isTrue(row?.acquired)) {
      throw new WalletTransferAnalysisError(
        'Could not acquire backfill runner lease'
      );
    }
    return await work(createLease(runner, lockName));
  } finally {
    try {
      if (releaseRequired && physical) {
        await releaseLease(runner, physical, lockName);
      }
    } finally {
      await runner.release();
    }
  }
}
