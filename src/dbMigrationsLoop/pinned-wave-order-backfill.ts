import { userGroupsService } from '@/api/community-members/user-groups.service';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { Logger } from '@/logging';

export const PINNED_WAVE_ORDER_SCHEMA_SCOPE = 'pinned-wave-order-schema';
export const PINNED_WAVE_ORDER_BACKFILL_SCOPE = 'pinned-wave-order-backfill';

const logger = Logger.get('PINNED_WAVE_ORDER_BACKFILL');
const PROFILE_BATCH_SIZE = 100;
const BACKFILL_DEADLINE_MS = 12 * 60_000;

export async function backfillPinnedWaveOrder(): Promise<number> {
  const deadline = Date.now() + BACKFILL_DEADLINE_MS;
  let after = '';
  let processed = 0;
  while (Date.now() < deadline) {
    const profileIds = await wavesApiDb.findProfilesWithUnorderedPins(
      after,
      PROFILE_BATCH_SIZE
    );
    if (!profileIds.length) {
      logger.info(`Seeded pinned wave positions for ${processed} profiles`);
      return processed;
    }
    for (const profileId of profileIds) {
      if (Date.now() >= deadline) {
        break;
      }
      const eligibleGroups =
        await userGroupsService.getGroupsUserIsEligibleFor(profileId);
      await wavesApiDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
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
      after = profileId;
      processed++;
    }
  }
  throw new Error(
    `Pinned wave backfill paused after ${processed} profiles. Rerun to seed the remaining profiles.`
  );
}
