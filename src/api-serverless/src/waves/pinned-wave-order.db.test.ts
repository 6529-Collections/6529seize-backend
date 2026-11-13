import 'reflect-metadata';
import {
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PINNED_WAVES_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_READER_METRICS_TABLE
} from '@/constants';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WavesApiDb } from './waves.api.db';

const profileId = 'pin-order-profile';
const profile = aProfile({
  external_id: profileId,
  handle: 'pin-order',
  primary_wallet: 'wallet-pin-order'
});
const [parent, active, muted, quiet, firstNew, secondNew] = [
  'pin-parent',
  'pin-active',
  'pin-muted',
  'pin-quiet',
  'pin-new-one',
  'pin-new-two'
];
const child = 'pin-child';
const original = [parent, active, quiet, muted];
const repo = new WavesApiDb(() => sqlExecutor);

describeWithSeed(
  'saved pinned wave order',
  [
    withProfiles([profile]),
    withWaves([
      ...[...original, firstNew, secondNew].map((id) =>
        aWave({ created_by: profileId }, { id, name: id })
      ),
      aWave(
        { created_by: profileId, parent_wave_id: parent },
        { id: child, name: child }
      )
    ]),
    {
      table: PINNED_WAVES_TABLE,
      rows: original.map((wave_id) => ({ profile_id: profileId, wave_id }))
    },
    {
      table: WAVE_METRICS_TABLE,
      rows: [
        { wave_id: active, latest_drop_timestamp: 100 },
        { wave_id: child, latest_drop_timestamp: 200 },
        { wave_id: muted, latest_drop_timestamp: 300 }
      ]
    },
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: [{ wave_id: muted, reader_id: profileId, muted: true }]
    },
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [
        {
          subscriber_id: profileId,
          target_id: child,
          wave_id: child,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          subscribed_to_all_drops: false
        }
      ]
    }
  ],
  () => {
    const transaction = <T>(
      run: Parameters<typeof repo.executeNativeQueriesInTransaction<T>>[0]
    ) =>
      repo.executeNativeQueriesInTransaction(run, {
        isolationLevel: 'READ COMMITTED'
      });
    const list = () => repo.findPinnedWavePositions(profileId, {});
    const pin = (waveId: string) =>
      transaction((connection) =>
        repo.insertPin(
          { waveId, profileId, eligibleGroups: [] },
          { connection }
        )
      );

    it('seeds with followed subwave activity and muted waves last, then preserves saved positions', async () => {
      await pin(firstNew);
      expect((await list()).map((pin) => pin.wave_id)).toEqual([
        ...original,
        firstNew
      ]);

      await transaction(async (connection) => {
        const ctx = { connection };
        await repo.lockPinnedWaveProfile(profileId, ctx);
        await repo.updatePinnedWavePositions(
          profileId,
          [
            { wave_id: muted, position: 1 },
            { wave_id: parent, position: 4 }
          ],
          ctx
        );
      });
      await pin(muted);
      expect((await list()).map((pin) => pin.wave_id)).toEqual([
        muted,
        active,
        quiet,
        parent,
        firstNew
      ]);

      await transaction((connection) =>
        repo.deletePin({ waveId: muted, profileId }, { connection })
      );
      await pin(muted);
      expect((await list()).map((pin) => pin.wave_id)).toEqual([
        active,
        quiet,
        parent,
        firstNew,
        muted
      ]);
    });

    it('assigns distinct positions to concurrent new pins', async () => {
      await Promise.all([pin(firstNew), pin(secondNew)]);
      const saved = await list();
      expect(saved.map((pin) => pin.position)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(saved.slice(0, 4).map((pin) => pin.wave_id)).toEqual(original);
      expect(
        saved
          .slice(4)
          .map((pin) => pin.wave_id)
          .sort((a, b) => a.localeCompare(b))
      ).toEqual([firstNew, secondNew]);
    });
  }
);
