import 'reflect-metadata';
import {
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
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
