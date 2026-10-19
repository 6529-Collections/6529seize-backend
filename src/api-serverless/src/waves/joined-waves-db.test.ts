import 'reflect-metadata';
import {
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_READER_METRICS_TABLE
} from '@/constants';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { withLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import { WavesApiDb } from './waves.api.db';

const profileId = 'joined-reader';
const waves = [
  aWave({}, { id: 'joined-public', serial_no: 1, name: 'Public' }),
  aWave({}, { id: 'joined-muted', serial_no: 2, name: 'Muted' }),
  aWave({}, { id: 'joined-no-metrics', serial_no: 3, name: 'No metrics' }),
  aWave({}, { id: 'joined-parent', serial_no: 4, name: 'Parent' }),
  aWave(
    { parent_wave_id: 'joined-parent' },
    { id: 'joined-child', serial_no: 5, name: 'Child' }
  ),
  aWave(
    { parent_wave_id: 'joined-parent', visibility_group_id: 'private-group' },
    { id: 'joined-private-child', serial_no: 6, name: 'Private child' }
  ),
  aWave(
    { visibility_group_id: 'private-group' },
    { id: 'joined-private', serial_no: 7, name: 'Private' }
  ),
  aWave(
    { is_direct_message: true },
    { id: 'joined-dm', serial_no: 8, name: 'DM' }
  ),
  aWave({}, { id: 'unjoined-public', serial_no: 9, name: 'Not joined' })
];
const repo = new WavesApiDb(() => sqlExecutor);
const params = { identityId: profileId, eligibleGroups: [] as string[] };

describeWithSeed(
  'Joined root wave snapshot IDs',
  [
    withWaves(waves),
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: waves
        .filter(
          (wave) => wave.id !== 'joined-parent' && wave.id !== 'unjoined-public'
        )
        .map((wave) => ({
          subscriber_id: profileId,
          target_id: wave.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED
        }))
    },
    {
      table: WAVE_METRICS_TABLE,
      rows: [
        { wave_id: 'joined-public', latest_drop_timestamp: 100 },
        { wave_id: 'joined-muted', latest_drop_timestamp: 1000 },
        { wave_id: 'joined-child', latest_drop_timestamp: 600 },
        { wave_id: 'joined-private-child', latest_drop_timestamp: 900 },
        { wave_id: 'joined-private', latest_drop_timestamp: 800 },
        { wave_id: 'joined-dm', latest_drop_timestamp: 5000 }
      ]
    },
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: [{ wave_id: 'joined-muted', reader_id: profileId, muted: true }]
    }
  ],
  () => {
    it.each([false, true])(
      'preserves membership, activity, and access in both read scopes (facade=%s)',
      async (facade) => {
        const getIds = () => repo.findJoinedRootWaveIds(params, {});
        const ids = await (facade
          ? withLegacyCompetitionGetFacade(getIds)
          : getIds());
        expect(ids).toEqual([
          'joined-parent',
          'joined-public',
          'joined-no-metrics',
          'joined-muted'
        ]);
      }
    );

    it('rechecks private root and subwave visibility when groups change', async () => {
      const ids = await repo.findJoinedRootWaveIds(
        { ...params, eligibleGroups: ['private-group'] },
        {}
      );
      expect(ids.slice(0, 3)).toEqual([
        'joined-parent',
        'joined-private',
        'joined-public'
      ]);
      expect(ids).not.toContain('joined-child');
      expect(ids).not.toContain('joined-dm');
    });

    it('checks only the candidate IDs and stops returning roots after an unfollow', async () => {
      const waveIds = ['joined-public', 'unjoined-public', 'joined-dm'];
      expect(
        await repo.findJoinedRootWaveIds({ ...params, waveIds }, {})
      ).toEqual(['joined-public']);
      await sqlExecutor.execute(
        `delete from ${IDENTITY_SUBSCRIPTIONS_TABLE} where subscriber_id = :profileId and target_id = :waveId`,
        { profileId, waveId: 'joined-public' }
      );
      expect(
        await repo.findJoinedRootWaveIds({ ...params, waveIds }, {})
      ).toEqual([]);
    });
  }
);
