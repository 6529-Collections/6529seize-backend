import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MembershipFixtureDbProofService } from './membership-runtime-fixture-db-proof';
import { MembershipFixtureControlDb } from './membership-runtime-fixture-control';
import { MembershipWorkerDb } from './membership-worker.db';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipRefreshWorker } from './membership-worker';
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import { MembershipGcCheckpointsDb } from './membership-gc-checkpoints.db';
import { membershipTestOptions } from './membership-worker-test.helpers';
import {
  createMembershipFixtureTestHarness,
  membershipFixtureTestEnvironment,
  MembershipFixtureTestHarness
} from './membership-runtime-fixture-test.helpers';
import { MEMBERSHIP_FIXTURE_PROFILES } from './membership-runtime-policy';
import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE
} from '@/constants';
import { membershipQueryOptions } from './membership-primary';
import { MembershipFixtureDbProof } from './membership-runtime-fixture-db-proof.types';
import type { DbQueryOptions } from '@/db-query.options';

jest.setTimeout(600000);
let fixture: MembershipFixtureTestHarness;
const controls = () => new MembershipFixtureControlDb(fixture.db);
const runs = () => new MembershipWorkerDb(() => fixture.db);
const read = () => fixture.tx((ctx) => controls().read(ctx));
const service = () =>
  new MembershipFixtureDbProofService(
    fixture.db,
    membershipFixtureTestEnvironment
  );
const invocation = () => ({
  awsRequestId: randomUUID(),
  getRemainingTimeInMillis: () => 450000
});
const worker = () =>
  new MembershipRefreshWorker(
    fixture.db,
    new PrimaryMembershipProfileEvaluator(() => fixture.db)
  );

async function finish(target: {
  scope: 'FULL' | 'PROFILE';
  target_id: string;
}) {
  for (let i = 0; i < 24; i++) {
    const result = await worker().runTarget(
      target,
      membershipTestOptions({
        transaction_millis: 15000,
        lease_millis: 90000,
        max_statement_millis: 1000,
        max_quanta: 1,
        page_size: 2
      })
    );
    if (result.outcome === 'COMPLETED') return result;
    expect(result.outcome).toBe('PENDING');
  }
  throw new Error('Test prerequisite did not complete');
}

async function prerequisites() {
  const full = await finish({ scope: 'FULL', target_id: '*' });
  for (const profile of MEMBERSHIP_FIXTURE_PROFILES)
    await finish({ scope: 'PROFILE', target_id: profile });
  await fixture.tx(async (ctx) => {
    const control = (await controls().read(ctx))!;
    const now = await runs().now(ctx);
    const transport = (await runs().target(
      { scope: 'PROFILE', target_id: MEMBERSHIP_FIXTURE_PROFILES[1] },
      false,
      ctx
    ))!;
    const long = (await runs().target(
      { scope: 'PROFILE', target_id: MEMBERSHIP_FIXTURE_PROFILES[0] },
      false,
      ctx
    ))!;
    const fullTarget = (await runs().target(
      { scope: 'FULL', target_id: '*' },
      false,
      ctx
    ))!;
    const publication = (await fixture.db.oneOrNull<{ run_id: string }>(
      `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
      { profile: MEMBERSHIP_FIXTURE_PROFILES[1] },
      membershipQueryOptions(ctx)
    ))!;
    const transportRun = (await runs().run(publication.run_id, false, ctx))!;
    // Administrative prerequisites only. The separate scenario integration
    // suite proves their real transitions; this suite measures step 4 itself.
    await controls().update(
      control.revision,
      {
        ...control.state,
        scenario: 'IDENTITY_RECOVERED',
        transport: {
          phase: 'CORRECTED',
          message_id: randomUUID(),
          run_id: publication.run_id,
          checkpoint_version: transportRun.checkpoint_version
        },
        proof: {
          protocol_version: 1,
          identity_retry: {
            requested_version: String(
              BigInt(transport.requested_version) - BigInt(1)
            ),
            previous_publication_run_id: publication.run_id,
            peer_requested_version: long.requested_version,
            observations: [
              {
                attempts: 3,
                observed_at_millis: now,
                available_at_millis: null
              }
            ],
            parked_observed_at_millis: now
          },
          fanout: {
            request_version: fullTarget.requested_version,
            captured: {
              run_id: full.run_id!,
              checkpoint_version: full.checkpoint_version!,
              through_id: MEMBERSHIP_FIXTURE_PROFILES[0],
              after_id: MEMBERSHIP_FIXTURE_PROFILES[2],
              restored_profile_request_version: transport.requested_version,
              completed_observed_at_millis: now
            }
          }
        }
      },
      ctx
    );
    await new MembershipGcCheckpointsDb(() => fixture.db).provision(ctx);
  });
}

beforeAll(async () => {
  fixture = await createMembershipFixtureTestHarness();
  await fixture.schema();
  await fixture.prepare();
  await prerequisites();
});
afterAll(async () => {
  if (fixture) await fixture.close();
});
afterEach(() => jest.restoreAllMocks());

describe('real fixed-fixture lease replay and concurrent-reader GC proof', () => {
  let completed: MembershipFixtureDbProof;

  it('waits the real 90s lease and 120s reader grace, fences old authority, and deletes only the old publication', async () => {
    let readerCleanupChecked = false;
    const execute = fixture.db.execute.bind(fixture.db);
    jest.spyOn(fixture.db, 'execute').mockImplementation(async function <T>(
      sql: string,
      params?: Record<string, unknown>,
      options?: DbQueryOptions
    ): Promise<T[]> {
      const rows = await execute<T>(sql, params, options);
      if (
        sql === 'SELECT CAST(CONNECTION_ID() AS CHAR) id' &&
        !readerCleanupChecked
      ) {
        readerCleanupChecked = true;
        const before = await read();
        await expect(
          fixture.tx((ctx) => fixture.service.cleanup(ctx))
        ).rejects.toThrow('active database proof reader');
        expect(await read()).toEqual(before);
      }
      return rows;
    });
    const start = performance.now();
    const action = service().run(invocation());
    // Attach immediately so a failure before the first observation is handled.
    const outcome = action.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    try {
      let control = await read();
      for (let n = 0; n < 30 && !control?.state.proof?.db_runtime; n++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        control = await read();
      }
      const held = control?.state.proof?.db_runtime;
      if (!held) {
        const initial = await outcome;
        if ('error' in initial) throw initial.error;
        throw new Error('Proof finished without a visible lease receipt');
      }
      expect(held.phase).toBe('LEASE_WAIT');
      const actual = await fixture.tx((ctx) =>
        runs().run(held.lease.run_id, false, ctx)
      );
      expect(actual).toMatchObject({
        status: 'RUNNING',
        lease_token: held.lease.lease_token,
        lease_expires_at_millis: held.lease.expires_at_millis
      });
      await expect(service().run(invocation())).rejects.toThrow(
        'active invocation'
      );
      await expect(
        fixture.tx((ctx) => fixture.service.cleanup(ctx))
      ).rejects.toThrow();
      const result = await outcome;
      if ('error' in result) throw result.error;
      expect(result.value.phase).toBe('DONE');
      expect(readerCleanupChecked).toBe(true);
      expect(performance.now() - start).toBeGreaterThan(209000);
      expect(result.value.lease).toMatchObject({
        checkpoint_fenced: true,
        completion_fenced: true,
        failure_fenced: true
      });
      expect(
        BigInt(result.value.lease.expires_at_millis) -
          BigInt(result.value.lease.claimed_at_millis)
      ).toBe(BigInt(90000));
      expect(result.value.gc!.reader_connection_id).not.toBe(
        result.value.gc!.writer_connection_id
      );
      expect(
        BigInt(result.value.gc!.eligible_at_millis!) -
          BigInt(result.value.gc!.retired_at_millis!)
      ).toBe(BigInt(120000));
      expect(BigInt(result.value.gc!.reader_verified_at_millis!)).toBeLessThan(
        BigInt(result.value.gc!.eligible_at_millis!)
      );
      expect(result.value.gc!.deleted_count).toBe(
        result.value.gc!.member_count
      );
      expect(result.value.gc!.member_count).toBeGreaterThan(2);
      expect(JSON.stringify(result.value)).not.toContain('lease_token');
      completed = (await read())!.state.proof!.db_runtime!;
      expect(
        await fixture.tx((ctx) =>
          runs().run(completed.gc!.old_run_id, false, ctx)
        )
      ).toBeNull();
      expect(await service().run(invocation())).toEqual(result.value);
    } finally {
      // Even a failed early assertion must finish the bounded owner before the
      // fixed-database harness releases its advisory lock and closes the pool.
      await outcome;
    }
  });

  it('fails closed after a lost overlap and never requests another replacement on replay', async () => {
    // Create precisely the interrupted state with real publication transitions;
    // retain the prior measured lease evidence, and never edit lease/time rows.
    await fixture.tx(async (ctx) => {
      const control = (await controls().read(ctx))!;
      const profile = MEMBERSHIP_FIXTURE_PROFILES[0];
      const old = (await fixture.db.oneOrNull<{ run_id: string }>(
        `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
        { profile },
        membershipQueryOptions(ctx)
      ))!;
      const members = await fixture.db.execute<{ group_id: string }>(
        `SELECT m.group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} m WHERE m.run_id=:run ORDER BY m.group_id LIMIT 37`,
        { run: old.run_id },
        membershipQueryOptions(ctx)
      );
      expect(members).toHaveLength(completed.gc!.member_count);
      await new MembershipRefreshTargetsDb(() => fixture.db).request(
        [
          {
            scope: 'PROFILE',
            target_id: profile,
            reason: 'test-interrupted-reader'
          }
        ],
        ctx
      );
      const target = (await runs().target(
        { scope: 'PROFILE', target_id: profile },
        false,
        ctx
      ))!;
      await controls().update(
        control.revision,
        {
          ...control.state,
          proof: {
            ...control.state.proof!,
            db_runtime: {
              ...completed,
              phase: 'GC_OVERLAP',
              completed_at_millis: null,
              gc: {
                ...completed.gc!,
                old_run_id: old.run_id,
                request_version: target.requested_version,
                new_run_id: null,
                reader_connection_id: null,
                writer_connection_id: null,
                reader_verified_at_millis: null,
                retired_at_millis: null,
                eligible_at_millis: null,
                deleted_count: 0
              }
            }
          }
        },
        ctx
      );
    });
    const replacement = await finish({
      scope: 'PROFILE',
      target_id: MEMBERSHIP_FIXTURE_PROFILES[0]
    });
    const first = await service().run(invocation());
    expect(first).toMatchObject({
      phase: 'INTERRUPTED',
      interruption: 'READER_OVERLAP_LOST'
    });
    const targetBefore = await fixture.tx((ctx) =>
      runs().target(
        { scope: 'PROFILE', target_id: MEMBERSHIP_FIXTURE_PROFILES[0] },
        false,
        ctx
      )
    );
    expect(await service().run(invocation())).toEqual(first);
    const targetAfter = await fixture.tx((ctx) =>
      runs().target(
        { scope: 'PROFILE', target_id: MEMBERSHIP_FIXTURE_PROFILES[0] },
        false,
        ctx
      )
    );
    expect(targetAfter).toEqual(targetBefore);
    expect(
      await fixture.tx((ctx) => runs().run(replacement.run_id!, false, ctx))
    ).toMatchObject({ status: 'COMPLETED' });
  });
});
