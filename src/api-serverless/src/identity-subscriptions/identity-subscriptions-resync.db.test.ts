import 'reflect-metadata';
import { IDENTITY_SUBSCRIPTIONS_TABLE, WAVE_METRICS_TABLE } from '@/constants';
import { identitiesService } from '@/api/identities/identities.service';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { identityConsolidationEffects, ProfileIdGenerator } from '@/identity';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  fixturePrimaryAddress,
  identityMetricsSyncSeeds,
  readWaveSubscriberCounts
} from '@/tests/fixtures/identity-metrics-sync.fixture';

const tryLockWaveMetrics = (waveId: string) =>
  sqlExecutor.execute(
    `select wave_id from ${WAVE_METRICS_TABLE} where wave_id = :waveId for update nowait`,
    { waveId }
  );

async function fullResyncCounts(): Promise<Record<string, number>> {
  const rows = await sqlExecutor.execute<{ wave_id: string; n: number }>(
    `select target_id as wave_id, count(distinct subscriber_id) as n
     from ${IDENTITY_SUBSCRIPTIONS_TABLE}
     where target_type = 'WAVE' and target_action = 'DROP_CREATED'
     group by 1`
  );
  return Object.fromEntries(rows.map((row) => [row.wave_id, Number(row.n)]));
}

describeWithSeed(
  'wave subscriber recount after a profile merge',
  identityMetricsSyncSeeds(),
  () => {
    beforeEach(() => {
      let generated = 0;
      jest
        .spyOn(ProfileIdGenerator.prototype, 'generate')
        .mockImplementation(() => `generated-${++generated}`);
      jest
        .spyOn(identitiesService, 'determinePrimaryAddress')
        .mockImplementation(fixturePrimaryAddress);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("recounts the merged profiles' waves as a full resync would, and leaves other waves unlocked", async () => {
      // Drift on a wave the merge does not touch.
      await sqlExecutor.execute(
        `update ${WAVE_METRICS_TABLE} set subscribers_count = 99 where wave_id = 'wave-other'`
      );

      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await identityConsolidationEffects.syncIdentitiesWithTdhConsolidations(
            connection
          );
          // Still inside the merge transaction.
          await expect(tryLockWaveMetrics('wave-other')).resolves.toHaveLength(
            1
          );
          await expect(tryLockWaveMetrics('wave-both')).rejects.toMatchObject({
            errno: 3572 // ER_LOCK_NOWAIT
          });
        }
      );

      const full = await fullResyncCounts();
      expect(full['wave-both']).toBe(2);
      expect(await readWaveSubscriberCounts()).toEqual([
        { wave_id: 'wave-bob', subscribers_count: full['wave-bob'] },
        { wave_id: 'wave-both', subscribers_count: full['wave-both'] },
        { wave_id: 'wave-other', subscribers_count: 99 }
      ]);
    });

    it('recounts only the listed waves, in chunks', async () => {
      await sqlExecutor.execute(
        `update ${WAVE_METRICS_TABLE} set subscribers_count = 50`
      );
      const unknownWaves = Array.from(
        { length: 450 },
        (_, i) => `unknown-wave-${i}`
      );

      await identitySubscriptionsDb.resyncWaveSubscriptionsMetrics([]);
      await identitySubscriptionsDb.resyncWaveSubscriptionsMetrics([
        ...unknownWaves,
        'wave-both',
        'wave-other'
      ]);

      expect(await readWaveSubscriberCounts()).toEqual([
        { wave_id: 'wave-bob', subscribers_count: 50 },
        { wave_id: 'wave-both', subscribers_count: 3 },
        { wave_id: 'wave-other', subscribers_count: 2 }
      ]);
    });

    it('finds the waves any of the given identities follows', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const waves = await identitySubscriptionsDb.findFollowedWaveIds(
            ['bobPID', 'maryPID', 'nobody'],
            connection
          );
          expect([...waves].sort((a, b) => a.localeCompare(b))).toEqual([
            'wave-bob',
            'wave-both'
          ]);
          expect(
            await identitySubscriptionsDb.findFollowedWaveIds([], connection)
          ).toEqual([]);
        }
      );
    });
  }
);
