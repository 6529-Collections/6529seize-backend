import { IDENTITIES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  membershipQueryOptions,
  withMembershipPrimaryMutationContext,
  withMembershipPrimaryTransaction
} from './membership-primary';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import type { MembershipSourceKey } from './membership-validation';

const identity = anIdentity({ rep: 1 });
const profileKey: MembershipSourceKey = {
  scope: 'PROFILE',
  target_id: identity.profile_id!,
  dimension: 'RATINGS'
};
const globalKey: MembershipSourceKey = {
  scope: 'GLOBAL',
  target_id: '*',
  dimension: 'RATINGS'
};
const request = {
  scope: 'PROFILE' as const,
  target_id: identity.profile_id!,
  reason: 'ratings'
};
const sources = () => new MembershipSourceStatesDb(() => sqlExecutor);
const targets = () => new MembershipRefreshTargetsDb(() => sqlExecutor);

async function snapshot() {
  return withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => ({
    rep: await sqlExecutor.oneOrNull<{ rep: number }>(
      `SELECT rep FROM ${IDENTITIES_TABLE} WHERE profile_id = :id`,
      { id: identity.profile_id },
      membershipQueryOptions(ctx)
    ),
    versions: (await sources().read([globalKey, profileKey], false, ctx)).map(
      ({ state }) => state?.version
    ),
    target: await targets().find(request, ctx)
  }));
}

describeWithSeed(
  'membership source mutation in a caller-owned MySQL transaction',
  withIdentities([identity]),
  () => {
    beforeEach(async () => {
      await withMembershipPrimaryTransaction(sqlExecutor, (ctx) =>
        sources().provision(
          [globalKey, profileKey],
          { bootstrap_id: 'adapter-test', coverage_revision: 'test-only' },
          ctx
        )
      );
    });

    const mutate = () =>
      sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        withMembershipPrimaryMutationContext(connection, (ctx) =>
          sources().mutate(
            { keys: [profileKey], requests: [request] },
            async () => {
              await sqlExecutor.execute(
                `UPDATE ${IDENTITIES_TABLE} SET rep = rep + 1 WHERE profile_id = :id`,
                { id: identity.profile_id },
                membershipQueryOptions(ctx)
              );
            },
            ctx
          )
        )
      );

    it('commits source input, version and target together', async () => {
      await mutate();
      expect(await snapshot()).toMatchObject({
        rep: { rep: 2 },
        versions: ['0', '1'],
        target: { requested_version: '1' }
      });
    });

    it('rolls all three writes back when owner work fails after mutation', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          withMembershipPrimaryMutationContext(connection, async (ctx) => {
            await sources().mutate(
              { keys: [profileKey], requests: [request] },
              async () => {
                await sqlExecutor.execute(
                  `UPDATE ${IDENTITIES_TABLE} SET rep = rep + 1 WHERE profile_id = :id`,
                  { id: identity.profile_id },
                  membershipQueryOptions(ctx)
                );
              },
              ctx
            );
            throw new Error('abort owner');
          })
        )
      ).rejects.toThrow('abort owner');
      expect(await snapshot()).toEqual({
        rep: { rep: 1 },
        versions: ['0', '0'],
        target: null
      });
    });

    it('poisons the owner when a repository error is caught inside the adapter', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          withMembershipPrimaryMutationContext(connection, async (ctx) => {
            try {
              await sources().mutate(
                { keys: [profileKey], requests: [request] },
                async () => {
                  await sqlExecutor.execute(
                    `UPDATE ${IDENTITIES_TABLE} SET rep = rep + 1 WHERE profile_id = :id`,
                    { id: identity.profile_id },
                    membershipQueryOptions(ctx)
                  );
                  throw new Error('input failed');
                },
                ctx
              );
            } catch {
              return 'swallowed';
            }
            return 'unexpected';
          })
        )
      ).rejects.toThrow('input failed');
      expect(await snapshot()).toEqual({
        rep: { rep: 1 },
        versions: ['0', '0'],
        target: null
      });
    });
  }
);
