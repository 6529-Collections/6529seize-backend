import 'reflect-metadata';
import { QueryRunner } from 'typeorm';
import {
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
import * as loopDb from '@/db';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { Logger } from '@/logging';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { runMembershipRepositoryDiagnostics } from './membership-repository-diagnostics';
import { withMembershipPrimaryTransaction } from './membership-primary';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';

describeWithSeed('membership staging repository diagnostic', [], () => {
  it('proves rollback and committed coalescing without retaining fixture evidence', async () => {
    const result = await runMembershipRepositoryDiagnostics(sqlExecutor);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'passed',
        source_scenarios: 'transaction_rolled_back',
        concurrent_target_requests: 4,
        fixture_cleanup: { remaining_rows: 0 }
      })
    );
    expect(result.checks).toEqual([
      'missing_source_is_unknown',
      'transactional_source_and_request',
      'duplicate_start_and_overlap_barrier',
      'failed_barrier_and_explicit_resume',
      'delayed_completion_preserves_newer_job',
      'source_and_job_changes_rolled_back',
      'concurrent_committed_target_coalescing'
    ]);
    // Full table checks are confined to this isolated Testcontainers database.
    for (const table of [
      MEMBERSHIP_SOURCE_STATES_TABLE,
      MEMBERSHIP_SOURCE_JOBS_TABLE,
      MEMBERSHIP_REFRESH_TARGETS_TABLE
    ]) {
      expect(await sqlExecutor.execute(`SELECT * FROM ${table}`)).toEqual([]);
    }
  });

  it('runs the complete diagnostic with session limits on the real loop transaction connections', async () => {
    const testExecutor = sqlExecutor;
    // connect normally logs its host; this test only records session evidence.
    const dbInfo = jest.spyOn(Logger.get('DB'), 'info').mockImplementation();
    let executionSpy: jest.SpyInstance | undefined;
    try {
      await loopDb.connect();
      const loopExecutor = sqlExecutor;
      const execute = loopExecutor.execute.bind(loopExecutor);
      const sessions = new Map<QueryRunner, ObservedSession>();
      executionSpy = jest
        .spyOn(loopExecutor, 'execute')
        .mockImplementation(
          async <T>(
            sql: string,
            params?: Record<string, unknown>,
            options?: DbQueryOptions
          ): Promise<T[]> => {
            expect(options?.forcePool).toBe(DbPoolName.WRITE);
            const runner = options?.wrappedConnection
              ?.connection as QueryRunner;
            expect(runner.isTransactionActive).toBe(true);
            // Observe the bound physical connection directly, outside the adapter.
            // All diagnostic SQL still executes through the unmodified loop adapter.
            const before = await readSession(runner);
            const result = await execute<T>(sql, params, options);
            const after = await readSession(runner);
            expect(after.connection_id).toBe(before.connection_id);
            observeSession(
              sessions,
              runner,
              sql,
              params,
              result,
              before,
              after
            );
            return result;
          }
        );

      expect(await runMembershipRepositoryDiagnostics(loopExecutor)).toEqual(
        expect.objectContaining({
          status: 'passed',
          source_scenarios: 'transaction_rolled_back',
          concurrent_target_requests: 4,
          fixture_cleanup: { remaining_rows: 0 }
        })
      );
      expect(sessions.size).toBeGreaterThan(4);
      sessions.forEach((session, runner) => {
        expect(session.boundsApplied).toBe(1);
        expect(session.boundsRestored).toBe(1);
        expect(session.repositoryQueries).toBeGreaterThan(0);
        expect(runner.isReleased).toBe(true);
      });
      executionSpy.mockRestore();
      expect(await snapshot()).toEqual([[], [], []]);
    } finally {
      executionSpy?.mockRestore();
      try {
        if (loopDb.getDataSource()?.isInitialized) await loopDb.disconnect();
      } finally {
        setSqlExecutor(testExecutor);
        dbInfo.mockRestore();
      }
    }
  });

  it('preserves preexisting GLOBAL and unrelated PROFILE evidence', async () => {
    const sources = new MembershipSourceStatesDb(() => sqlExecutor);
    const targets = new MembershipRefreshTargetsDb(() => sqlExecutor);
    await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
      await sources.provision(
        [
          { scope: 'GLOBAL', target_id: '*', dimension: 'IDENTITY' },
          {
            scope: 'PROFILE',
            target_id: 'unrelated-profile',
            dimension: 'IDENTITY'
          }
        ],
        { bootstrap_id: 'unrelated-bootstrap', coverage_revision: 'test' },
        ctx
      );
      await targets.request(
        [
          {
            scope: 'PROFILE',
            target_id: 'unrelated-profile',
            reason: 'unrelated-test'
          }
        ],
        ctx
      );
    });
    const before = await snapshot();
    await runMembershipRepositoryDiagnostics(sqlExecutor);
    expect(await snapshot()).toEqual(before);
  });

  it('fails closed on an existing global producer barrier and rolls back its profile fixtures', async () => {
    const sources = new MembershipSourceStatesDb(() => sqlExecutor);
    await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
      await sources.provision(
        [{ scope: 'GLOBAL', target_id: '*', dimension: 'IDENTITY' }],
        { bootstrap_id: 'existing-producer', coverage_revision: 'test' },
        ctx
      );
    });
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET active_jobs = 1
       WHERE scope = 'GLOBAL' AND target_id = '*' AND dimension = 'IDENTITY'`
    );
    const before = await snapshot();
    await expect(
      runMembershipRepositoryDiagnostics(sqlExecutor)
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});

interface SessionSettings {
  connection_id: string;
  lock_seconds: number;
  execution_millis: number;
}

interface ObservedSession {
  baseline: SessionSettings;
  boundsApplied: number;
  boundsRestored: number;
  repositoryQueries: number;
}

async function readSession(runner: QueryRunner): Promise<SessionSettings> {
  const [session] = await runner.query(`SELECT CONNECTION_ID() connection_id,
    @@SESSION.innodb_lock_wait_timeout lock_seconds,
    @@SESSION.max_execution_time execution_millis`);
  return {
    connection_id: String(session.connection_id),
    ...numericSettings(session)
  };
}

function numericSettings(settings: {
  lock_seconds: unknown;
  execution_millis: unknown;
}) {
  // The test MySQL driver represents integer system variables as strings.
  return {
    lock_seconds: Number(settings.lock_seconds),
    execution_millis: Number(settings.execution_millis)
  };
}

function observeSession(
  sessions: Map<QueryRunner, ObservedSession>,
  runner: QueryRunner,
  sql: string,
  params: Record<string, unknown> | undefined,
  result: unknown[],
  before: SessionSettings,
  after: SessionSettings
) {
  if (sql.startsWith('SELECT @@SESSION.innodb_lock_wait_timeout')) {
    expect(sessions.has(runner)).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      lock_seconds: expect.any(String),
      execution_millis: expect.any(String)
    });
    expect(numericSettings(result[0] as SessionSettings)).toEqual(
      numericSettings(before)
    );
    expect(after).toEqual(before);
    sessions.set(runner, {
      baseline: before,
      boundsApplied: 0,
      boundsRestored: 0,
      repositoryQueries: 0
    });
    return;
  }
  const session = sessions.get(runner)!;
  expect(session).toBeDefined();
  expect(before.connection_id).toBe(session.baseline.connection_id);
  const bounded = {
    connection_id: session.baseline.connection_id,
    lock_seconds: 2,
    execution_millis: 1000
  };
  if (sql.startsWith('SET SESSION innodb_lock_wait_timeout = 2')) {
    expect(before).toEqual(session.baseline);
    expect(after).toEqual(bounded);
    session.boundsApplied++;
  } else if (sql.startsWith('SET SESSION innodb_lock_wait_timeout = :')) {
    expect(params).toEqual({
      lockSeconds: session.baseline.lock_seconds,
      executionMillis: session.baseline.execution_millis
    });
    expect(before).toEqual(bounded);
    expect(after).toEqual(session.baseline);
    session.boundsRestored++;
  } else {
    expect(before).toEqual(bounded);
    expect(after).toEqual(bounded);
    session.repositoryQueries++;
  }
}

async function snapshot() {
  return Promise.all([
    sqlExecutor.execute(
      `SELECT * FROM ${MEMBERSHIP_SOURCE_STATES_TABLE} ORDER BY scope, target_id, dimension`
    ),
    sqlExecutor.execute(
      `SELECT * FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE} ORDER BY scope, target_id, dimension, job_id`
    ),
    sqlExecutor.execute(
      `SELECT * FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} ORDER BY scope, target_id`
    )
  ]);
}
