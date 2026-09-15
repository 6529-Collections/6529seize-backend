import { performance } from 'node:perf_hooks';
import { sqlExecutor } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  withMembershipPrimaryTransaction
} from './membership-primary';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { MembershipWorkerDb, MembershipRunSeed } from './membership-worker.db';
import { MembershipWorkerOptions } from './membership-worker.types';
import { membershipProfileSourceKeys } from './membership-worker-validation';

export const membershipTestTx = <T>(
  fn: (ctx: MembershipPrimaryContext) => Promise<T>
) => withMembershipPrimaryTransaction(sqlExecutor, fn);
export const membershipTestRuns = () =>
  new MembershipWorkerDb(() => sqlExecutor);
export const membershipTestTargets = () =>
  new MembershipRefreshTargetsDb(() => sqlExecutor);
export const membershipTestTarget = {
  scope: 'PROFILE' as const,
  target_id: 'm4-profile'
};

export async function membershipTestSeed(
  profile: string,
  ctx: MembershipPrimaryContext
): Promise<MembershipRunSeed> {
  return {
    spec_version: 2,
    catalog_version: '0',
    source_versions: membershipProfileSourceKeys(profile).map((key) => ({
      ...key,
      version: '0'
    })),
    evaluation_time_millis: await membershipTestRuns().now(ctx),
    progress_cursor: {
      protocol_version: 2,
      kind: 'PROFILE',
      phase: 'SCAN',
      after_id: null,
      through_id: 'g3',
      traversal_collation: 'utf8mb4_unicode_ci',
      identity_consolidation_key: 'm4-key',
      active_input: null
    }
  };
}
export async function membershipTestRequest(
  profile = membershipTestTarget.target_id
) {
  const target = { scope: 'PROFILE' as const, target_id: profile };
  await membershipTestTx((ctx) =>
    membershipTestTargets().request([{ ...target, reason: 'm4-test' }], ctx)
  );
  return target;
}
export async function membershipTestClaim(
  profile = membershipTestTarget.target_id
) {
  const target = await membershipTestRequest(profile);
  const claim = await membershipTestTx((ctx) =>
    membershipTestRuns().claim(
      target,
      60000,
      (primary) => membershipTestSeed(profile, primary),
      ctx
    )
  );
  if (!claim) throw new Error('Fixture claim did not allocate a run');
  return claim;
}
export async function membershipTestProvision(profile: string) {
  await membershipTestTx((ctx) =>
    new MembershipSourceStatesDb(() => sqlExecutor).provision(
      membershipProfileSourceKeys(profile),
      { bootstrap_id: 'm4-fixture', coverage_revision: 'test-only' },
      ctx
    )
  );
}
export function membershipTestOptions(
  overrides: Partial<MembershipWorkerOptions> = {}
): MembershipWorkerOptions {
  return {
    deadline_monotonic_millis: performance.now() + 30000,
    transaction_millis: 5000,
    max_statement_millis: 1000,
    finalization_reserve_millis: 500,
    checkpoint_reserve_millis: 500,
    lock_wait_seconds: 1,
    lease_millis: 10000,
    max_quanta: 1,
    page_size: 2,
    input_limits: {
      max_queries: 300,
      max_input_rows: 100000,
      max_input_bytes: 8000000,
      max_windows: 100,
      raw_window: 128
    },
    retry_millis: 100,
    max_attempts: 3,
    ...overrides
  };
}

export function membershipTestLatch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
