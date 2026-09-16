import {
  IDENTITIES_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
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
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import { MembershipRefreshWorker } from './membership-worker';
import { MembershipRefreshDispatcher } from './membership-dispatch';
import { MembershipDispatchCheckpointsDb } from './membership-dispatch-checkpoints.db';
import { MembershipDispatchHint } from './membership-dispatch.types';
import { MembershipWorkerResult } from './membership-worker.types';
import { MembershipWorkerDb } from './membership-worker.db';
import { membershipDispatchTestOptions } from './membership-dispatch-test.helpers';
import {
  membershipTestOptions,
  membershipTestProvision,
  membershipTestRequest,
  membershipTestTargets,
  membershipTestTx
} from './membership-worker-test.helpers';

const profile = 'm5-real-dispatch';
const target = { scope: 'PROFILE' as const, target_id: profile };
const identity = anIdentity(
  { tdh: 20 },
  {
    profile_id: profile,
    consolidation_key: '0x0000000000000000000000000000000000000005',
    primary_address: '0x0000000000000000000000000000000000000005',
    handle: 'm5-real'
  }
);

async function seedGroups(count: number) {
  const groups = Array.from({ length: count }, (_, i) =>
    aUserGroup(
      { tdh_min: 1 },
      { id: `m5-real-${String(i).padStart(3, '0')}`, name: `M5 real ${i}` }
    )
  );
  const rows = withUserGroups(groups).rows;
  await sqlExecutor.bulkInsert(USER_GROUPS_TABLE, rows, Object.keys(rows[0]));
  await sqlExecutor.bulkInsert(
    MEMBERSHIP_GROUP_VERSIONS_TABLE,
    groups.map((group) => ({
      group_id: group.id,
      catalog_version: '0',
      is_deleted: false,
      updated_at_millis: '1'
    })),
    ['group_id', 'catalog_version', 'is_deleted', 'updated_at_millis']
  );
  const waves = groups.map((group) => {
    const { serial_no: _serial, ...wave } = aWave(
      { visibility_group_id: group.id },
      { id: `wave-${group.id}`, name: group.name }
    );
    return wave;
  });
  await sqlExecutor.bulkInsert(WAVES_TABLE, waves, Object.keys(waves[0]));
}

describeWithSeed(
  'external dispatcher with actual profile worker and evaluator',
  withIdentities([identity]),
  () => {
    it('continues the same durable real run through more than sixteen independent dispatch/worker invocations', async () => {
      await membershipTestTx((ctx) =>
        new MembershipDispatchCheckpointsDb(() => sqlExecutor).provision(ctx)
      );
      await membershipTestProvision(profile);
      await membershipTestRequest(profile);
      await seedGroups(36);
      const runIds: string[] = [];
      let completed = false;
      for (let invocation = 0; invocation < 80 && !completed; invocation++) {
        const queue: MembershipDispatchHint[] = [];
        await new MembershipRefreshDispatcher(sqlExecutor, async (hint) => {
          queue.push(hint);
        }).run(membershipDispatchTestOptions({ max_candidates: 1 }));
        for (const hint of queue) {
          // Real worker/evaluator instances are reconstructed for each independent
          // delivery. The queue carries only the exact scheduling descriptor.
          const result = await new MembershipRefreshWorker(
            sqlExecutor,
            new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
          ).runTarget(hint.target, membershipTestOptions(), {}, hint.delivery);
          expect(['PENDING', 'COMPLETED']).toContain(result.outcome);
          runIds.push(result.run_id!);
          completed = result.outcome === 'COMPLETED';
        }
      }
      expect(completed).toBe(true);
      expect(runIds.length).toBeGreaterThan(16);
      expect(new Set(runIds).size).toBe(1);
      expect(
        await membershipTestTx((ctx) =>
          membershipTestTargets().find(target, ctx)
        )
      ).toMatchObject({
        requested_version: '1',
        completed_version: '1',
        active_run_id: null
      });
      expect(
        await sqlExecutor.execute(
          `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
          { profile }
        )
      ).toEqual([{ run_id: runIds[0] }]);
    });
    it('sends a profile once across both lanes after its real worker checkpoints immediately', async () => {
      await membershipTestTx((ctx) =>
        new MembershipDispatchCheckpointsDb(() => sqlExecutor).provision(ctx)
      );
      await membershipTestProvision(profile);
      await membershipTestRequest(profile);
      await seedGroups(3);
      const pages: MembershipWorkerResult[] = [];
      const dispatcher = new MembershipRefreshDispatcher(
        sqlExecutor,
        async (hint) => {
          pages.push(
            await new MembershipRefreshWorker(
              sqlExecutor,
              new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
            ).runTarget(hint.target, membershipTestOptions(), {}, hint.delivery)
          );
        }
      );
      const first = await dispatcher.run(membershipDispatchTestOptions());
      expect(first).toMatchObject({
        raw_candidates: 2,
        due_candidates: 1,
        target_pk_candidates: 1,
        sent: 1,
        skipped: 1,
        outcomes: { DUPLICATE_TARGET: 1 }
      });
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({
        outcome: 'PENDING',
        checkpoint_version: '1',
        processed_count: '2'
      });
      const next = await dispatcher.run(membershipDispatchTestOptions());
      expect(next.sent).toBe(1);
      expect(pages).toHaveLength(2);
      expect(pages[1]).toMatchObject({
        outcome: 'PENDING',
        run_id: pages[0].run_id,
        checkpoint_version: '2',
        processed_count: '3'
      });
    });
    it('preserves the first real FULL checkpoint until the next dispatcher invocation', async () => {
      const additional = ['m5-real-second', 'm5-real-third'].map(
        (profile_id, index) =>
          anIdentity(
            {},
            {
              profile_id,
              consolidation_key: `0x${String(index + 8).padStart(40, '0')}`,
              primary_address: `0x${String(index + 8).padStart(40, '0')}`,
              handle: profile_id
            }
          )
      );
      await sqlExecutor.bulkInsert(
        IDENTITIES_TABLE,
        additional,
        Object.keys(additional[0])
      );
      await membershipTestProvision(profile);
      const full = { scope: 'FULL' as const, target_id: '*' };
      await membershipTestTx(async (ctx) => {
        await new MembershipDispatchCheckpointsDb(() => sqlExecutor).provision(
          ctx
        );
        await membershipTestTargets().request(
          [{ ...full, reason: 'm5-fanout' }],
          ctx
        );
      });
      const pages: MembershipWorkerResult[] = [];
      const dispatcher = new MembershipRefreshDispatcher(
        sqlExecutor,
        async (hint) => {
          expect(hint.target).toEqual(full);
          pages.push(
            await new MembershipRefreshWorker(
              sqlExecutor,
              new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
            ).runTarget(
              hint.target,
              membershipTestOptions({ page_size: 1 }),
              {},
              hint.delivery
            )
          );
        },
        async (target) => target.scope === 'PROFILE'
      );
      const first = await dispatcher.run(membershipDispatchTestOptions());
      expect(first.sent).toBe(1);
      expect(first.outcomes.DUPLICATE_TARGET).toBe(1);
      expect(pages).toHaveLength(1);
      const read = () =>
        membershipTestTx((ctx) =>
          new MembershipWorkerDb(() => sqlExecutor).run(
            pages[0].run_id!,
            false,
            ctx
          )
        );
      expect(await read()).toMatchObject({
        status: 'PENDING',
        checkpoint_version: '1',
        processed_count: '1',
        progress_cursor: {
          phase: 'SCAN',
          after_id: profile,
          through_id: 'm5-real-third'
        }
      });
      expect((await dispatcher.run(membershipDispatchTestOptions())).sent).toBe(
        1
      );
      expect(pages).toHaveLength(2);
      expect(pages[1].run_id).toBe(pages[0].run_id);
      expect(await read()).toMatchObject({
        status: 'PENDING',
        checkpoint_version: '2',
        processed_count: '2',
        progress_cursor: {
          phase: 'SCAN',
          after_id: 'm5-real-second',
          through_id: 'm5-real-third'
        }
      });
    });
  }
);
