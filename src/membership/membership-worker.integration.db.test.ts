import {
  IDENTITIES_TABLE,
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE,
  RATINGS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { FilterDirection } from '@/entities/IUserGroup';
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import {
  MembershipEvaluationError,
  MembershipProfileEvaluator
} from './membership-evaluator.types';
import { MembershipRefreshWorker } from './membership-worker';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { membershipQueryOptions } from './membership-primary';
import { MEMBERSHIP_FANOUT_KEYS } from './membership-worker-validation';
import {
  membershipTestOptions,
  membershipTestProvision,
  membershipTestRequest,
  membershipTestRuns,
  membershipTestTargets,
  membershipTestTx
} from './membership-worker-test.helpers';
import { MembershipWorkerResult } from './membership-worker.types';

const profile = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
const identity = anIdentity(
  { tdh: 20 },
  {
    profile_id: profile,
    consolidation_key: '0x0000000000000000000000000000000000000004',
    primary_address: '0x0000000000000000000000000000000000000004',
    handle: 'm4-real'
  }
);
const target = { scope: 'PROFILE' as const, target_id: profile };
const worker = () =>
  new MembershipRefreshWorker(
    sqlExecutor,
    new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
  );

async function fixtureGroups(count: number, minimum = 1) {
  const rows = Array.from({ length: count }, (_, index) =>
    aUserGroup(
      { tdh_min: minimum },
      {
        id: `m4-g-${String(index).padStart(3, '0')}`,
        name: `M4 group ${index}`
      }
    )
  );
  if (!rows.length) return;
  const persisted = withUserGroups(rows).rows;
  await sqlExecutor.bulkInsert(
    USER_GROUPS_TABLE,
    persisted,
    Object.keys(persisted[0])
  );
  await sqlExecutor.bulkInsert(
    MEMBERSHIP_GROUP_VERSIONS_TABLE,
    rows.map((group) => ({
      group_id: group.id,
      catalog_version: '0',
      is_deleted: false,
      updated_at_millis: '1'
    })),
    ['group_id', 'catalog_version', 'is_deleted', 'updated_at_millis']
  );
  const waves = rows.map((group) => {
    const { serial_no: _serial, ...wave } = aWave(
      { visibility_group_id: group.id },
      { id: `m4-wave-${group.id}`, name: group.name }
    );
    return wave;
  });
  await sqlExecutor.bulkInsert(WAVES_TABLE, waves, Object.keys(waves[0]));
}
async function finish(limit = 100): Promise<MembershipWorkerResult[]> {
  const results = [];
  for (let i = 0; i < limit; i++) {
    // Reconstruct service instances: all continuation authority lives in MySQL.
    const result = await worker().runTarget(target, membershipTestOptions());
    results.push(result);
    if (result.outcome !== 'PENDING') return results;
  }
  throw new Error(
    'Real worker did not finish within the fixture invocation bound'
  );
}

describeWithSeed(
  'membership worker with the real primary evaluator',
  withIdentities([identity]),
  () => {
    beforeEach(async () => {
      await membershipTestProvision(profile);
      await membershipTestRequest(profile);
    });

    it('publishes only after more than sixteen durable invocations and an explicit final guard', async () => {
      await fixtureGroups(36);
      const results = await finish();
      expect(results.length).toBeGreaterThan(16);
      expect(results[results.length - 1].outcome).toBe('COMPLETED');
      const id = results[results.length - 1].run_id;
      expect(new Set(results.map((result) => result.run_id))).toEqual(
        new Set([id])
      );
      const members = await sqlExecutor.execute<{ group_id: string }>(
        `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} WHERE run_id=:id ORDER BY group_id`,
        { id }
      );
      expect(members).toHaveLength(36);
      expect(
        await sqlExecutor.execute(
          `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
          { profile }
        )
      ).toEqual([{ run_id: id }]);
      const run = await membershipTestTx((ctx) =>
        membershipTestRuns().run(id!, false, ctx)
      );
      expect(run).toMatchObject({
        catalog_version: '0',
        processed_count: '36',
        status: 'COMPLETED',
        progress_cursor: { phase: 'DONE', active_input: null }
      });
    });

    it('publishes a real zero-member generation after complete negative evaluation', async () => {
      await fixtureGroups(3, 100);
      const results = await finish();
      expect(results[results.length - 1].outcome).toBe('COMPLETED');
      expect(
        await sqlExecutor.execute(
          `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE}`
        )
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
        )
      ).toHaveLength(1);
    });

    it('supersedes on non-catalogue change and preserves the newer source-atomic request', async () => {
      await fixtureGroups(4);
      const first = await worker().runTarget(target, membershipTestOptions());
      expect(first.outcome).toBe('PENDING');
      await membershipTestTx((ctx) =>
        new MembershipSourceStatesDb(() => sqlExecutor).mutate(
          {
            keys: [
              { scope: 'PROFILE', target_id: profile, dimension: 'RATINGS' }
            ],
            requests: [{ ...target, reason: 'm4-rating' }]
          },
          (primary) =>
            sqlExecutor.execute(
              `UPDATE ${IDENTITIES_TABLE} SET rep=rep+1 WHERE profile_id=:profile`,
              { profile },
              membershipQueryOptions(primary)
            ),
          ctx
        )
      );
      const result = await worker().runTarget(target, membershipTestOptions());
      expect(result.outcome).toBe('SUPERSEDED');
      expect(
        await sqlExecutor.execute(
          `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
        )
      ).toEqual([]);
      expect(
        await membershipTestTx((ctx) =>
          membershipTestTargets().find(target, ctx)
        )
      ).toMatchObject({
        requested_version: '2',
        completed_version: '0',
        active_run_id: null
      });
    });

    it('allows catalogue advances while retaining captured C and high bound', async () => {
      await fixtureGroups(4);
      const first = await worker().runTarget(target, membershipTestOptions());
      const before = await membershipTestTx((ctx) =>
        membershipTestRuns().run(first.run_id!, false, ctx)
      );
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version=version+1 WHERE scope='GLOBAL' AND dimension='GROUP_CATALOG'`
      );
      const results = await finish();
      expect(results[results.length - 1].outcome).toBe('COMPLETED');
      const after = await membershipTestTx((ctx) =>
        membershipTestRuns().run(first.run_id!, false, ctx)
      );
      expect(after?.catalog_version).toBe(before?.catalog_version);
      expect(after?.progress_cursor.through_id).toBe(
        before?.progress_cursor.through_id
      );
      expect(after?.evaluation_time_millis).toBe(
        before?.evaluation_time_millis
      );
    });

    it('defers an identity that is missing instead of publishing empty authority', async () => {
      await sqlExecutor.execute(
        `DELETE FROM ${IDENTITIES_TABLE} WHERE profile_id=:profile`,
        { profile }
      );
      const result = await worker().runTarget(target, membershipTestOptions());
      expect(result.outcome).toBe('PENDING');
      expect(
        await sqlExecutor.execute(
          `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
        )
      ).toEqual([]);
    });

    it('fanout captures two audit keys and acknowledges requests without claiming child readiness', async () => {
      await membershipTestTx((ctx) =>
        new MembershipSourceStatesDb(() => sqlExecutor).provision(
          MEMBERSHIP_FANOUT_KEYS,
          { bootstrap_id: 'm4-fanout', coverage_revision: 'test-only' },
          ctx
        )
      );
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET active_jobs=1 WHERE scope='GLOBAL' AND dimension='GROUP_CATALOG'`
      );
      const parent = { scope: 'FULL' as const, target_id: '*' };
      await membershipTestTx((ctx) =>
        membershipTestTargets().request(
          [{ ...parent, reason: 'm4-fanout' }],
          ctx
        )
      );
      const first = await worker().runTarget(
        parent,
        membershipTestOptions({ page_size: 1 })
      );
      expect(first.outcome).toBe('PENDING');
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version=version+1 WHERE scope='GLOBAL' AND dimension='IDENTITY'`
      );
      const completed = await worker().runTarget(
        parent,
        membershipTestOptions()
      );
      expect(completed.outcome).toBe('COMPLETED');
      const run = await membershipTestTx((ctx) =>
        membershipTestRuns().run(completed.run_id!, false, ctx)
      );
      expect(run?.source_versions).toHaveLength(2);
      expect(run?.source_versions.map((entry) => entry.version)).toEqual([
        '0',
        '0'
      ]);
      expect(
        await membershipTestTx((ctx) =>
          membershipTestTargets().find(target, ctx)
        )
      ).toMatchObject({ requested_version: '2', completed_version: '0' });
      expect(
        await sqlExecutor.execute(
          `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
        )
      ).toEqual([]);
    });

    it('persists bounded active input across invocations without publishing a partial signed sum', async () => {
      await fixtureGroups(1);
      await sqlExecutor.execute(
        `UPDATE ${USER_GROUPS_TABLE} SET tdh_min=NULL,rep_category='dense',rep_direction=:direction,rep_min=100 WHERE id='m4-g-000'`,
        { direction: FilterDirection.Sent }
      );
      const ratings = Array.from({ length: 20 }, (_, n) => ({
        rater_profile_id: profile,
        matter_target_id: `m4-peer-${String(n).padStart(3, '0')}`,
        matter: 'REP',
        matter_category: 'dense',
        rating: n === 19 ? -1899 : 100,
        last_modified: new Date()
      }));
      await sqlExecutor.bulkInsert(
        RATINGS_TABLE,
        ratings,
        Object.keys(ratings[0])
      );
      let count = 0;
      let pendingInputs = 0;
      let final: MembershipWorkerResult | null = null;
      for (; count < 60; count++) {
        const options = membershipTestOptions();
        final = await worker().runTarget(target, {
          ...options,
          input_limits: {
            ...options.input_limits,
            max_windows: 1,
            raw_window: 1
          }
        });
        const run = await membershipTestTx((ctx) =>
          membershipTestRuns().run(final!.run_id!, false, ctx)
        );
        if (
          run?.progress_cursor.kind === 'PROFILE' &&
          run.progress_cursor.active_input !== null
        ) {
          pendingInputs++;
          expect(run.progress_cursor.after_id).toBeNull();
          expect(
            await sqlExecutor.execute(
              `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE}`
            )
          ).toEqual([]);
          expect(
            await sqlExecutor.execute(
              `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
            )
          ).toEqual([]);
        }
        if (final.outcome !== 'PENDING') break;
      }
      expect(final?.outcome).toBe('COMPLETED');
      expect(pendingInputs).toBeGreaterThan(16);
      expect(count).toBeLessThan(60);
      expect(
        await sqlExecutor.execute(
          `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE}`
        )
      ).toEqual([]);
    });

    it('parks an unsupported active cursor instead of repeatedly claiming or publishing it', async () => {
      await fixtureGroups(4);
      const first = await worker().runTarget(target, membershipTestOptions());
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET progress_cursor=JSON_SET(progress_cursor,'$.protocol_version',99) WHERE id=:id`,
        { id: first.run_id }
      );
      expect(
        (await worker().runTarget(target, membershipTestOptions())).outcome
      ).toBe('FAILED');
      expect(
        await membershipTestTx((ctx) =>
          membershipTestTargets().find(target, ctx)
        )
      ).toMatchObject({
        available_at_millis: null,
        last_error: 'INTEGRITY',
        completed_version: '0'
      });
      expect(
        (await worker().runTarget(target, membershipTestOptions())).outcome
      ).toBe('NO_WORK');
      expect(
        await sqlExecutor.execute(
          `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
        )
      ).toEqual([]);
    });

    it('retires a failed older request and gives the newer run its own bounded retries', async () => {
      await fixtureGroups(4);
      const first = await worker().runTarget(target, membershipTestOptions());
      expect(first.outcome).toBe('PENDING');
      await membershipTestRequest(profile);
      const real = new PrimaryMembershipProfileEvaluator(() => sqlExecutor);
      const failing: MembershipProfileEvaluator = {
        captureProfile: real.captureProfile.bind(real),
        evaluateQuantum: async () => {
          throw new MembershipEvaluationError(
            'RESOURCE_LIMIT',
            'Injected transient quantum failure'
          );
        }
      };
      const transientWorker = new MembershipRefreshWorker(sqlExecutor, failing);
      const oldFailure = await transientWorker.runTarget(
        target,
        membershipTestOptions({ retry_millis: 1000 })
      );
      expect(oldFailure).toMatchObject({
        outcome: 'SUPERSEDED',
        run_id: first.run_id
      });
      const due = await membershipTestTx((ctx) =>
        membershipTestTargets().find(target, ctx)
      );
      expect(due).toMatchObject({
        requested_version: '2',
        completed_version: '0',
        active_run_id: null,
        attempts: 0,
        last_error: null
      });
      const nextFailure = await transientWorker.runTarget(
        target,
        membershipTestOptions({ retry_millis: 1000 })
      );
      expect(nextFailure.outcome).toBe('PENDING');
      expect(nextFailure.run_id).not.toBe(first.run_id);
      const retry = await membershipTestTx((ctx) =>
        membershipTestTargets().find(target, ctx)
      );
      expect(retry).toMatchObject({
        requested_version: '2',
        completed_version: '0',
        active_run_id: nextFailure.run_id,
        attempts: 1,
        last_error: 'RESOURCE_LIMIT'
      });
      expect(
        (await transientWorker.runTarget(target, membershipTestOptions()))
          .outcome
      ).toBe('NO_WORK');
      expect(
        (
          await transientWorker.runTarget(
            target,
            membershipTestOptions(),
            {},
            {
              requested_version: '2',
              reserved_until_millis: due!.available_at_millis!
            }
          )
        ).outcome
      ).toBe('NO_WORK');
      // Advance only scheduling in the fixture, as if the persisted retry delay elapsed.
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET available_at_millis=0 WHERE scope='PROFILE' AND target_id=:profile`,
        { profile }
      );
      const completed = await finish();
      expect(completed[completed.length - 1]).toMatchObject({
        outcome: 'COMPLETED',
        run_id: nextFailure.run_id
      });
      expect(
        await membershipTestTx((ctx) =>
          membershipTestTargets().find(target, ctx)
        )
      ).toMatchObject({
        requested_version: '2',
        completed_version: '2',
        active_run_id: null,
        attempts: 0
      });
    });
  }
);
