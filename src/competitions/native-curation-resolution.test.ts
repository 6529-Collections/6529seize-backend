import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { CompetitionCapability } from '@/entities/ICompetition';

function fixture() {
  const competition = {
    id: 'curation',
    wave_id: 'hub',
    storage_mode: 'NATIVE',
    execution_mode: 'ACTIVE',
    lifecycle: 'PUBLISHED',
    capabilities: [CompetitionCapability.CURATION],
    config_version: 1,
    decisions: {
      time_lock_ms: 1000,
      winning_min_threshold: null,
      next_decision_time: null
    },
    outcome_config: [],
    legacy_origin: true
  };
  let active = [
    {
      id: 'entry-a',
      competition_id: 'curation',
      drop_id: 'drop-a',
      submitted_at: 0
    },
    {
      id: 'entry-b',
      competition_id: 'curation',
      drop_id: 'drop-b',
      submitted_at: 0
    }
  ];
  const repository = {
    lockCompetition: jest.fn(async () => competition),
    listActiveEntries: jest.fn(async () => active),
    listHistory: jest.fn(async () =>
      active.flatMap((entry) => [
        {
          kind: 'AGGREGATE',
          entry_id: entry.id,
          voter_profile_id: '',
          aggregate_value: 90,
          value: 90,
          occurred_at: 0,
          sequence: 1
        },
        {
          kind: 'VOTER',
          entry_id: entry.id,
          voter_profile_id: 'voter',
          aggregate_value: 0,
          value: 7,
          occurred_at: 0,
          sequence: 1
        }
      ])
    ),
    listPauses: jest.fn(async () => []),
    saveDecision: jest.fn(async (params) => {
      active = active.filter(
        (entry) =>
          !params.winners.some(
            (winner: { entry_id: string }) => winner.entry_id === entry.id
          )
      );
      return 'decision';
    }),
    saveLeaderboard: jest.fn(),
    enqueueEvent: jest.fn()
  };
  const router = {
    isNativeExecutionAllowed: (value: typeof competition) =>
      value.execution_mode === 'ACTIVE'
  };
  const service = new NativeCompetitionRuntimeService(
    repository as never,
    {} as never,
    router as never
  );
  return { service, repository, competition };
}

it('retains independent aggregate scoring and frozen individual voter scoring for curation sales', async () => {
  const { service, repository } = fixture();
  await expect(
    service.resolveCurationEntries('curation', ['drop-a'], 1000, 'sale-a', {
      connection: {} as never
    })
  ).resolves.toBe(true);
  const decision = repository.saveDecision.mock.calls[0][0];
  expect(decision.winners).toEqual([
    expect.objectContaining({ entry_id: 'entry-a', rank: 1, final_rating: 90 })
  ]);
  expect(
    decision.finalVote(decision.voterPoints.get('entry-a').get('voter'))
  ).toBe(7);
  expect(decision.decisionKey).toBe('sale-a');
});

it('resolves separate transfers in the same millisecond and makes a repeated transfer harmless', async () => {
  const { service, repository } = fixture();
  const ctx = { connection: {} as never };
  await service.resolveCurationEntries(
    'curation',
    ['drop-a'],
    1000,
    'sale-a',
    ctx
  );
  await service.resolveCurationEntries(
    'curation',
    ['drop-b'],
    1000,
    'sale-b',
    ctx
  );
  await service.resolveCurationEntries(
    'curation',
    ['drop-a'],
    1000,
    'sale-a',
    ctx
  );
  expect(repository.saveDecision).toHaveBeenCalledTimes(2);
  expect(
    repository.saveDecision.mock.calls.map(([params]) => [
      params.scheduledAt,
      params.decisionKey
    ])
  ).toEqual([
    [1000, 'sale-a'],
    [1000, 'sale-b']
  ]);
});

it.each(['DISABLED', 'SHADOW'])(
  'keeps %s curation watches pending without applying winner effects',
  async (executionMode) => {
    const { service, repository, competition } = fixture();
    competition.execution_mode = executionMode;
    await expect(
      service.resolveCurationEntries('curation', ['drop-a'], 1000, 'sale-a', {
        connection: {} as never
      })
    ).resolves.toBe(false);
    expect(repository.saveDecision).not.toHaveBeenCalled();
    expect(repository.listHistory).not.toHaveBeenCalled();
  }
);
