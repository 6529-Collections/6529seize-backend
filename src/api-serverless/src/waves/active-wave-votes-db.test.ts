import 'reflect-metadata';
import {
  COMPETITIONS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  withLegacyCompetitionGetFacade,
  withoutLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { DropType } from '@/entities/IDrop';
import { WaveCreditType, WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WavesApiDb } from '@/api/waves/waves.api.db';

const now = 10000;
const publicRead = { eligibleGroups: [], mainStageWaveId: null, now };
const repo = new WavesApiDb(() => sqlExecutor);
const vote = (id: string, props: Parameters<typeof aWave>[0] = {}) =>
  aWave({ type: WaveType.APPROVE, ...props }, { id, name: id });
const strategy = {
  first_decision_time: 9000,
  subsequent_decisions: [2000],
  is_rolling: true
};
const waves = [
  vote('closing', { voting_period_end: 11000 }),
  vote('recurring', {
    type: WaveType.RANK,
    decisions_strategy: strategy,
    next_decision_time: 12000
  }),
  vote('a-open'),
  vote('b-combined', { voting_credit_type: WaveCreditType.TDH_PLUS_XTDH }),
  vote('c-card', { voting_credit_type: WaveCreditType.CARD_SET_TDH }),
  vote('private', { visibility_group_id: 'members' }),
  vote('child', { parent_wave_id: 'private' }),
  vote('future', { voting_period_start: now + 1 }),
  vote('ended', { voting_period_end: now }),
  vote('pending', { next_decision_time: now - 1 }),
  vote('completed-rank', { type: WaveType.RANK, decisions_strategy: strategy }),
  vote('completed-approve', { max_winners: 0 }),
  vote('chat', { type: WaveType.CHAT }),
  vote('rep', { voting_credit_type: WaveCreditType.REP }),
  vote('xtdh', { voting_credit_type: WaveCreditType.XTDH }),
  vote('dm', { is_direct_message: true }),
  vote('dm-child', { parent_wave_id: 'dm' }),
  vote('restricted-dm', {
    is_direct_message: true,
    visibility_group_id: 'members'
  }),
  vote('restricted-dm-child', { parent_wave_id: 'restricted-dm' }),
  vote('orphan', { parent_wave_id: 'missing' })
];

async function seedDrop(
  id: string,
  waveId: string,
  dropType: DropType,
  status?: CompetitionEntryStatus
) {
  await sqlExecutor.execute(
    `insert into ${DROPS_TABLE} (id,wave_id,author_id,drop_type,created_at,parts_count)
     values (:id,:waveId,'author',:dropType,:now,1)`,
    { id, waveId, dropType, now }
  );
  if (status) {
    const competitionId = legacyCompetitionId(waveId);
    await sqlExecutor.execute(
      `insert into ${COMPETITION_ENTRIES_TABLE}
         (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at)
       values (:entryId,:competitionId,:waveId,:id,'author',:status,1,:now)`,
      {
        entryId: legacyCompetitionEntryId(competitionId, id),
        competitionId,
        waveId,
        id,
        status,
        now
      }
    );
  }
}

describeWithSeed('active TDH voting discovery', withWaves(waves), () => {
  beforeEach(async () => {
    for (const wave of waves.filter((wave) => wave.type !== WaveType.CHAT))
      await seedNativeOriginalPrimaryFixture(wave);
    expect(
      await sqlExecutor.execute(
        'select COLUMN_NAME from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME=:table and COLUMN_NAME in (:columns)',
        {
          table: WAVES_TABLE,
          columns: [
            'voting_period_end',
            'voting_credit_type',
            'next_decision_time',
            'max_winners'
          ]
        }
      )
    ).toEqual([]);
  });

  it('applies active voting eligibility and treats missing REP as zero', async () => {
    const result = await repo.findActiveTdhVotingWaves(
      { ...publicRead, limit: 50, offset: 0 },
      {}
    );
    expect(result.waves.map((wave) => wave.id)).toEqual([
      'a-open',
      'b-combined',
      'c-card',
      'closing',
      'recurring'
    ]);
    expect(result.count).toBe(5);
  });

  it('applies parent visibility to both count and pagination', async () => {
    const result = await repo.findActiveTdhVotingWaves(
      { ...publicRead, eligibleGroups: ['members'], limit: 2, offset: 2 },
      {}
    );
    expect(result.waves.map((wave) => wave.id)).toEqual(['c-card', 'child']);
    expect(result.count).toBe(7);
    const empty = await repo.findActiveTdhVotingWaves(
      { ...publicRead, limit: 2, offset: 20 },
      {}
    );
    expect(empty.waves).toEqual([]);
    expect(empty.count).toBe(5);
  });

  it.each([{ eligibleGroups: [] }, { eligibleGroups: ['members'] }])(
    'returns every counted non-DM wave for visibility groups %j',
    async ({ eligibleGroups }) => {
      const result = await repo.findActiveTdhVotingWaves(
        { ...publicRead, eligibleGroups, limit: 50, offset: 0 },
        {}
      );
      expect(result.waves).toHaveLength(result.count);
      expect(result.waves.map((wave) => wave.id)).not.toContain('orphan');
      for (const id of [
        'dm',
        'dm-child',
        'restricted-dm',
        'restricted-dm-child'
      ]) {
        expect(result.waves.map((wave) => wave.id)).not.toContain(id);
      }
      if (eligibleGroups.length) {
        expect(result.waves.map((wave) => wave.id)).toEqual(
          expect.arrayContaining(['private', 'child'])
        );
      }
    }
  );

  it('pins Main Stage before paging, then uses raw REP with a stable ID tie-break', async () => {
    await sqlExecutor.execute(
      `insert into ${WAVE_METRICS_TABLE} (wave_id, wave_rep_total, wave_rep_sort_score)
       values ('recurring', -100, 10), ('a-open', 300, 1), ('b-combined', 300, 100),
         ('closing', -7, 90), ('private', 900, 99)`
    );
    const read = (offset: number, mainStageWaveId = 'recurring') =>
      repo.findActiveTdhVotingWaves(
        { ...publicRead, mainStageWaveId, limit: 2, offset },
        {}
      );
    const pages = await Promise.all([read(0), read(2), read(4)]);
    expect(pages.map((page) => page.count)).toEqual([5, 5, 5]);
    expect(pages.map((page) => page.waves.map((wave) => wave.id))).toEqual([
      ['recurring', 'a-open'],
      ['b-combined', 'c-card'],
      ['closing']
    ]);

    const highRepPin = await Promise.all(
      [0, 2, 4].map((offset) => read(offset, 'b-combined'))
    );
    expect(
      highRepPin.flatMap(({ waves }) => waves.map((wave) => wave.id))
    ).toEqual(['b-combined', 'a-open', 'c-card', 'closing', 'recurring']);

    for (const excludedWaveId of ['private', 'dm']) {
      const publicOnly = await read(0, excludedWaveId);
      expect(publicOnly.count).toBe(5);
      expect(publicOnly.waves.map((wave) => wave.id)).toEqual([
        'a-open',
        'b-combined'
      ]);
    }
  });

  it.each([
    { facade: 'enabled', run: withLegacyCompetitionGetFacade },
    { facade: 'disabled', run: withoutLegacyCompetitionGetFacade }
  ])(
    'counts active approval submissions on paged results (facade $facade)',
    async ({ run }) => {
      await seedDrop(
        'closed-winner',
        'closing',
        DropType.PARTICIPATORY,
        CompetitionEntryStatus.WINNER
      );
      await seedDrop('chat-only', 'closing', DropType.CHAT);
      await seedDrop(
        'native-proposal',
        'a-open',
        DropType.COMPETITION,
        CompetitionEntryStatus.ACTIVE
      );
      await seedDrop('stored-proposal', 'a-open', DropType.PARTICIPATORY);
      await seedDrop(
        'mapped-stored-proposal',
        'a-open',
        DropType.PARTICIPATORY,
        CompetitionEntryStatus.ACTIVE
      );
      await seedDrop(
        'rank-proposal',
        'recurring',
        DropType.COMPETITION,
        CompetitionEntryStatus.ACTIVE
      );
      await seedDrop(
        'withdrawn-proposal',
        'b-combined',
        DropType.PARTICIPATORY,
        CompetitionEntryStatus.WITHDRAWN
      );
      await seedDrop(
        'disqualified-proposal',
        'c-card',
        DropType.COMPETITION,
        CompetitionEntryStatus.DISQUALIFIED
      );

      const page = (offset: number) =>
        run(() =>
          repo.findActiveTdhVotingWaves({ ...publicRead, limit: 2, offset }, {})
        );
      const [first, second, third] = await Promise.all([
        page(0),
        page(2),
        page(4)
      ]);
      expect([first.count, second.count, third.count]).toEqual([5, 5, 5]);
      expect(
        [first, second, third].flatMap((result) =>
          result.waves.map((wave) => [wave.id, wave.activeSubmissionCount])
        )
      ).toEqual([
        ['a-open', 3],
        ['b-combined', 0],
        ['c-card', 0],
        ['closing', 0],
        ['recurring', undefined]
      ]);
    }
  );

  it('removes approval voting when its final winner is recorded', async () => {
    await sqlExecutor.execute(
      `update ${COMPETITIONS_TABLE} set decision_config=json_set(decision_config,'$.max_winners',1),winner_config=json_set(winner_config,'$.max_winners',1) where legacy_wave_id=:id`,
      { id: 'a-open' }
    );
    const params = { ...publicRead, limit: 50, offset: 0 };
    expect(
      (await repo.findActiveTdhVotingWaves(params, {})).waves.map(
        (wave) => wave.id
      )
    ).toContain('a-open');
    await sqlExecutor.execute(
      `insert into ${COMPETITION_DECISIONS_TABLE} (id,competition_id,scheduled_at,decided_at,status,execution_key,created_at) values ('final-decision',:id,:now,:now,'COMPLETED','final-decision',:now)`,
      { id: legacyCompetitionId('a-open'), now }
    );
    const result = await repo.findActiveTdhVotingWaves(params, {});
    expect(result.waves.map((wave) => wave.id)).not.toContain('a-open');
    expect(result.count).toBe(4);
  });

  it('includes a vote exactly at its start and removes it at its end', async () => {
    const before = await repo.findActiveTdhVotingWaves(
      { ...publicRead, now: now + 1, limit: 50, offset: 0 },
      {}
    );
    expect(before.waves.map((wave) => wave.id)).toContain('future');
    const after = await repo.findActiveTdhVotingWaves(
      { ...publicRead, now: 12000, limit: 50, offset: 0 },
      {}
    );
    expect(after.waves.map((wave) => wave.id)).not.toContain('closing');
    expect(after.waves.map((wave) => wave.id)).not.toContain('recurring');
  });
});
