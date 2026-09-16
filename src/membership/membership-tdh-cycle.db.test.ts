jest.mock('./membership-producer-policy', () => ({
  isMembershipSourceTrackingActive: () => true
}));

import { IDENTITIES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  membershipQueryOptions,
  withMembershipPrimaryTransaction
} from './membership-primary';
import { membershipGlobalMutation } from './membership-producer-writes';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import {
  activateMembershipTdhStats,
  checkpointMembershipTdhInputs,
  checkpointMembershipTdhUniverse,
  completeMembershipTdhCycle,
  findActiveMembershipTdhCycle,
  getMembershipTdhCycleState,
  membershipTdhCycleId,
  membershipTdhCycleCalculationDate,
  startMembershipTdhCycle
} from './membership-tdh-cycle';

const identity = anIdentity({ rep: 1 });
const keys = membershipGlobalMutation(
  ['TDH_XTDH', 'RATINGS', 'IDENTITY', 'GRANTS'],
  'tdh-source-cycle'
).keys;
const sources = new MembershipSourceStatesDb(() => sqlExecutor);
const cycleId = membershipTdhCycleId('tdh-full', ['cycle-test']);
const secondCycleId = membershipTdhCycleId('tdh-full', ['overlap']);

const bumpRep = (connection: { connection: unknown }) =>
  sqlExecutor.execute(
    `UPDATE ${IDENTITIES_TABLE} SET rep = rep + 1 WHERE profile_id = :id`,
    { id: identity.profile_id },
    { wrappedConnection: connection }
  );

it('retains the original UTC calculation date in a full TDH cycle ID', () => {
  const date = '2026-09-15T00:00:00.000Z';
  const id = membershipTdhCycleId('tdh-full', [date, 'daily']);
  expect(membershipTdhCycleCalculationDate(id)).toEqual(new Date(date));
  expect(() => membershipTdhCycleCalculationDate('tdh-full:opaque')).toThrow(
    'replayable calculation date'
  );
});

describeWithSeed('TDH source cycle handoff', withIdentities([identity]), () => {
  beforeEach(async () => {
    await withMembershipPrimaryTransaction(sqlExecutor, (ctx) =>
      sources.provision(
        keys,
        { bootstrap_id: 'tdh-test', coverage_revision: 'cycle-test' },
        ctx
      )
    );
  });

  it('holds one barrier through inputs, universe, stats activation and completion', async () => {
    await startMembershipTdhCycle(cycleId);
    expect((await findActiveMembershipTdhCycle())?.cycleId).toBe(cycleId);
    await expect(startMembershipTdhCycle(secondCycleId)).rejects.toThrow(
      'evidence'
    );
    await checkpointMembershipTdhInputs(cycleId, {}, async (ctx) => {
      await sqlExecutor.execute(
        `UPDATE ${IDENTITIES_TABLE} SET rep = rep + 1 WHERE profile_id = :id`,
        { id: identity.profile_id },
        membershipQueryOptions(ctx)
      );
    });
    expect((await getMembershipTdhCycleState(cycleId))?.progress.stage).toBe(
      'TDH_INPUTS_COMMITTED'
    );

    const applied = await sqlExecutor.executeNativeQueriesInTransaction(
      (connection) =>
        checkpointMembershipTdhUniverse(
          cycleId,
          connection,
          async () => {
            await bumpRep(connection);
          },
          { connection }
        )
    );
    expect(applied).toBe(true);
    await expect(completeMembershipTdhCycle(cycleId)).rejects.toThrow(
      'statistics activation'
    );
    await activateMembershipTdhStats(cycleId, async (ctx) => {
      await sqlExecutor.execute(
        `UPDATE ${IDENTITIES_TABLE} SET rep = rep + 1 WHERE profile_id = :id`,
        { id: identity.profile_id },
        membershipQueryOptions(ctx)
      );
    });
    await completeMembershipTdhCycle(cycleId);
    expect((await getMembershipTdhCycleState(cycleId))?.status).toBe(
      'COMPLETED'
    );
    expect(await findActiveMembershipTdhCycle()).toBeNull();

    const delayed = await sqlExecutor.executeNativeQueriesInTransaction(
      (connection) =>
        checkpointMembershipTdhUniverse(cycleId, connection, async () => {
          await bumpRep(connection);
        })
    );
    expect(delayed).toBe(false);
    await completeMembershipTdhCycle(cycleId);
    expect(
      await sqlExecutor.oneOrNull<{ rep: number }>(
        `SELECT rep FROM ${IDENTITIES_TABLE} WHERE profile_id = :id`,
        { id: identity.profile_id }
      )
    ).toEqual({ rep: 4 });
    const evidence = await withMembershipPrimaryTransaction(
      sqlExecutor,
      (ctx) => sources.read(keys, false, ctx)
    );
    expect(evidence.every(({ state }) => state?.active_jobs === 0)).toBe(true);
  });
});
