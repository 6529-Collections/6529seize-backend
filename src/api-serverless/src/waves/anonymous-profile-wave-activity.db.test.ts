import { WavesApiDb } from '@/api/waves/waves.api.db';
import { AuthenticationContext } from '@/auth-context';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  WAVE_DROPPER_METRICS_TABLE
} from '@/constants';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

const waves = ['anonymous-only', 'public-and-anonymous'].map((id, index) =>
  aWave(
    { type: WaveType.RANK, created_by: 'author' },
    { id, name: id, serial_no: index + 1 }
  )
);
const competitions = waves.map((wave) => {
  const record = nativeOriginalPrimaryFixture(wave);
  return {
    ...record,
    participation_config: {
      ...record.participation_config,
      anonymous_submissions: true
    }
  };
});
const drops = [
  {
    id: 'only-anonymous',
    wave_id: waves[0].id,
    created_at: 300,
    drop_type: 'COMPETITION'
  },
  {
    id: 'public-old',
    wave_id: waves[1].id,
    created_at: 100,
    drop_type: 'CHAT'
  },
  {
    id: 'anonymous-new',
    wave_id: waves[1].id,
    created_at: 300,
    drop_type: 'COMPETITION'
  }
].map((drop, index) => ({
  ...drop,
  author_id: 'author',
  serial_no: index + 1,
  parts_count: 1
}));

describeWithSeed(
  'anonymous profile wave activity',
  [
    withWaves(waves),
    { table: COMPETITIONS_TABLE, rows: competitions },
    { table: DROPS_TABLE, rows: drops },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: drops
        .filter((drop) => drop.drop_type === 'COMPETITION')
        .map((drop) => ({
          id: `entry-${drop.id}`,
          competition_id: competitions.find(
            (competition) => competition.wave_id === drop.wave_id
          )!.id,
          wave_id: drop.wave_id,
          drop_id: drop.id,
          submitter_id: 'author',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: drop.created_at
        }))
    },
    {
      table: WAVE_DROPPER_METRICS_TABLE,
      rows: waves.map((wave) => ({
        wave_id: wave.id,
        dropper_id: 'author',
        latest_drop_timestamp: 300,
        drops_count: wave.id === waves[0].id ? 0 : 1,
        participatory_drops_count: 0
      }))
    }
  ],
  () => {
    const db = new WavesApiDb(() => sqlExecutor);
    const request = {
      profileId: 'author',
      eligibleGroups: [],
      limit: 1,
      cursor: null
    };

    it('removes anonymous-only participation and sorts the mixed wave by its last public post', async () => {
      const recent = await db.findRecentProfileWaveActivity(request, {});
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        waveId: waves[1].id,
        latestPostTimestamp: 100
      });
      const created = await db.findCreatedProfileWaveActivity(
        { ...request, limit: 10 },
        {}
      );
      expect(created.find((row) => row.waveId === waves[0].id)).toMatchObject({
        hasQualifyingPost: false,
        latestPostTimestamp: null
      });
      expect(created.find((row) => row.waveId === waves[1].id)).toMatchObject({
        hasQualifyingPost: true,
        latestPostTimestamp: 100
      });
    });

    it('keeps own activity private and reveals only the winning entry contribution', async () => {
      const owner = await db.findRecentProfileWaveActivity(
        { ...request, limit: 10 },
        { authenticationContext: AuthenticationContext.fromProfileId('author') }
      );
      expect(owner).toHaveLength(2);
      expect(owner.every((row) => row.latestPostTimestamp === 300)).toBe(true);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set status='WINNER', won_at=400 where drop_id='anonymous-new'`
      );
      const recent = await db.findRecentProfileWaveActivity(
        { ...request, limit: 10 },
        {}
      );
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        waveId: waves[1].id,
        latestPostTimestamp: 300
      });
    });
  }
);
