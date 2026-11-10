import 'reflect-metadata';
import { RATINGS_TABLE } from '@/constants';
import { AuthenticationContext } from '@/auth-context';
import { RateMatter } from '@/entities/IRating';
import { eventScheduler } from '@/events/event.scheduler';
import { metricsRecorder } from '@/metrics/MetricsRecorder';
import { userNotifier } from '@/notifications/user.notifier';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { ratingsDb } from '@/rates/ratings.db';
import { ratingsService } from '@/rates/ratings.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { Time } from '@/time';

const raterId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301';
const firstTargetId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000302';
const secondTargetId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000303';

function identity(profileId: string, address: string, tdh: number) {
  return anIdentity(
    { tdh },
    {
      profile_id: profileId,
      consolidation_key: address,
      primary_address: address,
      handle: `handle-${address.slice(-3)}`
    }
  );
}

function rate(targetId: string, rating: number) {
  return ratingsService.updateRating(
    {
      rater_profile_id: raterId,
      matter_target_id: targetId,
      matter: RateMatter.REP,
      matter_category: 'Art',
      rating,
      authenticationContext: AuthenticationContext.fromProfileId(raterId)
    },
    {}
  );
}

async function creditSpent(): Promise<number> {
  const [row] = await sqlExecutor.execute<{ spent: number | null }>(
    `select sum(abs(rating)) as spent from ${RATINGS_TABLE}
     where rater_profile_id = :raterId and matter = 'REP'`,
    { raterId }
  );
  return Number(row?.spent ?? 0);
}

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) {
    await Time.millis(50).sleep();
  }
  expect(condition()).toBe(true);
}

describeWithSeed(
  'rater credit lock',
  withIdentities([
    identity(raterId, '0x0000000000000000000000000000000000000301', 100),
    identity(firstTargetId, '0x0000000000000000000000000000000000000302', 0),
    identity(secondTargetId, '0x0000000000000000000000000000000000000303', 0)
  ]),
  () => {
    beforeEach(() => {
      jest
        .spyOn(eventScheduler, 'scheduleRepRatingChangedEvent')
        .mockResolvedValue(undefined);
      jest
        .spyOn(userNotifier, 'notifyOfIdentityRep')
        .mockResolvedValue(undefined);
      jest
        .spyOn(metricsRecorder, 'recordActiveIdentity')
        .mockResolvedValue(undefined);
      jest.spyOn(profileActivityLogsDb, 'insert').mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('lets one of two concurrent ratings of one rater on different targets spend the credit', async () => {
      // Hold the first rating open after its credit check; the second must
      // wait for it instead of reading the same spent credit.
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const updateRating = ratingsDb.updateRating.bind(ratingsDb);
      let updates = 0;
      jest
        .spyOn(ratingsDb, 'updateRating')
        .mockImplementation(async (...args) => {
          updates++;
          if (updates === 1) await firstHeld;
          return updateRating(...args);
        });
      const getRating = jest.spyOn(ratingsDb, 'getRating');

      const first = rate(firstTargetId, 60);
      await waitFor(() => updates === 1);
      const second = rate(secondTargetId, 60);
      await Time.millis(500).sleep();
      expect(getRating).toHaveBeenCalledTimes(1);
      releaseFirst();

      const results = await Promise.allSettled([first, second]);
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'rejected'
      ]);
      expect((results[1] as PromiseRejectedResult).reason.message).toMatch(
        /^Not enough credit left to spend on this matter/
      );
      expect(await creditSpent()).toBe(60);
    });

    it('lets two raters, and one rater on two matters, hold their locks at once', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(async (first) => {
        await ratingsDb.lockRaterCreditOnMatter(
          { rater_profile_id: raterId, matter: RateMatter.REP },
          first
        );
        // Taking it again in the same transaction does not wait.
        await ratingsDb.lockRaterCreditOnMatter(
          { rater_profile_id: raterId, matter: RateMatter.REP },
          first
        );
        await sqlExecutor.executeNativeQueriesInTransaction(async (second) => {
          await ratingsDb.lockRaterCreditOnMatter(
            { rater_profile_id: firstTargetId, matter: RateMatter.REP },
            second
          );
          await ratingsDb.lockRaterCreditOnMatter(
            { rater_profile_id: raterId, matter: RateMatter.CIC },
            second
          );
        });
      });
    });
  }
);
