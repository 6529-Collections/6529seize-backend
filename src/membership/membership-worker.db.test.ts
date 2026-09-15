import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { membershipQueryOptions } from './membership-primary';
import {
  membershipTestClaim,
  membershipTestLatch,
  membershipTestRequest,
  membershipTestRuns,
  membershipTestSeed,
  membershipTestTarget,
  membershipTestTargets,
  membershipTestTx
} from './membership-worker-test.helpers';
import { MembershipWorkerClaim } from './membership-worker.types';

async function checkpoint(
  claim: MembershipWorkerClaim,
  done = false,
  groups = ['g1']
) {
  return membershipTestTx(async (ctx) => {
    const run = await membershipTestRuns().run(claim.run_id, false, ctx);
    return membershipTestRuns().checkpoint(
      claim,
      {
        ...run!.progress_cursor,
        after_id: done ? 'g3' : 'g1',
        phase: done ? 'READY_TO_FINISH' : 'SCAN'
      },
      groups,
      Math.max(1, groups.length),
      null,
      ctx
    );
  });
}
async function resume() {
  return membershipTestTx((ctx) =>
    membershipTestRuns().claim(
      membershipTestTarget,
      60000,
      (primary) => membershipTestSeed(membershipTestTarget.target_id, primary),
      ctx
    )
  );
}

describeWithSeed('membership worker transactional fencing', [], () => {
  it('allocates one live run and rejects a duplicate delivery', async () => {
    const claim = await membershipTestClaim();
    expect(await resume()).toBeNull();
    const target = await membershipTestTx((ctx) =>
      membershipTestTargets().find(membershipTestTarget, ctx)
    );
    expect(target?.active_run_id).toBe(claim.run_id);
  });

  it('serializes simultaneous claims without a second active run', async () => {
    await membershipTestRequest();
    const ready = membershipTestLatch();
    const release = membershipTestLatch();
    const first = membershipTestTx(async (ctx) => {
      const claim = await membershipTestRuns().claim(
        membershipTestTarget,
        60000,
        (primary) =>
          membershipTestSeed(membershipTestTarget.target_id, primary),
        ctx
      );
      ready.resolve();
      await release.promise;
      return claim;
    });
    await ready.promise;
    try {
      await expect(resume()).rejects.toMatchObject({
        code: 'ER_LOCK_NOWAIT',
        errno: 3572
      });
    } finally {
      release.resolve();
    }
    expect(await first).not.toBeNull();
    expect(await resume()).toBeNull();
  });

  it('rotates an expired lease and fences the old writer before any member change', async () => {
    const old = await membershipTestClaim();
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET lease_expires_at_millis=0 WHERE id=:id`,
      { id: old.run_id }
    );
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET available_at_millis=0 WHERE target_id=:id`,
      { id: membershipTestTarget.target_id }
    );
    const current = await resume();
    expect(current?.lease_token).not.toBe(old.lease_token);
    await expect(checkpoint(old)).rejects.toMatchObject({ code: 'FENCED' });
    expect(
      await sqlExecutor.execute(
        `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE}`
      )
    ).toEqual([]);
    expect((await checkpoint(current!)).checkpoint_version).toBe('1');
  });

  it('commits members, progress and scheduling together and rejects replay', async () => {
    const claim = await membershipTestClaim();
    const saved = await checkpoint(claim);
    expect(saved.status).toBe('PENDING');
    expect(saved.progress_cursor.after_id).toBe('g1');
    await expect(checkpoint(claim)).rejects.toMatchObject({ code: 'FENCED' });
    expect(
      await sqlExecutor.execute(
        `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE}`
      )
    ).toEqual([{ group_id: 'g1' }]);
  });

  it('rolls candidate writes and cursor back after a failure following checkpoint SQL', async () => {
    const claim = await membershipTestClaim();
    await expect(
      membershipTestTx(async (ctx) => {
        const { run } = await membershipTestRuns().lockClaim(claim, ctx);
        await membershipTestRuns().checkpoint(
          claim,
          { ...run.progress_cursor, after_id: 'g1' },
          ['g1'],
          1,
          null,
          ctx
        );
        throw new Error('lost before commit');
      })
    ).rejects.toThrow('lost before commit');
    expect(
      await sqlExecutor.execute(
        `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE}`
      )
    ).toEqual([]);
    expect(
      (
        await membershipTestTx((ctx) =>
          membershipTestRuns().run(claim.run_id, false, ctx)
        )
      )?.checkpoint_version
    ).toBe('0');
  });

  it('publishes an explicit empty generation while preserving a newer request', async () => {
    const claim = await membershipTestClaim();
    await checkpoint(claim, true, []);
    const finalClaim = await resume();
    await membershipTestRequest();
    const completed = await membershipTestTx((ctx) =>
      membershipTestRuns().complete(finalClaim!, true, ctx)
    );
    expect(completed.status).toBe('COMPLETED');
    expect(
      await sqlExecutor.execute(
        `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
      )
    ).toEqual([{ run_id: claim.run_id }]);
    const target = await membershipTestTx((ctx) =>
      membershipTestTargets().find(membershipTestTarget, ctx)
    );
    expect(target).toMatchObject({
      requested_version: '2',
      completed_version: '1',
      active_run_id: null,
      attempts: 0
    });
    expect(target?.available_at_millis).not.toBeNull();
  });

  it('requires explicit exhaustion before publication', async () => {
    const claim = await membershipTestClaim();
    await expect(
      membershipTestTx((ctx) => membershipTestRuns().complete(claim, true, ctx))
    ).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(
      await sqlExecutor.execute(
        `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
      )
    ).toEqual([]);
  });

  it('preserves a newer request reset when an older run fails permanently', async () => {
    const claim = await membershipTestClaim();
    await membershipTestRequest();
    await membershipTestTx((ctx) =>
      membershipTestRuns().fail(
        membershipTestTarget,
        claim,
        null,
        'INTEGRITY',
        false,
        1000,
        1,
        true,
        ctx
      )
    );
    const target = await membershipTestTx((ctx) =>
      membershipTestTargets().find(membershipTestTarget, ctx)
    );
    expect(target).toMatchObject({
      requested_version: '2',
      completed_version: '0',
      active_run_id: null,
      attempts: 0,
      last_error: null
    });
    expect(target?.available_at_millis).not.toBeNull();
  });

  it('accepts only an exact delivery reservation and rejects stale hints after a retry', async () => {
    await membershipTestRequest();
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET available_at_millis=9223372036854770000 WHERE target_id=:id`,
      { id: membershipTestTarget.target_id }
    );
    expect(await resume()).toBeNull();
    const delivery = {
      requested_version: '1',
      reserved_until_millis: '9223372036854770000'
    };
    const claim = await membershipTestTx((ctx) =>
      membershipTestRuns().claim(
        membershipTestTarget,
        60000,
        (primary) =>
          membershipTestSeed(membershipTestTarget.target_id, primary),
        ctx,
        delivery
      )
    );
    expect(claim).not.toBeNull();
    await membershipTestTx((ctx) =>
      membershipTestRuns().fail(
        membershipTestTarget,
        claim,
        null,
        'TRANSIENT',
        false,
        1000,
        3,
        false,
        ctx
      )
    );
    expect(
      await membershipTestTx((ctx) =>
        membershipTestRuns().claim(
          membershipTestTarget,
          60000,
          (primary) =>
            membershipTestSeed(membershipTestTarget.target_id, primary),
          ctx,
          delivery
        )
      )
    ).toBeNull();
  });

  it('does not clear a committed checkpoint when a delayed failure arrives', async () => {
    const claim = await membershipTestClaim();
    await checkpoint(claim);
    expect(
      await membershipTestTx((ctx) =>
        membershipTestRuns().fail(
          membershipTestTarget,
          claim,
          null,
          'TRANSIENT',
          false,
          100,
          3,
          false,
          ctx
        )
      )
    ).toBe('FENCED');
    await membershipTestTx(async (ctx) => {
      const rows = await sqlExecutor.execute(
        `SELECT status FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE id=:id`,
        { id: claim.run_id },
        membershipQueryOptions(ctx)
      );
      expect(rows).toEqual([{ status: 'PENDING' }]);
    });
  });

  it('fences failure bookkeeping after lease expiry even before another worker reclaims it', async () => {
    const claim = await membershipTestClaim();
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET lease_expires_at_millis=0 WHERE id=:id`,
      { id: claim.run_id }
    );
    expect(
      await membershipTestTx((ctx) =>
        membershipTestRuns().fail(
          membershipTestTarget,
          claim,
          null,
          'TRANSIENT',
          false,
          100,
          3,
          false,
          ctx
        )
      )
    ).toBe('FENCED');
    expect(
      await membershipTestTx((ctx) =>
        membershipTestTargets().find(membershipTestTarget, ctx)
      )
    ).toMatchObject({
      active_run_id: claim.run_id,
      attempts: 0,
      completed_version: '0'
    });
  });
});
