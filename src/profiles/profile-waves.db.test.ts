import 'reflect-metadata';
import { PROFILE_WAVES_TABLE, WAVE_CURATIONS_TABLE } from '@/constants';
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
          waveId: 'wave-2',
          profileCurationId: null
        },
        ctx
      );

      await expect(repo.findByProfileId('profile-1')).resolves.toEqual({
        profile_id: 'profile-1',
        wave_id: 'wave-2',
        profile_curation_id: null
      });
      await expect(repo.findByWaveId('wave-2', ctx)).resolves.toEqual({
        profile_id: 'profile-1',
        wave_id: 'wave-2',
        profile_curation_id: null
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
        wave_id: 'wave-1',
        profile_curation_id: null
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
        wave_id: 'wave-1',
        profile_curation_id: null
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
        wave_id: 'wave-2',
        profile_curation_id: null
      });
    });
  }
);

describeWithSeed(
  'ProfileWavesDb profile curation choice',
  [
    {
      table: PROFILE_WAVES_TABLE,
      rows: [
        {
          profile_id: 'profile-1',
          wave_id: 'wave-1',
          profile_curation_id: 'curation-2'
        }
      ]
    },
    {
      table: WAVE_CURATIONS_TABLE,
      rows: [
        {
          id: 'curation-1',
          name: 'Oldest',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          created_at: 1,
          updated_at: 1,
          priority_order: 2
        },
        {
          id: 'curation-2',
          name: 'Selected',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          created_at: 2,
          updated_at: 2,
          priority_order: 1
        },
        {
          id: 'curation-3',
          name: 'Other',
          wave_id: 'wave-2',
          community_group_id: 'community-group-1',
          created_at: 1,
          updated_at: 1,
          priority_order: 1
        }
      ]
    }
  ],
  () => {
    it('returns the explicit profile curation when it exists in the profile wave', async () => {
      await expect(
        repo.findEffectiveProfileWaveByProfileId('profile-1', ctx)
      ).resolves.toEqual({
        profile_wave_id: 'wave-1',
        profile_curation_id: 'curation-2'
      });
    });

    it('clears explicit profile curation by deleted curation id', async () => {
      await repo.clearProfileCurationByCurationId('curation-2', ctx);

      await expect(repo.findByProfileId('profile-1')).resolves.toEqual({
        profile_id: 'profile-1',
        wave_id: 'wave-1',
        profile_curation_id: null
      });
    });

    it('clears profile curation when changing profile wave without a new curation', async () => {
      await repo.setProfileWave(
        {
          profileId: 'profile-1',
          waveId: 'wave-2',
          profileCurationId: null
        },
        ctx
      );

      await expect(repo.findByProfileId('profile-1')).resolves.toEqual({
        profile_id: 'profile-1',
        wave_id: 'wave-2',
        profile_curation_id: null
      });
    });
  }
);

describeWithSeed(
  'ProfileWavesDb profile curation fallback',
  [
    {
      table: PROFILE_WAVES_TABLE,
      rows: [{ profile_id: 'profile-1', wave_id: 'wave-1' }]
    },
    {
      table: WAVE_CURATIONS_TABLE,
      rows: [
        {
          id: 'curation-2',
          name: 'Newer',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          created_at: 2,
          updated_at: 2,
          priority_order: 1
        },
        {
          id: 'curation-1',
          name: 'Oldest',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          created_at: 1,
          updated_at: 1,
          priority_order: 2
        }
      ]
    }
  ],
  () => {
    it('falls back to the oldest curation when no explicit curation is stored', async () => {
      await expect(
        repo.findEffectiveProfileWaveByProfileId('profile-1', ctx)
      ).resolves.toEqual({
        profile_wave_id: 'wave-1',
        profile_curation_id: 'curation-1'
      });
    });
  }
);

describeWithSeed(
  'ProfileWavesDb profile curation fallback with no curations',
  {
    table: PROFILE_WAVES_TABLE,
    rows: [{ profile_id: 'profile-1', wave_id: 'wave-1' }]
  },
  () => {
    it('returns null profile curation when the profile wave has no curations', async () => {
      await expect(
        repo.findEffectiveProfileWaveByProfileId('profile-1', ctx)
      ).resolves.toEqual({
        profile_wave_id: 'wave-1',
        profile_curation_id: null
      });
    });
  }
);
