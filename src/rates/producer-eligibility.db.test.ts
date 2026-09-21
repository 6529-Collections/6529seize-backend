import {
  IDENTITIES_TABLE,
  RATINGS_TABLE,
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
import { userGroupsService } from '@/api/community-members/user-groups.service';

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
async function eligibleGroups() {
  return (
    await userGroupsService.getGroupsUserIsEligibleForByIds(
      recipientId,
      allGroups.map(({ id }) => id)
    )
  ).sort((a, b) => a.localeCompare(b));
}

async function repSnapshot() {
  return {
    rep: await sqlExecutor.oneOrNull<{ rep: number }>(
      `SELECT rep FROM ${IDENTITIES_TABLE} WHERE profile_id=:profile`,
      { profile: recipientId }
    ),
    ratings: await sqlExecutor.execute<{ rating: number }>(
      `SELECT rating FROM ${RATINGS_TABLE} WHERE matter=:matter AND matter_target_id=:profile`,
      { matter: RateMatter.REP, profile: recipientId }
    )
  };
}

function prepareBulkCaller() {
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
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await reReviewRatesInXTdhGrantsUseCase.handle({ connection });
    if (failAfterWrite) throw new Error('injected grant rollback');
  });
}

describeWithSeed(
  'ordinary producer writes and direct eligibility after materialisation retirement',
  [withIdentities([rater, recipient]), withUserGroups(allGroups)],
  () => {
    const originalMode = process.env.MEMBERSHIP_SOURCE_TRACKING_MODE;
    beforeEach(() => {
      // A mixed-version rollout may still supply the obsolete control. It must
      // neither block authoritative writes nor create new bookkeeping.
      process.env.MEMBERSHIP_SOURCE_TRACKING_MODE = 'tracking-v1';
      prepareBulkCaller();
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (originalMode === undefined)
        delete process.env.MEMBERSHIP_SOURCE_TRACKING_MODE;
      else process.env.MEMBERSHIP_SOURCE_TRACKING_MODE = originalMode;
      expect(
        await sqlExecutor.execute(
          `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, 11) = 'membership_'`
        )
      ).toEqual([]);
    });

    it('commits bulk REP writes and direct eligibility reflects additions and removals', async () => {
      const repWrite = jest.spyOn(identitiesDb, 'bulkUpdateReps');
      const ratingWrite = jest.spyOn(ratingsDb, 'bulkUpsertRatings');
      await bulkRep(5);
      expect(repWrite).toHaveBeenCalledTimes(1);
      expect(ratingWrite).toHaveBeenCalledTimes(1);
      expect(await repSnapshot()).toMatchObject({
        rep: { rep: 5 },
        ratings: [{ rating: 5 }]
      });
      expect(await eligibleGroups()).toEqual([above.id]);

      await bulkRep(0);
      expect(await repSnapshot()).toMatchObject({
        rep: { rep: 0 },
        ratings: [{ rating: 0 }]
      });
      expect(await eligibleGroups()).toEqual([below.id]);
    });

    it('rolls back both real rating writes when downstream work fails', async () => {
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
        ratings: []
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
        ratings: []
      });
    });

    it('reduces lost-credit ratings and removes direct eligibility', async () => {
      await bulkRep(10);
      expect(await eligibleGroups()).toEqual([above.id, high.id]);
      await sqlExecutor.execute(
        `UPDATE ${IDENTITIES_TABLE} SET tdh=5 WHERE profile_id=:profile`,
        { profile: raterId }
      );
      await ratingsService.reduceOverRates();
      expect(await repSnapshot()).toMatchObject({
        rep: { rep: 5 },
        ratings: [{ rating: 5 }]
      });
      expect(await eligibleGroups()).toEqual([above.id]);
    });

    it('rolls back a lost-credit rating edit when event scheduling fails', async () => {
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
        ratings: [{ rating: 10 }]
      });
    });

    it('commits grant replacement and bulk status updates together', async () => {
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
    });

    it('rolls back grant replacement and status updates after a caller error', async () => {
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
    });
  }
);
