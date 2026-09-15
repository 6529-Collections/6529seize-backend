import { randomUUID } from 'node:crypto';
import {
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE
} from '@/constants';
import { SqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { MembershipDispatchDb } from './membership-dispatch.db';
import { MembershipDispatchCheckpointsDb } from './membership-dispatch-checkpoints.db';
import { MembershipRefreshDispatcher } from './membership-dispatch';
import { MembershipDispatchHint } from './membership-dispatch.types';
import { membershipDispatchTestOptions } from './membership-dispatch-test.helpers';
import {
  membershipTestClaim,
  membershipTestRequest,
  membershipTestRuns,
  membershipTestTargets,
  membershipTestTx
} from './membership-worker-test.helpers';

const candidates = () => new MembershipDispatchDb(() => sqlExecutor);
const target = { scope: 'PROFILE' as const, target_id: 'm5-candidate' };
const reserve = () =>
  membershipTestTx((ctx) => candidates().reserve(target, 1000, undefined, ctx));
const read = () =>
  membershipTestTx((ctx) => membershipTestTargets().find(target, ctx));
async function patchTarget(fields: string) {
  await sqlExecutor.execute(
    `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET ${fields} WHERE scope=:scope AND target_id=:target_id`,
    target
  );
}
function failAfterCommit(phase: number): SqlExecutor {
  let transactions = 0;
  return new Proxy(sqlExecutor, {
    get(source, property) {
      if (property === 'executeNativeQueriesInTransaction')
        return async (
          ...args: Parameters<SqlExecutor['executeNativeQueriesInTransaction']>
        ) => {
          const result = await source.executeNativeQueriesInTransaction(
            ...args
          );
          if (++transactions === phase)
            throw Object.assign(new Error('Lost commit response'), {
              commitOutcome: 'UNKNOWN'
            });
          return result;
        };
      const value = Reflect.get(source, property);
      return typeof value === 'function' ? value.bind(source) : value;
    }
  });
}

describeWithSeed('membership dispatch target reservation', [], () => {
  beforeEach(async () => {
    await membershipTestTx((ctx) =>
      new MembershipDispatchCheckpointsDb(() => sqlExecutor).provision(ctx)
    );
    await membershipTestRequest(target.target_id);
  });

  it('suppresses missing, malformed, parked, settled and future work without retry/counter repair', async () => {
    expect(
      await membershipTestTx((ctx) =>
        candidates().reserve(
          { scope: 'invalid', target_id: '' },
          1000,
          undefined,
          ctx
        )
      )
    ).toMatchObject({ outcome: 'INVALID_TARGET' });
    expect(
      await membershipTestTx((ctx) =>
        candidates().reserve(
          { scope: 'PROFILE', target_id: 'absent' },
          1000,
          undefined,
          ctx
        )
      )
    ).toMatchObject({ outcome: 'MISSING' });
    await patchTarget(
      "available_at_millis=NULL,attempts=3,last_error='parked'"
    );
    expect((await reserve()).outcome).toBe('PARKED');
    await patchTarget('completed_version=1,available_at_millis=1');
    expect((await reserve()).outcome).toBe('SETTLED');
    await patchTarget(
      'completed_version=0,available_at_millis=9223372036854775807'
    );
    expect((await reserve()).outcome).toBe('FUTURE');
    expect(await read()).toMatchObject({
      attempts: 3,
      last_error: 'parked',
      requested_version: '1',
      completed_version: '0'
    });
    await patchTarget('available_at_millis=-1');
    expect((await reserve()).outcome).toBe('INTEGRITY');
    expect((await read())?.available_at_millis).toBe('-1');
  });

  it('changes only finite delivery scheduling and returns canonical exact matching worker metadata', async () => {
    await patchTarget("attempts=2,last_error='retry',available_at_millis=1");
    const before = await read();
    const result = await reserve();
    expect(result.outcome).toBe('RESERVED');
    if (result.outcome !== 'RESERVED')
      throw new Error('Missing fixture reservation');
    const after = await read();
    expect(after).toMatchObject({
      attempts: 2,
      last_error: 'retry',
      requested_version: before!.requested_version,
      completed_version: '0',
      active_run_id: null,
      reason: before!.reason
    });
    expect(result.hint.delivery).toEqual({
      requested_version: '1',
      reserved_until_millis: after!.available_at_millis
    });
    expect(result.observed_due_age_millis).toBeGreaterThan(0);
    expect((await reserve()).outcome).toBe('FUTURE');
    await membershipTestRequest(target.target_id);
    const newer = await reserve();
    expect(newer).toMatchObject({
      outcome: 'RESERVED',
      hint: { delivery: { requested_version: '2' } }
    });
  });

  it('validates active linkage, suppresses live leases and hints expired leases without changing run authority', async () => {
    const claim = await membershipTestClaim(target.target_id);
    await patchTarget('available_at_millis=1');
    expect((await reserve()).outcome).toBe('LIVE_LEASE');
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET lease_expires_at_millis=1 WHERE id=:id`,
      { id: claim.run_id }
    );
    const before = await membershipTestTx((ctx) =>
      membershipTestRuns().run(claim.run_id, false, ctx)
    );
    expect((await reserve()).outcome).toBe('RESERVED');
    expect(
      await membershipTestTx((ctx) =>
        membershipTestRuns().run(claim.run_id, false, ctx)
      )
    ).toEqual(before);
    await patchTarget('available_at_millis=1');
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET request_version=99 WHERE id=:id`,
      { id: claim.run_id }
    );
    expect((await reserve()).outcome).toBe('INTEGRITY');
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET active_run_id=:missing WHERE scope=:scope AND target_id=:target_id`,
      { ...target, missing: randomUUID() }
    );
    expect((await reserve()).outcome).toBe('INTEGRITY');
  });

  it('diagnoses invalid run cursors after advancing the raw position without repairing target state', async () => {
    const claim = await membershipTestClaim(target.target_id);
    await patchTarget('available_at_millis=1');
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET progress_cursor=:cursor WHERE id=:id`,
      { id: claim.run_id, cursor: JSON.stringify({ protocol_version: 999 }) }
    );
    const result = await new MembershipRefreshDispatcher(
      sqlExecutor,
      jest.fn()
    ).run(membershipDispatchTestOptions({ max_candidates: 1 }));
    expect(result.outcomes.INTEGRITY).toBe(1);
    expect(await read()).toMatchObject({
      active_run_id: claim.run_id,
      available_at_millis: '1',
      attempts: 0
    });
  });

  it.each([1, 2])(
    'recovers after a real phase %s commit response is lost without dependent send or compensation',
    async (phase) => {
      const send = jest.fn(async () => {});
      const before = await read();
      await expect(
        new MembershipRefreshDispatcher(failAfterCommit(phase), send).run(
          membershipDispatchTestOptions({ max_candidates: 1 })
        )
      ).rejects.toMatchObject({ commitOutcome: 'UNKNOWN' });
      expect(send).not.toHaveBeenCalled();
      const after = await read();
      expect(after).toMatchObject({
        requested_version: '1',
        completed_version: '0',
        attempts: 0
      });
      if (phase === 1) expect(after).toEqual(before);
      else {
        expect(BigInt(after!.available_at_millis!)).toBeGreaterThan(
          BigInt(before!.available_at_millis!)
        );
        expect((await reserve()).outcome).toBe('FUTURE');
        // Fixture clock advance: only the finite scheduling reservation expires.
        await patchTarget('available_at_millis=1');
      }
      for (
        let attempt = 0;
        attempt < 4 && send.mock.calls.length === 0;
        attempt++
      )
        await new MembershipRefreshDispatcher(sqlExecutor, send).run(
          membershipDispatchTestOptions({ max_candidates: 2 })
        );
      expect(send).toHaveBeenCalledTimes(1);
    }
  );

  it('recovers failed or ambiguous sends by reservation expiry, with no counter decrement', async () => {
    const observed: MembershipDispatchHint[] = [];
    const sender = jest.fn(async (hint) => {
      observed.push(hint);
      throw new Error('SQS response lost after acceptance');
    });
    expect(
      await new MembershipRefreshDispatcher(sqlExecutor, sender).run(
        membershipDispatchTestOptions({ max_candidates: 1 })
      )
    ).toMatchObject({ send_failed: 1, sent: 0 });
    expect(await read()).toMatchObject({
      requested_version: '1',
      completed_version: '0',
      available_at_millis: observed[0].delivery.reserved_until_millis
    });
    const retry = jest.fn(async () => {});
    await new MembershipRefreshDispatcher(sqlExecutor, retry).run(
      membershipDispatchTestOptions({ max_candidates: 2 })
    );
    expect(retry).not.toHaveBeenCalled();
    await patchTarget('available_at_millis=1');
    for (
      let attempt = 0;
      attempt < 4 && retry.mock.calls.length === 0;
      attempt++
    )
      await new MembershipRefreshDispatcher(sqlExecutor, retry).run(
        membershipDispatchTestOptions({ max_candidates: 2 })
      );
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
