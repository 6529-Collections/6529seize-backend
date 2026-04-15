import 'reflect-metadata';
import { WAVE_DROPPER_METRICS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WavesApiDb } from './waves.api.db';

const repo = new WavesApiDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };

const author = anIdentity(
  {},
  {
    consolidation_key: 'identity-wave-author',
    profile_id: 'profile-wave-author',
    primary_address: 'wallet-wave-author',
    handle: 'wave-author'
  }
);

const publicWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-public', serial_no: 1, name: 'Public Wave' }
);

const privateWave = aWave(
  {
    created_by: author.profile_id!,
    visibility_group_id: 'visibility-group',
    admin_group_id: 'admin-group'
  },
  { id: 'wave-private', serial_no: 2, name: 'Private Wave' }
);

describeWithSeed(
  'WavesApiDb read visibility',
  [
    withIdentities([author]),
    withWaves([publicWave, privateWave]),
    {
      table: WAVE_DROPPER_METRICS_TABLE,
      rows: [
        {
          wave_id: publicWave.id,
          dropper_id: author.profile_id!,
          drops_count: 1,
          participatory_drops_count: 0,
          latest_drop_timestamp: 1001
        },
        {
          wave_id: privateWave.id,
          dropper_id: author.profile_id!,
          drops_count: 2,
          participatory_drops_count: 0,
          latest_drop_timestamp: 1002
        }
      ]
    }
  ],
  () => {
    it('does not read private waves through admin-group-only eligibility by ids', async () => {
      const adminOnlyResults = await repo.findWavesByIdsEligibleForRead(
        [publicWave.id, privateWave.id],
        ['admin-group'],
        undefined
      );
      expect(adminOnlyResults.map((wave) => wave.id)).toEqual([publicWave.id]);

      const visibilityResults = await repo.findWavesByIdsEligibleForRead(
        [publicWave.id, privateWave.id],
        ['visibility-group'],
        undefined
      );
      expect(visibilityResults.map((wave) => wave.id).sort()).toEqual([
        privateWave.id,
        publicWave.id
      ]);
    });

    it('does not search private waves through admin-group-only eligibility', async () => {
      const baseParams = {
        limit: 10,
        direct_message: false
      };

      await expect(
        repo.searchWaves(baseParams, ['admin-group'], ctx)
      ).resolves.toEqual([expect.objectContaining({ id: publicWave.id })]);
      await expect(
        repo.searchWaves(baseParams, ['visibility-group'], ctx)
      ).resolves.toEqual([
        expect.objectContaining({ id: privateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);
    });

    it('does not return favorite private waves through admin-group-only eligibility', async () => {
      await expect(
        repo.findFavouriteWavesOfIdentity(
          {
            identityId: author.profile_id!,
            eligibleGroups: ['admin-group'],
            limit: 10,
            offset: 0
          },
          ctx
        )
      ).resolves.toEqual([expect.objectContaining({ id: publicWave.id })]);
      await expect(
        repo.findFavouriteWavesOfIdentity(
          {
            identityId: author.profile_id!,
            eligibleGroups: ['visibility-group'],
            limit: 10,
            offset: 0
          },
          ctx
        )
      ).resolves.toEqual([
        expect.objectContaining({ id: privateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);
    });
  }
);
