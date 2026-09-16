import {
  IDENTITIES_TABLE,
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  RATINGS_TABLE,
  WAVES_TABLE,
  XTDH_GRANTS_TABLE
} from '@/constants';
import { AuthenticationContext } from '@/auth-context';
import { RateMatter } from '@/entities/IRating';
import {
  XTdhGrantEntity,
  XTdhGrantStatus,
  XTdhGrantTokenMode
} from '@/entities/IXTdhGrant';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { ratingsService } from '@/rates/ratings.service';
import { ratingsDb } from '@/rates/ratings.db';
import { identitiesDb } from '@/identities/identities.db';
import { profilesService } from '@/profiles/profiles.service';
import { abusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { eventScheduler } from '@/events/event.scheduler';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { xTdhRepository } from '@/xtdh/xtdh.repository';
import { reReviewRatesInXTdhGrantsUseCase } from '@/xtdh/re-review-rates-in-xtdh-grants.use-case';
import * as producerPolicy from './membership-producer-policy';
import {
  membershipGlobalMutation,
  withMembershipSourceMutation
} from './membership-producer-writes';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipRefreshWorker } from './membership-worker';
import {
  membershipProfileSourceKeys,
  PrimaryMembershipProfileEvaluator
} from './membership-profile-evaluator';
import {
  membershipTestOptions,
  membershipTestTx
} from './membership-worker-test.helpers';

const raterId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000181';
const recipientId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000182';
const raterAddress = '0x0000000000000000000000000000000000000181';
const recipientAddress = '0x0000000000000000000000000000000000000182';
const rater = anIdentity(
  { tdh: 100 },
  {
    profile_id: raterId,
    consolidation_key: raterAddress,
    primary_address: raterAddress,
    handle: 'rate-giver'
  }
);
const recipient = anIdentity(
  { rep: 0 },
  {
    profile_id: recipientId,
    consolidation_key: recipientAddress,
    primary_address: recipientAddress,
    handle: 'rate-target'
  }
);
const below = aUserGroup(
  { rep_max: 0 },
  { id: 'rating-below', name: 'rating-below' }
);
const above = aUserGroup(
  { rep_min: 1 },
  { id: 'rating-above', name: 'rating-above' }
);
const high = aUserGroup(
  { rep_min: 8 },
  { id: 'rating-high', name: 'rating-high' }
);
const allGroups = [below, above, high];
const full = { scope: 'FULL' as const, target_id: '*' };
const target = { scope: 'PROFILE' as const, target_id: recipientId };
const grant: XTdhGrantEntity = {
  id: 'rating-grant-original',
  tokenset_id: null,
  replaced_grant_id: null,
  grantor_id: recipientId,
  target_chain: 1,
  target_contract: '0x0000000000000000000000000000000000000182',
  target_partition: 'test-membership-grant',
  token_mode: XTdhGrantTokenMode.ALL,
  created_at: 1,
  updated_at: 1,
  valid_from: 1,
  valid_to: null,
  rate: 10,
  status: XTdhGrantStatus.GRANTED,
  error_details: null,
  is_irrevocable: false
};
const sources = () => new MembershipSourceStatesDb(() => sqlExecutor);
const targets = () => new MembershipRefreshTargetsDb(() => sqlExecutor);
const worker = () =>
  new MembershipRefreshWorker(
    sqlExecutor,
    new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
  );

async function finish(scope: typeof full | typeof target) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const result = await worker().runTarget(scope, membershipTestOptions());
    if (result.outcome === 'COMPLETED') return result;
    expect(result.outcome).toBe('PENDING');
  }
  throw new Error('Real membership worker did not finish');
}

async function publishedMembers() {
  return sqlExecutor
    .execute<{ group_id: string }>(
      `SELECT m.group_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} p
       JOIN ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} m ON m.run_id=p.run_id
       WHERE p.profile_id=:profile ORDER BY m.group_id`,
      { profile: recipientId }
    )
    .then((rows) => rows.map((row) => row.group_id));
}

async function repSnapshot() {
  return membershipTestTx(async (ctx) => ({
    rep: await sqlExecutor.oneOrNull<{ rep: number }>(
      `SELECT rep FROM ${IDENTITIES_TABLE} WHERE profile_id=:profile`,
      { profile: recipientId }
    ),
    ratings: await sqlExecutor.execute<{ rating: number }>(
      `SELECT rating FROM ${RATINGS_TABLE} WHERE matter=:matter AND matter_target_id=:profile`,
      { matter: RateMatter.REP, profile: recipientId }
    ),
    version: (
      await sources().read(
        [{ scope: 'GLOBAL', target_id: '*', dimension: 'RATINGS' }],
        false,
        ctx
      )
    )[0].state?.version,
    request: await targets().find(full, ctx)
  }));
}

function prepareBulkCaller() {
  jest
    .spyOn(producerPolicy, 'isMembershipSourceTrackingActive')
    .mockReturnValue(true);
  jest
    .spyOn(
      profilesService,
      'makeSureProfilesAreCreatedAndGetProfileIdsByAddresses'
    )
    .mockResolvedValue({ [recipientAddress]: recipientId });
  jest
    .spyOn(abusivenessCheckService, 'bulkCheckRepPhrases')
    .mockResolvedValue(undefined);
  jest
    .spyOn(identitiesDb, 'getTdhAndXTdhCombinedAndFloored')
    .mockResolvedValue(100);
  jest
    .spyOn(eventScheduler, 'scheduleBulkRepRatingChangedEvents')
    .mockResolvedValue(undefined);
  jest
    .spyOn(profileActivityLogsDb, 'bulkInsertProfileActivityLogs')
    .mockResolvedValue(undefined);
}

async function bulkRep(amount: number) {
  await ratingsService.bulkRep(
    { targets: [{ address: recipientAddress, category: 'test-rep', amount }] },
    { authenticationContext: AuthenticationContext.fromProfileId(raterId) }
  );
}

async function reviewGrant(failAfterWrite = false) {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    withMembershipSourceMutation(
      connection,
      membershipGlobalMutation(['GRANTS'], 'grant-re-review'),
      async () => {
        await reReviewRatesInXTdhGrantsUseCase.handle({ connection });
        if (failAfterWrite) throw new Error('injected grant rollback');
      }
    )
  );
}

describeWithSeed(
  'tracked actual rating producer methods with MySQL evaluator and worker',
  [withIdentities([rater, recipient]), withUserGroups(allGroups)],
  () => {
    beforeEach(async () => {
      await membershipTestTx(async (ctx) => {
        await sources().provision(
          membershipProfileSourceKeys(recipientId),
          {
            bootstrap_id: 'actual-producer-methods',
            coverage_revision: 'test-only'
          },
          ctx
        );
      });
      await sqlExecutor.bulkInsert(
        MEMBERSHIP_GROUP_VERSIONS_TABLE,
        allGroups.map(({ id }) => ({
          group_id: id,
          catalog_version: '0',
          is_deleted: false,
          updated_at_millis: '1'
        })),
        ['group_id', 'catalog_version', 'is_deleted', 'updated_at_millis']
      );
      const waves = allGroups.map((group) => {
        const { serial_no: _serial, ...wave } = aWave(
          { visibility_group_id: group.id },
          { id: `wave-${group.id}`, name: group.id }
        );
        return wave;
      });
      await sqlExecutor.bulkInsert(WAVES_TABLE, waves, Object.keys(waves[0]));
      prepareBulkCaller();
    });

    afterEach(() => jest.restoreAllMocks());

    it('commits bulkUpdateReps, bulkUpsertRatings, source version and request before publishing additions and removals', async () => {
      const repWrite = jest.spyOn(identitiesDb, 'bulkUpdateReps');
      const ratingWrite = jest.spyOn(ratingsDb, 'bulkUpsertRatings');
      await bulkRep(5);
      expect(repWrite).toHaveBeenCalledTimes(1);
      expect(ratingWrite).toHaveBeenCalledTimes(1);
      expect(await repSnapshot()).toMatchObject({
        rep: { rep: 5 },
        ratings: [{ rating: 5 }],
        version: '1',
        request: { requested_version: '1' }
      });
      await finish(full);
      await finish(target);
      expect(await publishedMembers()).toEqual([above.id]);

      await bulkRep(0);
      expect(await repSnapshot()).toMatchObject({
        rep: { rep: 0 },
        ratings: [{ rating: 0 }],
        version: '2',
        request: { requested_version: '2' }
      });
      await finish(full);
      await finish(target);
      expect(await publishedMembers()).toEqual([below.id]);
    });

    it('rolls back both real rating writes and source/request when downstream work fails', async () => {
      const actual = ratingsDb.bulkUpsertRatings.bind(ratingsDb);
      jest
        .spyOn(ratingsDb, 'bulkUpsertRatings')
        .mockImplementation(async (ratings, ctx) => {
          await actual(ratings, ctx);
          throw new Error('injected post-write failure');
        });
      await expect(bulkRep(5)).rejects.toThrow('injected post-write failure');
      expect(await repSnapshot()).toMatchObject({
        rep: { rep: 0 },
        ratings: [],
        version: '0',
        request: null
      });
    });

    it('reads pending caller-owned ratings through the same transaction connection', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await sqlExecutor.execute(
            `INSERT INTO ${RATINGS_TABLE}
           (rater_profile_id,matter_target_id,matter,matter_category,rating,last_modified)
           VALUES (:rater,:target,'REP','test-rep',3,CURRENT_TIMESTAMP)`,
            { rater: raterId, target: recipientId },
            { wrappedConnection: connection }
          );
          const pending =
            await ratingsDb.getAllRepRatingsForTargetsAndCategories(
              { targets: [recipientId], categories: ['test-rep'] },
              { connection }
            );
          expect(pending).toMatchObject([{ rating: 3 }]);
          throw new Error('deliberate rollback');
        })
      ).rejects.toThrow('deliberate rollback');
      expect(await repSnapshot()).toMatchObject({
        ratings: [],
        version: '0',
        request: null
      });
    });

    it('reduces lost-credit ratings through insertLostCreditRating and republishes the removed membership', async () => {
      await bulkRep(10);
      await finish(full);
      await finish(target);
      expect(await publishedMembers()).toEqual([above.id, high.id]);
      await sqlExecutor.execute(
        `UPDATE ${IDENTITIES_TABLE} SET tdh=5 WHERE profile_id=:profile`,
        { profile: raterId }
      );
      await ratingsService.reduceOverRates();
      expect(await repSnapshot()).toMatchObject({
        rep: { rep: 5 },
        ratings: [{ rating: 5 }],
        version: '2',
        request: { requested_version: '2' }
      });
      await finish(full);
      await finish(target);
      expect(await publishedMembers()).toEqual([above.id]);
    });

    it('rolls a lost-credit rating edit back with its source and request when event scheduling fails', async () => {
      await bulkRep(10);
      await sqlExecutor.execute(
        `UPDATE ${IDENTITIES_TABLE} SET tdh=5 WHERE profile_id=:profile`,
        { profile: raterId }
      );
      jest
        .spyOn(eventScheduler, 'scheduleRepRatingChangedEvent')
        .mockRejectedValue(new Error('injected event failure'));
      await expect(ratingsService.reduceOverRates()).rejects.toThrow(
        'injected event failure'
      );
      expect(await repSnapshot()).toMatchObject({
        rep: { rep: 10 },
        ratings: [{ rating: 10 }],
        version: '1',
        request: { requested_version: '1' }
      });
    });

    it('tracks the real grant re-review caller and bulkUpdateStatus in the same commit', async () => {
      await sqlExecutor.bulkInsert(
        XTDH_GRANTS_TABLE,
        [grant],
        Object.keys(grant)
      );
      jest
        .spyOn(xTdhRepository, 'getOverflowedGrantsWithGrantorRates')
        .mockResolvedValue([{ ...grant, grantor_x_tdh_rate: 5 }]);
      const statusUpdate = jest.spyOn(xTdhRepository, 'bulkUpdateStatus');
      await reviewGrant();
      expect(statusUpdate).toHaveBeenCalledTimes(1);
      const rows = await sqlExecutor.execute<{
        id: string;
        status: string;
        replaced_grant_id: string | null;
      }>(
        `SELECT id,status,replaced_grant_id FROM ${XTDH_GRANTS_TABLE} ORDER BY id`
      );
      expect(rows.find((row) => row.id === grant.id)?.status).toBe(
        XTdhGrantStatus.DISABLED
      );
      expect(rows.some((row) => row.replaced_grant_id === grant.id)).toBe(true);
      const state = await membershipTestTx(async (ctx) => ({
        version: (
          await sources().read(
            [{ scope: 'GLOBAL', target_id: '*', dimension: 'GRANTS' }],
            false,
            ctx
          )
        )[0].state?.version,
        request: await targets().find(full, ctx)
      }));
      expect(state).toMatchObject({
        version: '1',
        request: { requested_version: '1' }
      });
    });

    it('rolls back grant replacement, bulkUpdateStatus, source and request after a caller error', async () => {
      await sqlExecutor.bulkInsert(
        XTDH_GRANTS_TABLE,
        [grant],
        Object.keys(grant)
      );
      jest
        .spyOn(xTdhRepository, 'getOverflowedGrantsWithGrantorRates')
        .mockResolvedValue([{ ...grant, grantor_x_tdh_rate: 5 }]);
      await expect(reviewGrant(true)).rejects.toThrow(
        'injected grant rollback'
      );
      expect(
        await sqlExecutor.execute<{ id: string; status: string }>(
          `SELECT id,status FROM ${XTDH_GRANTS_TABLE}`
        )
      ).toEqual([{ id: grant.id, status: XTdhGrantStatus.GRANTED }]);
      const state = await membershipTestTx(async (ctx) => ({
        version: (
          await sources().read(
            [{ scope: 'GLOBAL', target_id: '*', dimension: 'GRANTS' }],
            false,
            ctx
          )
        )[0].state?.version,
        request: await targets().find(full, ctx)
      }));
      expect(state).toEqual({ version: '0', request: null });
    });
  }
);
