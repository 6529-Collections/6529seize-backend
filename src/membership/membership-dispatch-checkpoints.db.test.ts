import {
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { membershipQueryOptions } from './membership-primary';
import { MembershipDispatchCheckpointsDb } from './membership-dispatch-checkpoints.db';
import { MembershipRefreshDispatcher } from './membership-dispatch';
import {
  MEMBERSHIP_DISPATCH_CHECKPOINT_ID,
  MembershipDispatchHint
} from './membership-dispatch.types';
import {
  initialMembershipDispatchProgress,
  normalizeMembershipDispatchProgress
} from './membership-dispatch-validation';
import { MembershipGcCheckpointsDb } from './membership-gc-checkpoints.db';
import { MEMBERSHIP_GC_CHECKPOINT_ID } from './membership-gc.types';
import {
  membershipTestLatch,
  membershipTestRequest,
  membershipTestTx
} from './membership-worker-test.helpers';
import { membershipDispatchTestOptions } from './membership-dispatch-test.helpers';

const checkpoints = () =>
  new MembershipDispatchCheckpointsDb(() => sqlExecutor);
const reserve = () => membershipTestTx((ctx) => checkpoints().reserve([], ctx));
async function readControl() {
  return sqlExecutor.oneOrNull<{ revision: string; progress: unknown }>(
    `SELECT CAST(revision AS CHAR) revision,progress FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id`,
    { id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID }
  );
}
async function writeProgress(progress: unknown) {
  await sqlExecutor.execute(
    `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} SET progress=:progress WHERE id=:id`,
    {
      id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID,
      progress: JSON.stringify(progress)
    }
  );
}
async function physicalTarget(scope: string, id: string, time: string | null) {
  await sqlExecutor.execute(
    `INSERT INTO ${MEMBERSHIP_REFRESH_TARGETS_TABLE}
    (scope,target_id,requested_version,completed_version,active_run_id,available_at_millis,reason,attempts,last_error,created_at_millis,updated_at_millis)
    VALUES (:scope,:id,1,0,NULL,:time,'m5-raw',0,NULL,1,1)`,
    { scope, id, time }
  );
}

describeWithSeed('durable membership dispatch lanes', [], () => {
  beforeEach(async () =>
    membershipTestTx((ctx) => checkpoints().provision(ctx))
  );

  it('uses source scope collation, binary target collation and numeric signed scheduling order', async () => {
    await physicalTarget('a', 'é', '-9223372036854775808');
    await physicalTarget('B', 'z', '2');
    await physicalTarget('B', 'a', '10');
    const positions = [];
    for (let i = 0; i < 6; i++) positions.push(await reserve());
    expect(positions.filter((p) => p.lane === 'DUE').map((p) => p.key)).toEqual(
      [
        {
          scope: 'a',
          target_id: 'é',
          available_at_millis: '-9223372036854775808'
        },
        { scope: 'B', target_id: 'z', available_at_millis: '2' },
        { scope: 'B', target_id: 'a', available_at_millis: '10' }
      ]
    );
    expect(
      positions.filter((p) => p.lane === 'TARGET_PK').map((p) => p.key)
    ).toEqual([
      { scope: 'a', target_id: 'é' },
      { scope: 'B', target_id: 'a' },
      { scope: 'B', target_id: 'z' }
    ]);
    expect((await readControl())?.revision).toBe('6');
  });

  it('rejects bad control versions, unknown JSON, source-order inversions and revision overflow without reset', async () => {
    const good = initialMembershipDispatchProgress();
    await writeProgress({
      ...good,
      target_pk: {
        sweep: '0',
        after: { scope: 'B', target_id: 'a' },
        through: { scope: 'a', target_id: 'z' }
      }
    });
    await expect(reserve()).rejects.toMatchObject({
      code: 'DISPATCH_INTEGRITY'
    });
    expect((await readControl())?.revision).toBe('0');
    await writeProgress({ ...good, arbitrary: [] });
    await expect(
      membershipTestTx((ctx) => checkpoints().provision(ctx))
    ).rejects.toMatchObject({ code: 'DISPATCH_INTEGRITY' });
    await writeProgress(good);
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} SET protocol_version=2 WHERE id=:id`,
      { id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID }
    );
    await expect(reserve()).rejects.toMatchObject({
      code: 'DISPATCH_INTEGRITY'
    });
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} SET protocol_version=1,revision=9223372036854775807 WHERE id=:id`,
      { id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID }
    );
    await expect(reserve()).rejects.toThrow();
    expect((await readControl())?.revision).toBe('9223372036854775807');
    expect(
      normalizeMembershipDispatchProgress((await readControl())!.progress)
    ).toEqual(good);
  });

  it('does not skip adjacent signed BIGINT scheduling keys beyond safe JavaScript integers', async () => {
    const values = [
      '-9007199254740993',
      '-9007199254740992',
      '-9007199254740991'
    ];
    for (let index = 0; index < values.length; index++)
      await physicalTarget('PROFILE', `m5-wide-${index}`, values[index]);
    const positions = [];
    for (let index = 0; index < 6; index++) positions.push(await reserve());
    expect(
      positions
        .filter((position) => position.lane === 'DUE')
        .map((position) => position.key)
    ).toEqual(
      values.map((available_at_millis, index) => ({
        scope: 'PROFILE',
        target_id: `m5-wide-${index}`,
        available_at_millis
      }))
    );
  });

  it('closes empty lanes once per invocation without repeatedly reopening or changing other control rows', async () => {
    await membershipTestTx((ctx) =>
      new MembershipGcCheckpointsDb(() => sqlExecutor).provision(ctx)
    );
    const result = await new MembershipRefreshDispatcher(
      sqlExecutor,
      jest.fn()
    ).run(membershipDispatchTestOptions());
    expect(result).toMatchObject({
      raw_candidates: 0,
      sent: 0,
      outcomes: { EMPTY: 2 }
    });
    expect(
      normalizeMembershipDispatchProgress((await readControl())!.progress)
    ).toMatchObject({ due: { sweep: '1' }, target_pk: { sweep: '1' } });
    expect(
      await sqlExecutor.oneOrNull(
        `SELECT CAST(revision AS CHAR) revision FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id`,
        { id: MEMBERSHIP_GC_CHECKPOINT_ID }
      )
    ).toEqual({ revision: '0' });
  });

  it('visits past multiple locked invocation budgets across reconstructed dispatcher instances', async () => {
    const ids = Array.from(
      { length: 13 },
      (_, i) => `m5-locked-${String(i).padStart(3, '0')}`
    );
    for (const id of ids) await membershipTestRequest(id);
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET available_at_millis=1`
    );
    const ready = membershipTestLatch();
    const release = membershipTestLatch();
    const blocker = membershipTestTx(async (ctx) => {
      for (const id of ids.slice(0, -1))
        await sqlExecutor.execute(
          `SELECT target_id FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} FORCE INDEX(PRIMARY) WHERE scope='PROFILE' AND target_id=:id FOR UPDATE`,
          { id },
          membershipQueryOptions(ctx)
        );
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const sent: MembershipDispatchHint[] = [];
    const revisions: bigint[] = [];
    try {
      for (let i = 0; i < 8 && !sent.length; i++) {
        const result = await new MembershipRefreshDispatcher(
          sqlExecutor,
          async (hint) => {
            sent.push(hint);
          }
        ).run(
          membershipDispatchTestOptions({ max_candidates: 4, max_per_lane: 2 })
        );
        expect(result.raw_candidates).toBeLessThanOrEqual(4);
        revisions.push(BigInt((await readControl())!.revision));
      }
      expect(sent.map((hint) => hint.target.target_id)).toEqual([ids[12]]);
      expect(revisions.length).toBeGreaterThan(3);
      expect(
        revisions.every((revision, i) => i === 0 || revision > revisions[i - 1])
      ).toBe(true);
    } finally {
      release.resolve();
      await blocker;
    }
  });

  it('reaches a repeatedly invalidated target beyond the captured due cutoff through the fixed PK lane', async () => {
    await physicalTarget('PROFILE', 'm5-a', '1');
    await physicalTarget('PROFILE', 'm5-z', '1');
    expect((await reserve()).lane).toBe('DUE');
    expect((await reserve()).key?.target_id).toBe('m5-a');
    const cursor = normalizeMembershipDispatchProgress(
      (await readControl())!.progress
    );
    // Fixed historical cutoff represents an earlier cold invocation. Every new
    // legitimate request moves availability beyond it, but leaves PK unchanged.
    cursor.due.cutoff_millis = '1';
    await writeProgress(cursor);
    await membershipTestRequest('m5-z');
    const sent: MembershipDispatchHint[] = [];
    const result = await new MembershipRefreshDispatcher(
      sqlExecutor,
      async (hint) => {
        sent.push(hint);
      }
    ).run(membershipDispatchTestOptions({ max_candidates: 2 }));
    expect(result).toMatchObject({
      sent: 1,
      due_candidates: 0,
      target_pk_candidates: 1
    });
    expect(sent[0].target.target_id).toBe('m5-z');
    expect(sent[0].delivery.requested_version).toBe('2');
  });

  it('does not share GC locks or retain the dispatch control lock during target/guard work', async () => {
    await membershipTestTx((ctx) =>
      new MembershipGcCheckpointsDb(() => sqlExecutor).provision(ctx)
    );
    await membershipTestRequest('m5-independent');
    const ready = membershipTestLatch();
    const release = membershipTestLatch();
    const blocker = membershipTestTx(async (ctx) => {
      await sqlExecutor.execute(
        `SELECT id FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id FOR UPDATE`,
        { id: MEMBERSHIP_GC_CHECKPOINT_ID },
        membershipQueryOptions(ctx)
      );
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    try {
      const guard = jest.fn(async () => {
        await membershipTestTx(async (ctx) => {
          await sqlExecutor.execute(
            `SELECT id FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id FOR UPDATE NOWAIT`,
            { id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID },
            membershipQueryOptions(ctx)
          );
        });
        return true;
      });
      const result = await new MembershipRefreshDispatcher(
        sqlExecutor,
        jest.fn(),
        guard
      ).run(membershipDispatchTestOptions({ max_candidates: 1 }));
      expect(result.outcomes.FIXTURE_HELD).toBe(1);
    } finally {
      release.resolve();
      await blocker;
    }
    const locked = membershipTestLatch();
    const unlock = membershipTestLatch();
    const dispatchBlocker = membershipTestTx(async (ctx) => {
      await sqlExecutor.execute(
        `SELECT id FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id FOR UPDATE`,
        { id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID },
        membershipQueryOptions(ctx)
      );
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    try {
      expect(
        (
          await new MembershipRefreshDispatcher(sqlExecutor, jest.fn()).run(
            membershipDispatchTestOptions()
          )
        ).control_busy
      ).toBe(true);
      await membershipTestTx((ctx) =>
        new MembershipGcCheckpointsDb(() => sqlExecutor).reserve(
          {
            reader_grace_millis: 1,
            scan_age_millis: 0,
            member_batch: 1,
            pending_claim_millis: 1000,
            max_attempts: 1
          },
          ctx
        )
      );
    } finally {
      unlock.resolve();
      await dispatchBlocker;
    }
  });
});
