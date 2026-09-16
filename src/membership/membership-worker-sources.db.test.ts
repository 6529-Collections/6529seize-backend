import { randomUUID } from 'node:crypto';
import { IDENTITIES_TABLE, MEMBERSHIP_SOURCE_STATES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { MembershipWorkerSourcesDb } from './membership-worker-sources.db';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { MEMBERSHIP_FANOUT_KEYS } from './membership-worker-validation';
import { MembershipWorkerRun } from './membership-worker.types';
import {
  membershipTestTargets,
  membershipTestTx
} from './membership-worker-test.helpers';

const sources = () => new MembershipWorkerSourcesDb(() => sqlExecutor);
let addressSequence = 0;
function identity(profile: string) {
  const address = `0x${String(++addressSequence).padStart(40, '0')}`;
  return anIdentity(
    {},
    {
      profile_id: profile,
      consolidation_key: address,
      primary_address: address,
      handle: `identity-${addressSequence}`
    }
  );
}
async function insertProfiles(profiles: string[]) {
  const rows = profiles.map(identity);
  await sqlExecutor.bulkInsert(IDENTITIES_TABLE, rows, Object.keys(rows[0]));
}
async function run(): Promise<MembershipWorkerRun> {
  const seed = await membershipTestTx((ctx) => sources().fanoutSeed(ctx));
  return {
    ...seed,
    id: randomUUID(),
    scope: 'FULL',
    target_id: '*',
    request_version: '1',
    status: 'RUNNING',
    spec_version: 2,
    progress_cursor: {
      protocol_version: 1,
      kind: 'PROFILE_FANOUT',
      phase: 'SCAN',
      after_id: null,
      through_id: seed.through_id,
      traversal_collation: seed.traversal_collation
    },
    valid_until_millis: null,
    lease_token: randomUUID(),
    lease_expires_at_millis: '9223372036854775807',
    checkpoint_version: '0',
    processed_count: '0',
    created_at_millis: '1',
    updated_at_millis: '1',
    completed_at_millis: null
  };
}

describeWithSeed('membership fanout source traversal', [], () => {
  beforeEach(async () => {
    await membershipTestTx((ctx) =>
      new MembershipSourceStatesDb(() => sqlExecutor).provision(
        MEMBERSHIP_FANOUT_KEYS,
        { bootstrap_id: 'm4-fanout-order', coverage_revision: 'fixture-only' },
        ctx
      )
    );
  });

  it('follows source collation even when it differs from binary destination ordering', async () => {
    await insertProfiles(['B', 'a', 'z']);
    let current = await run();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await membershipTestTx((ctx) =>
        sources().fanoutPage(current, 1, ctx)
      );
      ids.push(...page.ids);
      current = {
        ...current,
        progress_cursor: { ...current.progress_cursor, after_id: page.after_id }
      };
    }
    expect(ids).toEqual(['a', 'B', 'z']);
  });

  it.each([
    ['a', 'a', 'z'],
    ['a', 'A', 'z']
  ])(
    'rejects canonical identity duplicates at the page sentinel boundary: %j',
    async (...ids) => {
      await insertProfiles(ids);
      const current = await run();
      await expect(
        membershipTestTx((ctx) => sources().fanoutPage(current, 1, ctx))
      ).rejects.toMatchObject({ code: 'INTEGRITY' });
    }
  );

  it('keeps fixed H across identity growth, while new profiles carry their own requests', async () => {
    await insertProfiles(['b', 'z']);
    const current = await run();
    const first = await membershipTestTx((ctx) =>
      sources().fanoutPage(current, 1, ctx)
    );
    const rows = ['a', 'zz'].map(identity);
    await membershipTestTx((ctx) =>
      new MembershipSourceStatesDb(() => sqlExecutor).mutate(
        {
          keys: [{ scope: 'GLOBAL', target_id: '*', dimension: 'IDENTITY' }],
          requests: rows.map((row) => ({
            scope: 'PROFILE',
            target_id: row.profile_id!,
            reason: 'm4-new-identity'
          }))
        },
        (primary) =>
          sqlExecutor.bulkInsert(
            IDENTITIES_TABLE,
            rows,
            Object.keys(rows[0]),
            primary
          ),
        ctx
      )
    );
    const continued = {
      ...current,
      progress_cursor: { ...current.progress_cursor, after_id: first.after_id }
    };
    const page = await membershipTestTx(async (ctx) => {
      await sources().validateSources(continued, false, ctx);
      return sources().fanoutPage(continued, 2, ctx);
    });
    expect(page).toEqual({ ids: ['z'], after_id: 'z', done: true });
    expect(continued.progress_cursor.through_id).toBe('z');
    for (const id of ['a', 'zz'])
      expect(
        await membershipTestTx((ctx) =>
          membershipTestTargets().find({ scope: 'PROFILE', target_id: id }, ctx)
        )
      ).toMatchObject({ requested_version: '1', completed_version: '0' });
  });

  it('allows active catalogue audit but blocks identity barriers and regressions', async () => {
    await insertProfiles(['a']);
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET active_jobs=1 WHERE dimension='GROUP_CATALOG'`
    );
    const current = await run();
    expect(current.source_versions).toHaveLength(2);
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET active_jobs=1 WHERE dimension='IDENTITY'`
    );
    await expect(
      membershipTestTx((ctx) => sources().validateSources(current, true, ctx))
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_READY' });
    await sqlExecutor.execute(
      `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET active_jobs=0 WHERE dimension='IDENTITY'`
    );
    const future = {
      ...current,
      source_versions: current.source_versions.map((entry) => ({
        ...entry,
        version: entry.dimension === 'IDENTITY' ? '1' : entry.version
      }))
    };
    await expect(
      membershipTestTx((ctx) => sources().validateSources(future, true, ctx))
    ).rejects.toMatchObject({ code: 'INTEGRITY' });
  });

  it('rejects malformed frontiers instead of treating their empty result as exhaustion', async () => {
    await insertProfiles(['a', 'z']);
    const current = await run();
    for (const cursor of [
      { ...current.progress_cursor, after_id: 'zz' },
      { ...current.progress_cursor, after_id: 'a', through_id: null }
    ])
      await expect(
        membershipTestTx((ctx) =>
          sources().fanoutPage({ ...current, progress_cursor: cursor }, 1, ctx)
        )
      ).rejects.toMatchObject({ code: 'INTEGRITY' });
  });
});
