import 'reflect-metadata';
import { PROFILE_WAVES_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { ProfileWavesDb } from './profile-waves.db';

const repo = new ProfileWavesDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };

describeWithSeed(
  'ProfileWavesDb set and delete',
  [
    withWaves([
      aWave(
        { created_by: 'profile-1' },
        { id: 'wave-1', serial_no: 1, name: 'Wave 1' }
      ),
      aWave(
        { created_by: 'profile-1' },
        { id: 'wave-2', serial_no: 2, name: 'Wave 2' }
      )
    ]),
    {
      table: PROFILE_WAVES_TABLE,
      rows: [{ profile_id: 'profile-1', wave_id: 'wave-1' }]
    }
  ],
  () => {
    it('replaces an existing explicit profile wave and updates reverse lookup', async () => {
      await repo.setProfileWave(
        {
          profileId: 'profile-1',
          waveId: 'wave-2'
        },
        ctx
      );

      await expect(repo.findByProfileId('profile-1')).resolves.toEqual({
        profile_id: 'profile-1',
        wave_id: 'wave-2'
      });
      await expect(repo.findByWaveId('wave-2', ctx)).resolves.toEqual({
        profile_id: 'profile-1',
        wave_id: 'wave-2'
      });
      await expect(
        repo.findSelectedWaveIdsByWaveIds(['wave-1', 'wave-2'], ctx)
      ).resolves.toEqual(new Set(['wave-2']));
    });

    it('clears explicit profile wave by wave id', async () => {
      await repo.deleteByWaveId('wave-1', ctx);

      await expect(repo.findByProfileId('profile-1')).resolves.toBeNull();
    });
  }
);

describeWithSeed(
  'ProfileWavesDb mergeOnProfileIdChange',
  {
    table: PROFILE_WAVES_TABLE,
    rows: [{ profile_id: 'profile-1', wave_id: 'wave-1' }]
  },
  () => {
    it('is a no-op when source and target profile ids are the same', async () => {
      await repo.mergeOnProfileIdChange(
        {
          previous_id: 'profile-1',
          new_id: 'profile-1'
        },
        ctx
      );

      await expect(repo.findByProfileId('profile-1')).resolves.toEqual({
        profile_id: 'profile-1',
        wave_id: 'wave-1'
      });
    });

    it('moves the source selection when target has no selection', async () => {
      await repo.mergeOnProfileIdChange(
        {
          previous_id: 'profile-1',
          new_id: 'profile-2'
        },
        ctx
      );

      await expect(repo.findByProfileId('profile-1')).resolves.toBeNull();
      await expect(repo.findByProfileId('profile-2')).resolves.toEqual({
        profile_id: 'profile-2',
        wave_id: 'wave-1'
      });
    });
  }
);

describeWithSeed(
  'ProfileWavesDb mergeOnProfileIdChange keeps target',
  {
    table: PROFILE_WAVES_TABLE,
    rows: [
      { profile_id: 'profile-1', wave_id: 'wave-1' },
      { profile_id: 'profile-2', wave_id: 'wave-2' }
    ]
  },
  () => {
    it('keeps the target selection and removes the source selection', async () => {
      await repo.mergeOnProfileIdChange(
        {
          previous_id: 'profile-1',
          new_id: 'profile-2'
        },
        ctx
      );

      await expect(repo.findByProfileId('profile-1')).resolves.toBeNull();
      await expect(repo.findByProfileId('profile-2')).resolves.toEqual({
        profile_id: 'profile-2',
        wave_id: 'wave-2'
      });
    });
  }
);
