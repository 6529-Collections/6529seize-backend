import { randomUUID } from 'node:crypto';
import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { membershipQueryOptions } from './membership-primary';
import { MembershipGcDb } from './membership-gc.db';
import { MembershipGcCheckpointsDb } from './membership-gc-checkpoints.db';
import {
  MembershipGcHint,
  MembershipGcOptions,
  MEMBERSHIP_GC_CHECKPOINT_ID,
  normalizeMembershipGcProgress
} from './membership-gc.types';
import {
  membershipTestClaim,
  membershipTestLatch,
  membershipTestRuns,
  membershipTestTx
} from './membership-worker-test.helpers';

const options: MembershipGcOptions = {
  reader_grace_millis: 1000,
  scan_age_millis: 0,
  member_batch: 2,
  pending_claim_millis: 10000,
  max_attempts: 10
};
const gc = () => new MembershipGcDb(() => sqlExecutor);
const controls = () => new MembershipGcCheckpointsDb(() => sqlExecutor);

async function failedRun(profile: string): Promise<MembershipGcHint> {
  const claim = await membershipTestClaim(profile);
  await membershipTestTx((ctx) =>
    membershipTestRuns().fail(
      claim.target,
      claim,
      null,
      'fixture',
      false,
      100,
      3,
      true,
      ctx
    )
  );
  return {
    run_id: claim.run_id,
    target: claim.target,
    pending: { slot: 0, claim_token: randomUUID() }
  };
}
async function addMembers(hint: MembershipGcHint, ids: string[]) {
  const params: Record<string, string> = {
    run: hint.run_id,
    profile: hint.target.target_id
  };
  const values = ids.map((id, index) => {
    params[`id${index}`] = id;
    return `(:run,:id${index},:profile)`;
  });
  await sqlExecutor.execute(
    `INSERT INTO ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} (run_id,group_id,profile_id) VALUES ${values.join(',')}`,
    params
  );
}
async function ageRetirement(hint: MembershipGcHint) {
  await sqlExecutor.execute(
    `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET progress_cursor=JSON_SET(progress_cursor,'$.gc.retired_at_millis','1') WHERE id=:id`,
    { id: hint.run_id }
  );
}
const collect = (hint: MembershipGcHint) =>
  membershipTestTx((ctx) => gc().collect(hint, options, ctx));
const reserve = () =>
  membershipTestTx((ctx) => controls().reserve(options, ctx));

describeWithSeed('membership generation garbage collection', [], () => {
  it('starts grace at first proven retirement and preserves completed metadata', async () => {
    const hint = await failedRun('m4-gc-grace');
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET completed_at_millis=1 WHERE id=:id`,
      { id: hint.run_id }
    );
    const first = await collect(hint);
    expect(first.outcome).toBe('RETIRED');
    expect((await collect(hint)).outcome).toBe('TOO_YOUNG');
    const run = await membershipTestTx((ctx) =>
      membershipTestRuns().run(hint.run_id, false, ctx)
    );
    expect(run?.completed_at_millis).toBe('1');
    expect(BigInt(run!.progress_cursor.gc!.retired_at_millis)).toBeGreaterThan(
      BigInt(1)
    );
    expect(run?.status).toBe('FAILED');
  });

  it('protects even an unexpected current publication and an active run', async () => {
    const hint = await failedRun('m4-gc-published');
    await sqlExecutor.execute(
      `INSERT INTO ${MEMBERSHIP_PUBLICATIONS_TABLE} (profile_id,run_id,published_at_millis) VALUES (:profile,:run,1)`,
      { profile: hint.target.target_id, run: hint.run_id }
    );
    expect((await collect(hint)).outcome).toBe('PROTECTED');
    const active = await membershipTestClaim('m4-gc-active');
    expect(
      (
        await collect({
          run_id: active.run_id,
          target: active.target,
          pending: null
        })
      ).outcome
    ).toBe('PROTECTED');
  });

  it('deletes bounded member batches and resumes without another reader grace', async () => {
    const hint = await failedRun('m4-gc-partial');
    await addMembers(hint, ['a', 'b', 'c', 'd', 'e']);
    await collect(hint);
    await ageRetirement(hint);
    const first = await collect(hint);
    expect(first).toMatchObject({
      outcome: 'PARTIAL',
      read_count: 2,
      deleted_count: 2
    });
    const second = await collect(hint);
    expect(second).toMatchObject({ outcome: 'PARTIAL', deleted_count: 2 });
    expect((await collect(hint)).outcome).toBe('DELETED');
    expect(
      await sqlExecutor.execute(
        `SELECT id FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE id=:id`,
        { id: hint.run_id }
      )
    ).toEqual([]);
  });

  it('moves beyond locked member prefixes and never mistakes SKIP LOCKED empty for no members', async () => {
    const hint = await failedRun('m4-gc-members');
    await addMembers(hint, ['a', 'b', 'c', 'd']);
    await collect(hint);
    await ageRetirement(hint);
    const ready = membershipTestLatch();
    const release = membershipTestLatch();
    const blocker = membershipTestTx(async (ctx) => {
      await sqlExecutor.execute(
        `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} WHERE run_id=:run AND group_id IN ('a','b') FOR UPDATE`,
        { run: hint.run_id },
        membershipQueryOptions(ctx)
      );
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    try {
      expect(await collect(hint)).toMatchObject({
        outcome: 'PARTIAL',
        deleted_count: 0,
        read_count: 2
      });
      expect(await collect(hint)).toMatchObject({
        outcome: 'PARTIAL',
        deleted_count: 2,
        read_count: 2
      });
      expect(
        await sqlExecutor.execute(
          `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} WHERE run_id=:run ORDER BY group_id`,
          { run: hint.run_id }
        )
      ).toEqual([{ group_id: 'a' }, { group_id: 'b' }]);
    } finally {
      release.resolve();
      await blocker;
    }
    expect((await collect(hint)).outcome).toBe('DELETED');
  });

  it('advances durable discovery before lock contention and reaches later runs across reconstructed repositories', async () => {
    await membershipTestTx((ctx) => controls().provision(ctx));
    const hints: MembershipGcHint[] = [];
    for (let i = 0; i < 4; i++) {
      hints.push(await failedRun(`m4-gc-locked-${i}`));
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET updated_at_millis=:time WHERE id=:id`,
        { time: i + 1, id: hints[i].run_id }
      );
    }
    const ready = membershipTestLatch();
    const release = membershipTestLatch();
    const blocker = membershipTestTx(async (ctx) => {
      for (const hint of hints.slice(0, 3))
        await sqlExecutor.execute(
          `SELECT id FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} FORCE INDEX(PRIMARY) WHERE id=:id FOR UPDATE`,
          { id: hint.run_id },
          membershipQueryOptions(ctx)
        );
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    let reached = false;
    try {
      for (let i = 0; i < 32 && !reached; i++) {
        const hint = await reserve();
        if (!hint) continue;
        if (hint.run_id === hints[3].run_id) {
          expect((await collect(hint)).outcome).toBe('RETIRED');
          reached = true;
        } else {
          await expect(collect(hint)).rejects.toMatchObject({
            errno: 3572
          });
          await membershipTestTx((ctx) =>
            controls().record(
              hint,
              {
                run_id: hint.run_id,
                outcome: 'LOCK_BUSY',
                deleted_count: 0,
                read_count: 0,
                retry_at_millis: null
              },
              ctx
            )
          );
        }
      }
    } finally {
      release.resolve();
      await blocker;
    }
    expect(reached).toBe(true);
  });

  it('fences delayed pending results and fairly evicts expired scheduling claims', async () => {
    await membershipTestTx((ctx) => controls().provision(ctx));
    const hint = await failedRun('m4-gc-pending');
    let reserved: MembershipGcHint | null = null;
    for (let i = 0; i < 6 && !reserved; i++) reserved = await reserve();
    expect(reserved?.run_id).toBe(hint.run_id);
    await membershipTestTx((ctx) =>
      controls().record(
        reserved!,
        {
          run_id: hint.run_id,
          outcome: 'PARTIAL',
          deleted_count: 1,
          read_count: 1,
          retry_at_millis: '0'
        },
        ctx
      )
    );
    const claimed = await reserve();
    expect(claimed?.run_id).toBe(hint.run_id);
    await membershipTestTx((ctx) =>
      controls().record(
        reserved!,
        {
          run_id: hint.run_id,
          outcome: 'DELETED',
          deleted_count: 1,
          read_count: 1,
          retry_at_millis: null
        },
        ctx
      )
    );
    const row = await sqlExecutor.oneOrNull<{ progress: unknown }>(
      `SELECT progress FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id`,
      { id: MEMBERSHIP_GC_CHECKPOINT_ID }
    );
    expect(
      normalizeMembershipGcProgress(row!.progress).pending[0].claim_token
    ).toBe(claimed?.pending?.claim_token);
  });
});
