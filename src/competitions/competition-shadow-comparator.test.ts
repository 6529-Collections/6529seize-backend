import { CompetitionShadowComparator } from '@/competitions/competition-shadow-comparator';
import {
  CompetitionExecutionMode,
  CompetitionParityCategory,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { CompetitionSnapshot } from '@/competitions/competition.types';

const snapshot: CompetitionSnapshot = {
  storage_mode: CompetitionStorageMode.LEGACY_ADAPTER,
  config_version: 1,
  configuration: {
    secret_signature: 'never-log-this',
    title: 'A',
    storage_mode: CompetitionStorageMode.LEGACY_ADAPTER,
    config_version: 1
  },
  entries: [{ id: 'entry-a', status: 'ACTIVE' }],
  votes_and_credits: [{ voter: 'profile-a', votes: 3, credit: 3 }],
  leaderboard: [{ id: 'entry-a', rank: 1 }],
  decisions_and_winners: [{ id: 'decision-a', winners: ['entry-a'] }],
  outcomes_and_distributions: [{ id: 'outcome-a', distribution: [] }],
  pauses: [],
  capabilities: ['MAIN_STAGE']
};

describe('CompetitionShadowComparator', () => {
  const repository = { recordParityObservation: jest.fn() };
  const features = {
    isLegacyCompetitionShadowCompareEnabled: jest.fn(),
    getLegacyCompetitionShadowSampleRate: jest.fn()
  };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const record = {
    id: 'competition-a',
    wave_id: 'wave-a',
    legacy_wave_id: 'wave-a',
    storage_mode: CompetitionStorageMode.LEGACY_ADAPTER,
    execution_mode: CompetitionExecutionMode.ACTIVE
  };

  beforeEach(() => jest.clearAllMocks());

  it('does no work while either safe sampling gate is off', async () => {
    features.isLegacyCompetitionShadowCompareEnabled.mockReturnValue(false);
    features.getLegacyCompetitionShadowSampleRate.mockReturnValue(1);
    const baseline = jest.fn();
    const candidate = jest.fn();
    const comparator = new CompetitionShadowComparator(
      repository as never,
      features as never,
      logger as never,
      () => 0
    );
    await expect(
      comparator.compareIfSampled(record, baseline, candidate, {})
    ).resolves.toBe(false);
    expect(baseline).not.toHaveBeenCalled();
    expect(candidate).not.toHaveBeenCalled();
  });

  it('records all approved parity categories as hashes without payload logs', async () => {
    const comparator = new CompetitionShadowComparator(
      repository as never,
      features as never,
      logger as never,
      () => 0
    );
    await comparator.compare(
      record,
      snapshot,
      { ...snapshot, leaderboard: [{ id: 'entry-a', rank: 2 }] },
      {}
    );

    const observations = repository.recordParityObservation.mock.calls.map(
      ([observation]) => observation
    );
    expect(observations.map((item) => item.category)).toEqual(
      expect.arrayContaining([
        CompetitionParityCategory.CONFIG_FIELD,
        CompetitionParityCategory.ENTRY_MEMBERSHIP,
        CompetitionParityCategory.ENTRY_STATUS,
        CompetitionParityCategory.CREDIT_AVAILABLE,
        CompetitionParityCategory.CREDIT_SPEND,
        CompetitionParityCategory.VOTE_TOTAL,
        CompetitionParityCategory.LEADERBOARD_ORDER,
        CompetitionParityCategory.LEADERBOARD_FIELD,
        CompetitionParityCategory.DECISION_DUE_SET,
        CompetitionParityCategory.WINNER_SET_OR_ORDER,
        CompetitionParityCategory.OUTCOME_OR_DISTRIBUTION,
        CompetitionParityCategory.PAUSE_HANDLING,
        CompetitionParityCategory.CLAIM_OR_MINT_ELIGIBILITY
      ])
    );
    expect(
      observations.find(
        (item) => item.category === CompetitionParityCategory.LEADERBOARD_ORDER
      )?.matched
    ).toBe(false);
    expect(observations[0]).toMatchObject({
      baselineStorageMode: CompetitionStorageMode.LEGACY_ADAPTER,
      candidateStorageMode: CompetitionStorageMode.LEGACY_ADAPTER,
      baselineConfigVersion: 1,
      candidateConfigVersion: 1
    });
    const logged = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls
    ]);
    expect(logged).not.toContain('never-log-this');
    expect(logged).not.toContain('secret_signature');
  });
});
