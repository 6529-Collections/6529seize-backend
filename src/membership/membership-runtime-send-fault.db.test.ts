import {
  MEMBERSHIP_SOURCE_STATES_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE
} from '@/constants';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipWorkerDb } from './membership-worker.db';
import { MembershipRefreshWorker } from './membership-worker';
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import { MembershipDispatchDb } from './membership-dispatch.db';
import { MembershipDispatchHint } from './membership-dispatch.types';
import { MembershipFixtureControlDb } from './membership-runtime-fixture-control';
import { MembershipRuntimeSendFaultDb } from './membership-runtime-send-fault.db';
import { MEMBERSHIP_FIXTURE_PROFILES } from './membership-runtime-policy';
import { createMembershipFixtureTestHarness } from './membership-runtime-fixture-test.helpers';
import { membershipTestOptions } from './membership-worker-test.helpers';

// Fixture acquisition can wait behind the real lease/reader proof in another worker.
jest.setTimeout(600000);

const target = {
  scope: 'PROFILE' as const,
  target_id: MEMBERSHIP_FIXTURE_PROFILES[0]
};
let fixture: Awaited<ReturnType<typeof createMembershipFixtureTestHarness>>;
const controls = () => new MembershipFixtureControlDb(fixture.db);
const control = () => fixture.tx((ctx) => controls().read(ctx));
const reserve = () =>
  fixture.tx((ctx) =>
    new MembershipDispatchDb(() => fixture.db).reserve(
      target,
      1000,
      undefined,
      ctx
    )
  );
const record = (hint: MembershipDispatchHint) =>
  fixture.tx((ctx) =>
    new MembershipRuntimeSendFaultDb(fixture.db).recordOnce(hint, ctx)
  );
const authority = () =>
  fixture.tx((ctx) =>
    new MembershipWorkerDb(() => fixture.db).target(target, false, ctx)
  );

async function reservedHint() {
  const result = await reserve();
  if (result.outcome !== 'RESERVED')
    throw new Error('Fixture reservation missing');
  return result.hint;
}

beforeEach(async () => {
  fixture = await createMembershipFixtureTestHarness();
  await fixture.schema();
  const ready = await fixture.prepare();
  await fixture.tx(async (ctx) => {
    await new MembershipRefreshTargetsDb(() => fixture.db).request(
      [{ ...target, reason: 'send-failure-test' }],
      ctx
    );
    await controls().update(
      ready.revision,
      { ...ready.state, scenario: 'MISSED_WAKEUP' },
      ctx
    );
  });
});
afterEach(async () => {
  if (fixture) await fixture.close();
});

describe('fixed dispatcher failure receipt on actual MySQL', () => {
  it('changes no authority, naturally expires the failed reservation, and recovers through the real evaluator and worker', async () => {
    const sources = await fixture.db.execute(
      `SELECT * FROM ${MEMBERSHIP_SOURCE_STATES_TABLE} ORDER BY scope,target_id,dimension`
    );
    const hint = await reservedHint();
    const before = await authority();
    expect(await record(hint)).toBe(true);
    expect(await record(hint)).toBe(false);
    expect(await authority()).toEqual(before);
    expect((await control())?.state.dispatch_send_failure).toEqual(
      hint.delivery
    );
    expect(await reserve()).toMatchObject({ outcome: 'FUTURE' });
    const worker = new MembershipRefreshWorker(
      fixture.db,
      new PrimaryMembershipProfileEvaluator(() => fixture.db)
    );
    expect(
      await worker.runTarget(target, membershipTestOptions())
    ).toMatchObject({ outcome: 'NO_WORK' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const recovered = await reservedHint();
    expect(recovered.delivery.requested_version).toBe(
      hint.delivery.requested_version
    );
    expect(BigInt(recovered.delivery.reserved_until_millis)).toBeGreaterThan(
      BigInt(hint.delivery.reserved_until_millis)
    );
    expect(await record(recovered)).toBe(false);
    let page = await worker.runTarget(
      target,
      membershipTestOptions(),
      {},
      recovered.delivery
    );
    expect(page.outcome).toBe('PENDING');
    const runId = page.run_id;
    for (
      let invocation = 0;
      invocation < 24 && page.outcome === 'PENDING';
      invocation++
    ) {
      page = await worker.runTarget(target, membershipTestOptions());
      expect(page.run_id).toBe(runId);
    }
    expect(page.outcome).toBe('COMPLETED');
    expect(await authority()).toMatchObject({
      requested_version: hint.delivery.requested_version,
      completed_version: hint.delivery.requested_version,
      attempts: 0,
      active_run_id: null
    });
    expect(
      await fixture.db.execute(
        `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
        { profile: target.target_id }
      )
    ).toEqual([{ run_id: runId }]);
    expect(
      await fixture.db.execute(
        `SELECT * FROM ${MEMBERSHIP_SOURCE_STATES_TABLE} ORDER BY scope,target_id,dimension`
      )
    ).toEqual(sources);
  }, 60000);

  it('rejects stale or unrelated descriptors and rolls back an uncommitted receipt', async () => {
    const hint = await reservedHint();
    const before = await authority();
    expect(
      await record({
        ...hint,
        target: { ...target, target_id: MEMBERSHIP_FIXTURE_PROFILES[2] }
      })
    ).toBe(false);
    expect(
      await record({
        ...hint,
        delivery: { ...hint.delivery, requested_version: '999' }
      })
    ).toBe(false);
    expect(
      await record({
        ...hint,
        delivery: { ...hint.delivery, reserved_until_millis: '1' }
      })
    ).toBe(false);
    await expect(
      fixture.tx(async (ctx) => {
        expect(
          await new MembershipRuntimeSendFaultDb(fixture.db).recordOnce(
            hint,
            ctx
          )
        ).toBe(true);
        throw new Error('Receipt transaction rollback');
      })
    ).rejects.toThrow('Receipt transaction rollback');
    expect((await control())?.state.dispatch_send_failure).toBeUndefined();
    expect(await authority()).toEqual(before);
    expect(await record(hint)).toBe(true);
  });

  it('reconciles an unknown committed receipt response without failing another send or editing scheduling', async () => {
    const hint = await reservedHint();
    const before = await authority();
    const execute = fixture.db.executeNativeQueriesInTransaction.bind(
      fixture.db
    );
    const spy = jest
      .spyOn(fixture.db, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (callback, options) => {
        await execute(callback, options);
        throw Object.assign(new Error('Lost receipt acknowledgement'), {
          commitOutcome: 'UNKNOWN'
        });
      });
    try {
      await expect(record(hint)).rejects.toMatchObject({
        commitOutcome: 'UNKNOWN'
      });
    } finally {
      spy.mockRestore();
    }
    expect((await control())?.state.dispatch_send_failure).toEqual(
      hint.delivery
    );
    expect(await record(hint)).toBe(false);
    expect(await authority()).toEqual(before);
  });
});
