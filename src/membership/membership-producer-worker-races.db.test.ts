jest.mock('./membership-producer-policy', () => ({
  isMembershipSourceTrackingActive: () => true
}));

import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMES_CONTRACT,
  USER_GROUPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import * as loopDb from '@/db';
import { DataSource } from 'typeorm';
import { NFTOwner, NftOwnersSyncState } from '@/entities/INFTOwner';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import {
  getNftOwnersSyncBlock,
  persistNftOwners,
  setNftOwnersSyncBlock
} from '@/nftOwnersLoop/db.nft_owners';
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import { membershipQueryOptions } from './membership-primary';
import { runMembershipGlobalSourceJob } from './membership-producer-writes';
import {
  activateMembershipTdhStats,
  checkpointMembershipTdhInputs,
  checkpointMembershipTdhUniverse,
  completeMembershipTdhCycle,
  membershipTdhCycleId,
  startMembershipTdhCycle
} from './membership-tdh-cycle';
import { MembershipRefreshWorker } from './membership-worker';
import {
  membershipTestOptions,
  membershipTestProvision,
  membershipTestRequest,
  membershipTestTargets,
  membershipTestTx
} from './membership-worker-test.helpers';

const profile = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000065';
const wallet = '0x0000000000000000000000000000000000000065';
const identity = anIdentity(
  { tdh: 20 },
  {
    profile_id: profile,
    consolidation_key: wallet,
    primary_address: wallet,
    handle: 'membership-race'
  }
);
const profileTarget = { scope: 'PROFILE' as const, target_id: profile };
const fullTarget = { scope: 'FULL' as const, target_id: '*' };
const groupId = 'membership-race-group';
const groupTarget = { scope: 'GROUP' as const, target_id: groupId };
const worker = () =>
  new MembershipRefreshWorker(
    sqlExecutor,
    new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
  );

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function insertGroup(values: Parameters<typeof aUserGroup>[0]) {
  const group = aUserGroup(values, { id: groupId, name: groupId });
  const row = withUserGroups([group]).rows[0];
  await sqlExecutor.bulkInsert(USER_GROUPS_TABLE, [row], Object.keys(row));
  await sqlExecutor.bulkInsert(
    MEMBERSHIP_GROUP_VERSIONS_TABLE,
    [
      {
        group_id: groupId,
        catalog_version: '0',
        is_deleted: false,
        updated_at_millis: '1'
      }
    ],
    ['group_id', 'catalog_version', 'is_deleted', 'updated_at_millis']
  );
  const { serial_no: _serial, ...wave } = aWave(
    { visibility_group_id: groupId },
    { id: 'membership-race-wave', name: groupId }
  );
  await sqlExecutor.bulkInsert(WAVES_TABLE, [wave], Object.keys(wave));
}

async function runUntilSettled(
  target: typeof profileTarget | typeof fullTarget | typeof groupTarget
) {
  for (let n = 0; n < 30; n++) {
    const result = await worker().runTarget(target, membershipTestOptions());
    if (result.outcome === 'COMPLETED' || result.outcome === 'FAILED')
      return result;
    if (result.outcome === 'NO_WORK')
      await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Worker did not settle within the test bound');
}

async function publicationMembers() {
  return sqlExecutor.execute<{ group_id: string }>(
    `SELECT m.group_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} p
     JOIN ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} m ON m.run_id=p.run_id
     WHERE p.profile_id=:profile ORDER BY m.group_id`,
    { profile }
  );
}

describeWithSeed(
  'tracked producer and real membership worker interleavings',
  withIdentities([identity]),
  () => {
    beforeEach(async () => {
      await membershipTestProvision(profile);
      await membershipTestRequest(profile);
    });

    it('keeps the ownership barrier through persistence and publishes only the committed NFT input', async () => {
      await insertGroup({ owns_meme: true });
      const producerDb = new DataSource({
        type: 'mysql',
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        username: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        entities: [NFTOwner, NftOwnersSyncState],
        synchronize: false
      });
      let dataSource: jest.SpyInstance | undefined;
      try {
        await producerDb.initialize();
        dataSource = jest
          .spyOn(loopDb, 'getDataSource')
          .mockReturnValue(producerDb);
        await sqlExecutor.bulkInsert(
          ADDRESS_CONSOLIDATION_KEY,
          [{ address: wallet, consolidation_key: wallet }],
          ['address', 'consolidation_key']
        );
        const entered = latch();
        const resume = latch();
        const producer = runMembershipGlobalSourceJob(
          'nft-owners:0:1',
          ['OWNERSHIP'],
          'nft-owners-reconciled',
          async () => {
            entered.resolve();
            await resume.promise;
            await persistNftOwners(
              new Set([wallet]),
              [
                {
                  wallet,
                  contract: MEMES_CONTRACT,
                  token_id: 1,
                  balance: 1,
                  block_reference: 1
                }
              ],
              true
            );
            await setNftOwnersSyncBlock(1);
          }
        );
        try {
          await entered.promise;
          const blocked = await worker().runTarget(
            profileTarget,
            membershipTestOptions()
          );
          expect(blocked.outcome).not.toBe('COMPLETED');
          expect(
            await sqlExecutor.execute(
              `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
            )
          ).toEqual([]);
        } finally {
          resume.resolve();
        }
        await producer;
        expect(await getNftOwnersSyncBlock()).toBe(1);
        expect((await runUntilSettled(fullTarget)).outcome).toBe('COMPLETED');
        expect((await runUntilSettled(profileTarget)).outcome).toBe(
          'COMPLETED'
        );
        expect(await publicationMembers()).toEqual([{ group_id: groupId }]);
        expect(
          await membershipTestTx((ctx) =>
            membershipTestTargets().find(profileTarget, ctx)
          )
        ).toMatchObject({ completed_version: '2', requested_version: '2' });

        await membershipTestRequest(profile);
        const stale = await worker().runTarget(
          profileTarget,
          membershipTestOptions()
        );
        expect(stale.outcome).toBe('PENDING');
        await runMembershipGlobalSourceJob(
          'nft-owners:1:2',
          ['OWNERSHIP'],
          'nft-owners-reconciled',
          async () => {
            await persistNftOwners(new Set([wallet]), [], false);
            await setNftOwnersSyncBlock(2);
          }
        );
        expect(await getNftOwnersSyncBlock()).toBe(2);
        const superseded = await worker().runTarget(
          profileTarget,
          membershipTestOptions()
        );
        expect(superseded).toMatchObject({
          outcome: 'SUPERSEDED',
          run_id: stale.run_id
        });
        expect(await publicationMembers()).toEqual([{ group_id: groupId }]);
        expect((await runUntilSettled(fullTarget)).outcome).toBe('COMPLETED');
        expect((await runUntilSettled(profileTarget)).outcome).toBe(
          'COMPLETED'
        );
        expect(await publicationMembers()).toEqual([]);
      } finally {
        dataSource?.mockRestore();
        if (producerDb.isInitialized) await producerDb.destroy();
      }
    });

    it.each(['tdh-full', 'delegation'] as const)(
      'fences a stale profile and FULL/GROUP fanout while the %s cycle overlaps',
      async (kind) => {
        await insertGroup({ tdh_min: 50 });
        const first = await worker().runTarget(
          profileTarget,
          membershipTestOptions()
        );
        expect(first.outcome).toBe('PENDING');
        const cycleId = membershipTdhCycleId(kind, [kind, 'race']);
        await startMembershipTdhCycle(cycleId);
        await membershipTestTx((ctx) =>
          membershipTestTargets().request(
            [
              { ...fullTarget, reason: 'overlap-full' },
              { ...groupTarget, reason: 'overlap-group' }
            ],
            ctx
          )
        );
        for (const target of [profileTarget, groupTarget, fullTarget]) {
          const blocked = await worker().runTarget(
            target,
            membershipTestOptions()
          );
          expect(blocked.outcome).not.toBe('COMPLETED');
        }
        expect(
          await sqlExecutor.execute(
            `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE}`
          )
        ).toEqual([]);
        await checkpointMembershipTdhInputs(cycleId);
        await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          checkpointMembershipTdhUniverse(
            cycleId,
            connection,
            async () => undefined,
            { connection }
          )
        );
        await activateMembershipTdhStats(cycleId, (ctx) =>
          sqlExecutor
            .execute(
              `UPDATE ${IDENTITIES_TABLE} SET tdh=60 WHERE profile_id=:profile`,
              { profile },
              membershipQueryOptions(ctx)
            )
            .then(() => undefined)
        );
        await completeMembershipTdhCycle(cycleId);
        expect((await runUntilSettled(groupTarget)).outcome).toBe('COMPLETED');
        expect((await runUntilSettled(fullTarget)).outcome).toBe('COMPLETED');
        expect((await runUntilSettled(profileTarget)).outcome).toBe(
          'COMPLETED'
        );
        expect(await publicationMembers()).toEqual([{ group_id: groupId }]);
        expect(
          await sqlExecutor.oneOrNull<{ run_id: string }>(
            `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
            { profile }
          )
        ).not.toEqual({ run_id: first.run_id });
        expect(
          await membershipTestTx((ctx) =>
            membershipTestTargets().find(profileTarget, ctx)
          )
        ).toMatchObject({ active_run_id: null, last_error: null });
      }
    );
  }
);
