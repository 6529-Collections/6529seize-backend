import 'reflect-metadata';
import { WAVES_TABLE, WAVES_DECISIONS_TABLE } from '@/constants';
import { WaveCreditType, WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WavesApiDb } from '@/api/waves/waves.api.db';

const now = 10000;
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
  vote('orphan', { parent_wave_id: 'missing' })
];

describeWithSeed('active TDH voting discovery', withWaves(waves), () => {
  it('uses voting lifecycle and deadline order, not recent chat or reputation', async () => {
    const result = await repo.findActiveTdhVotingWaves(
      { eligibleGroups: [], now, limit: 50, offset: 0 },
      {}
    );
    expect(result.waves.map((wave) => wave.id)).toEqual([
      'closing',
      'recurring',
      'a-open',
      'b-combined',
      'c-card'
    ]);
    expect(result.count).toBe(5);
  });

  it('applies parent visibility to both count and pagination', async () => {
    const result = await repo.findActiveTdhVotingWaves(
      { eligibleGroups: ['members'], now, limit: 2, offset: 2 },
      {}
    );
    expect(result.waves.map((wave) => wave.id)).toEqual([
      'a-open',
      'b-combined'
    ]);
    expect(result.count).toBe(7);
    const empty = await repo.findActiveTdhVotingWaves(
      { eligibleGroups: [], now, limit: 2, offset: 20 },
      {}
    );
    expect(empty.waves).toEqual([]);
    expect(empty.count).toBe(5);
  });

  it('removes approval voting when its final winner is recorded', async () => {
    await sqlExecutor.execute(
      `update ${WAVES_TABLE} set max_winners = 1 where id = :id`,
      { id: 'a-open' }
    );
    const params = { eligibleGroups: [], now, limit: 50, offset: 0 };
    expect(
      (await repo.findActiveTdhVotingWaves(params, {})).waves.map(
        (wave) => wave.id
      )
    ).toContain('a-open');
    await sqlExecutor.execute(
      `insert into ${WAVES_DECISIONS_TABLE} (wave_id, decision_time) values (:id, :now)`,
      { id: 'a-open', now }
    );
    const result = await repo.findActiveTdhVotingWaves(params, {});
    expect(result.waves.map((wave) => wave.id)).not.toContain('a-open');
    expect(result.count).toBe(4);
  });

  it('includes a vote exactly at its start and removes it at its end', async () => {
    const before = await repo.findActiveTdhVotingWaves(
      { eligibleGroups: [], now: now + 1, limit: 50, offset: 0 },
      {}
    );
    expect(before.waves.map((wave) => wave.id)).toContain('future');
    const after = await repo.findActiveTdhVotingWaves(
      { eligibleGroups: [], now: 12000, limit: 50, offset: 0 },
      {}
    );
    expect(after.waves.map((wave) => wave.id)).not.toContain('closing');
    expect(after.waves.map((wave) => wave.id)).not.toContain('recurring');
  });
});
