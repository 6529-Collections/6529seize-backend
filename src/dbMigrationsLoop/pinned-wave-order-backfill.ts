import { userGroupsService } from '@/api/community-members/user-groups.service';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { Logger } from '@/logging';
import { Timer } from '@/time';

export const PINNED_WAVE_ORDER_SCHEMA_SCOPE = 'pinned-wave-order-schema';
export const PINNED_WAVE_ORDER_BACKFILL_SCOPE = 'pinned-wave-order-backfill';

const logger = Logger.get('PINNED_WAVE_ORDER_BACKFILL');
const PROFILE_BATCH_SIZE = 20;
const PROFILE_CONCURRENCY = 4;
const BACKFILL_DEADLINE_MS = 12 * 60_000;

async function seedProfile(profileId: string): Promise<void> {
  const timer = new Timer('seedPinnedWaveOrder');
  const eligibleGroups = await userGroupsService.getGroupsUserIsEligibleFor(
    profileId,
    timer
  );
  await wavesApiDb.executeNativeQueriesInTransaction(
    async (connection) => {
      const ctx = { connection, timer };
      if (await wavesApiDb.lockPinnedWaveProfile(profileId, ctx)) {
        await wavesApiDb.initializePinnedWavePositions(
          profileId,
          eligibleGroups,
          ctx
        );
      }
    },
    { isolationLevel: 'READ COMMITTED' }
  );
}

export async function backfillPinnedWaveOrder() {
  const deadline = Date.now() + BACKFILL_DEADLINE_MS;
  let processed = 0;
  while (Date.now() < deadline) {
    const profileIds =
      await wavesApiDb.findProfilesWithUnorderedPins(PROFILE_BATCH_SIZE);
    if (!profileIds.length) {
      logger.info(`Seeded pinned wave positions for ${processed} profiles`);
      return { completed: true, processed };
    }
    for (
      let offset = 0;
      offset < profileIds.length && Date.now() < deadline;
      offset += PROFILE_CONCURRENCY
    ) {
      const batch = profileIds.slice(offset, offset + PROFILE_CONCURRENCY);
      await Promise.all(batch.map(seedProfile));
      processed += batch.length;
    }
  }
  logger.warn(
    `Pinned wave backfill paused after ${processed} profiles. Rerun to seed the remaining profiles.`
  );
  return { completed: false, processed };
}
