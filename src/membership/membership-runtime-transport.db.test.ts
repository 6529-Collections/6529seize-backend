import { randomUUID } from 'node:crypto';
import {
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE
} from '@/constants';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import { MembershipRefreshWorker } from './membership-worker';
import { MembershipWorkerDb } from './membership-worker.db';
import { MembershipWorkerResult } from './membership-worker.types';
import { MembershipFixtureControlDb } from './membership-runtime-fixture-control';
import {
  MEMBERSHIP_FIXTURE_CONTROL_TABLE,
  MEMBERSHIP_FIXTURE_DATABASE,
  MEMBERSHIP_FIXTURE_OWNER,
  MEMBERSHIP_FIXTURE_PROFILES
} from './membership-runtime-policy';
import {
  assertMembershipFixtureReady,
  MembershipRuntimeTransportDb
} from './membership-runtime-transport.db';
import {
  membershipTestLatch,
  membershipTestOptions
} from './membership-worker-test.helpers';
import { membershipQueryOptions } from './membership-primary';
import { createMembershipFixtureTestHarness } from './membership-runtime-fixture-test.helpers';

const target = {
  scope: 'PROFILE' as const,
  target_id: MEMBERSHIP_FIXTURE_PROFILES[1]
};
// Fixed-database suites serialize behind the real 90s lease / 120s grace proof.
jest.setTimeout(600000);
let fixture: Awaited<ReturnType<typeof createMembershipFixtureTestHarness>>;
const controls = () => new MembershipFixtureControlDb(fixture.db);
const transport = () => new MembershipRuntimeTransportDb(fixture.db);
const worker = () =>
  new MembershipRefreshWorker(
    fixture.db,
    new PrimaryMembershipProfileEvaluator(() => fixture.db)
  );
const inspect = (
  message: string,
  result: MembershipWorkerResult | null = null
) =>
  fixture.tx((ctx) =>
    transport().inspectDelivery(target, message, result, ctx)
  );
const control = () => fixture.tx((ctx) => controls().read(ctx));

async function firstPage() {
  const result = await worker().runTarget(
    target,
    membershipTestOptions({
      transaction_millis: 15000,
      lease_millis: 30000,
      max_statement_millis: 3000
    })
  );
  expect(result.outcome).toBe('PENDING');
  expect(result.checkpoint_version).toBe('1');
  expect(BigInt(result.processed_count)).toBeGreaterThan(BigInt(0));
  return result;
}
async function authority(runId: string) {
  const runs = new MembershipWorkerDb(() => fixture.db);
  return fixture.tx(async (ctx) => ({
    target: await runs.target(target, false, ctx),
    run: await runs.run(runId, false, ctx)
  }));
}

beforeEach(async () => {
  fixture = await createMembershipFixtureTestHarness();
  await fixture.schema();
  await fixture.prepare();
  await fixture.tx((ctx) =>
    new MembershipRefreshTargetsDb(() => fixture.db).request(
      [{ ...target, reason: 'transport-test' }],
      ctx
    )
  );
});
afterEach(async () => {
  if (fixture) await fixture.close();
});

describe('transport receipt on the actual fixed fixture database', () => {
  it('holds the exact message only after a real committed page, with no retry or lease changes', async () => {
    const message = randomUUID();
    expect(await inspect(message)).toEqual({
      outcome: 'PROCEED',
      receipt: null
    });
    const page = await firstPage();
    const before = await authority(page.run_id!);
    const result = await inspect(message, page);
    expect(result).toEqual({
      outcome: 'HELD_MESSAGE',
      receipt: {
        phase: 'HELD',
        message_id: message,
        run_id: page.run_id,
        checkpoint_version: page.checkpoint_version
      }
    });
    expect(await authority(page.run_id!)).toEqual(before);
    expect(await inspect(message)).toEqual(result);
    expect(await inspect(randomUUID())).toEqual({
      ...result,
      outcome: 'OTHER_MESSAGE'
    });
    expect(await fixture.tx((ctx) => transport().heldTarget(target, ctx))).toBe(
      true
    );
    expect(
      await fixture.tx((ctx) =>
        transport().heldTarget(
          { scope: 'PROFILE', target_id: MEMBERSHIP_FIXTURE_PROFILES[0] },
          ctx
        )
      )
    ).toBe(false);
    const nonTransport = await fixture.tx((ctx) =>
      transport().inspectDelivery(
        { scope: 'PROFILE', target_id: MEMBERSHIP_FIXTURE_PROFILES[0] },
        randomUUID(),
        null,
        ctx
      )
    );
    expect(nonTransport).toEqual({ outcome: 'PROCEED', receipt: null });
    expect(
      await fixture.db.execute(
        `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
        { profile: target.target_id }
      )
    ).toEqual([]);
  });

  it('reconstructs a missing receipt from the real committed page after a process is lost', async () => {
    const page = await firstPage();
    expect((await control())?.state.transport).toBeNull();
    const message = randomUUID();
    expect(await inspect(message)).toMatchObject({
      outcome: 'HELD_MESSAGE',
      receipt: {
        run_id: page.run_id,
        checkpoint_version: '1',
        message_id: message
      }
    });
  });

  it('reconciles a lost receipt commit response without replacing the held message or checkpoint', async () => {
    const page = await firstPage();
    const message = randomUUID();
    const original = fixture.db.executeNativeQueriesInTransaction.bind(
      fixture.db
    );
    const spy = jest
      .spyOn(fixture.db, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (callback, options) => {
        await original(callback, options);
        throw Object.assign(new Error('Receipt commit response lost'), {
          commitOutcome: 'UNKNOWN'
        });
      });
    try {
      await expect(inspect(message, page)).rejects.toMatchObject({
        commitOutcome: 'UNKNOWN'
      });
    } finally {
      spy.mockRestore();
    }
    const held = await inspect(message);
    expect(held).toMatchObject({
      outcome: 'HELD_MESSAGE',
      receipt: {
        run_id: page.run_id,
        checkpoint_version: '1',
        message_id: message
      }
    });
    expect(await inspect(randomUUID())).toEqual({
      ...held,
      outcome: 'OTHER_MESSAGE'
    });
  });

  it('corrects only the held condition and resumes the same real generation through publication', async () => {
    const page = await firstPage();
    const message = randomUUID();
    await inspect(message, page);
    const before = await authority(page.run_id!);
    const corrected = await fixture.tx((ctx) => fixture.service.advance(ctx));
    expect(corrected.state.transport).toEqual({
      phase: 'CORRECTED',
      message_id: message,
      run_id: page.run_id,
      checkpoint_version: '1'
    });
    expect(await authority(page.run_id!)).toEqual(before);
    expect(await inspect(message)).toMatchObject({
      outcome: 'PROCEED',
      receipt: { phase: 'CORRECTED' }
    });
    expect(await fixture.tx((ctx) => transport().heldTarget(target, ctx))).toBe(
      false
    );
    let finished: MembershipWorkerResult | null = null;
    for (let invocation = 0; invocation < 25; invocation++) {
      const result = await worker().runTarget(
        target,
        membershipTestOptions({
          transaction_millis: 15000,
          lease_millis: 30000,
          max_statement_millis: 3000
        })
      );
      expect(result.run_id).toBe(page.run_id);
      if (result.outcome === 'COMPLETED') {
        finished = result;
        break;
      }
      expect(result.outcome).toBe('PENDING');
    }
    expect(finished?.outcome).toBe('COMPLETED');
    expect(
      await fixture.db.execute(
        `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
        { profile: target.target_id }
      )
    ).toEqual([{ run_id: page.run_id }]);
    expect((await control())?.state.transport?.checkpoint_version).toBe('1');
  }, 60000);

  it('rejects missing readiness, invalid marker and mismatched manifest before creating proof', async () => {
    await firstPage();
    const ready = (await control())!;
    await fixture.tx((ctx) =>
      controls().update(
        ready.revision,
        { ...ready.state, setup_stage: 'CATALOGUED' },
        ctx
      )
    );
    await expect(inspect(randomUUID())).rejects.toThrow('not ready');
    expect((await control())?.state.transport).toBeNull();
    const pending = (await control())!;
    await fixture.tx((ctx) =>
      controls().update(pending.revision, ready.state, ctx)
    );
    await fixture.db.execute(
      `UPDATE ${MEMBERSHIP_FIXTURE_CONTROL_TABLE} SET manifest_hash=:hash WHERE id=:id`,
      { id: MEMBERSHIP_FIXTURE_OWNER, hash: '0'.repeat(64) }
    );
    await expect(inspect(randomUUID())).rejects.toThrow('not ready');
    await fixture.db.execute(
      `UPDATE ${MEMBERSHIP_FIXTURE_CONTROL_TABLE} SET protocol_version=2 WHERE id=:id`,
      { id: MEMBERSHIP_FIXTURE_OWNER }
    );
    await expect(
      fixture.tx((ctx) => assertMembershipFixtureReady(fixture.db, ctx))
    ).rejects.toThrow('Invalid fixture ownership');
    await fixture.db.execute(
      `DELETE FROM ${MEMBERSHIP_FIXTURE_CONTROL_TABLE} WHERE id=:id`,
      { id: MEMBERSHIP_FIXTURE_OWNER }
    );
    await expect(inspect(randomUUID())).rejects.toThrow('not ready');
  });

  it('rejects fabricated future checkpoints and detached active-run evidence without minting a receipt', async () => {
    const page = await firstPage();
    await expect(
      inspect(randomUUID(), { ...page, checkpoint_version: '999' })
    ).rejects.toThrow('inconsistent');
    expect((await control())?.state.transport).toBeNull();
    await expect(
      inspect(randomUUID(), { ...page, run_id: randomUUID() })
    ).rejects.toThrow('no durable checkpoint');
    await fixture.db.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET active_run_id=NULL WHERE scope=:scope AND target_id=:target_id`,
      target
    );
    await expect(inspect(randomUUID(), page)).rejects.toThrow('inconsistent');
    expect((await control())?.state.transport).toBeNull();
  });

  it('serializes receipt creation after concurrent deliveries both passed the preflight', async () => {
    const first = randomUUID();
    const second = randomUUID();
    expect((await inspect(first)).outcome).toBe('PROCEED');
    expect((await inspect(second)).outcome).toBe('PROCEED');
    const page = await firstPage();
    const ready = membershipTestLatch();
    const release = membershipTestLatch();
    const heldTransaction = fixture.tx(async (ctx) => {
      const held = await transport().inspectDelivery(target, first, page, ctx);
      ready.resolve();
      await release.promise;
      return held;
    });
    await ready.promise;
    try {
      await expect(inspect(second, page)).rejects.toMatchObject({
        serverCode: 'ER_LOCK_NOWAIT'
      });
    } finally {
      release.resolve();
      await heldTransaction;
    }
    expect((await inspect(second, page)).outcome).toBe('OTHER_MESSAGE');
    expect((await control())?.state.transport?.message_id).toBe(first);
    expect((await authority(page.run_id!)).run?.checkpoint_version).toBe('1');
  });

  it('rolls back an invalid message receipt without changing the committed worker page', async () => {
    const page = await firstPage();
    const before = await authority(page.run_id!);
    await expect(inspect('not-a-uuid', page)).rejects.toThrow();
    expect((await control())?.state.transport).toBeNull();
    expect(await authority(page.run_id!)).toEqual(before);
    // The actual fixed database selection is exercised by every control read.
    expect(
      await fixture.tx((ctx) =>
        fixture.db.execute(
          'SELECT DATABASE() selected_database',
          {},
          membershipQueryOptions(ctx)
        )
      )
    ).toEqual([{ selected_database: MEMBERSHIP_FIXTURE_DATABASE }]);
  });
});
