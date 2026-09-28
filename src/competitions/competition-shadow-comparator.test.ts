import { CompetitionShadowComparator } from '@/competitions/competition-shadow-comparator';
import { CompetitionRowLimitError } from '@/competitions/competition-page';
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
  const connection = { connection: {} };
  const repository = {
    recordParityObservation: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(async (work) => work(connection))
  };
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

  beforeEach(() => {
    jest.clearAllMocks();
    repository.recordParityObservation.mockReset();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    {
      sourceSha: 'a'.repeat(40),
      commit: 'b'.repeat(40),
      expected: 'a'.repeat(40)
    },
    { sourceSha: undefined, commit: 'b'.repeat(40), expected: 'b'.repeat(40) },
    { sourceSha: undefined, commit: undefined, expected: 'local' }
  ])(
    'records the deployed source version: $expected',
    async ({ sourceSha, commit, expected }) => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        GIT_COMMIT_SHA: sourceSha,
        GIT_COMMIT: commit
      });
      const comparator = new CompetitionShadowComparator(
        repository as never,
        features as never,
        logger
      );
      await comparator.compare(record, snapshot, snapshot, {});
      expect(
        repository.recordParityObservation.mock.calls[0][0].sourceVersion
      ).toBe(`legacy-read-v2:${expected}`);
    }
  );

  it('uses one snapshot connection and timestamp for independent readers', async () => {
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValue(2_000);
    features.isLegacyCompetitionShadowCompareEnabled.mockReturnValue(true);
    features.getLegacyCompetitionShadowSampleRate.mockReturnValue(1);
    const baseline = jest.fn().mockResolvedValue(snapshot);
    const candidate = jest.fn().mockResolvedValue(snapshot);
    const comparator = new CompetitionShadowComparator(
      repository as never,
      features as never,
      logger,
      () => 0
    );
    await expect(
      comparator.compareIfSampled(record, baseline, candidate, {})
    ).resolves.toBe(true);
    expect(baseline.mock.calls[0]).toEqual(candidate.mock.calls[0]);
    expect(baseline.mock.calls[0][1]).toBe(1_000);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(baseline.mock.calls[0][0].connection).toBe(connection);
    expect(repository.executeNativeQueriesInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      {
        isolationLevel: 'REPEATABLE READ',
        executionBudget: {
          deadlineMonotonicMillis: expect.any(Number),
          maxStatementMillis: 500,
          finalizationReserveMillis: 250,
          lockWaitSeconds: 1
        }
      }
    );
    expect(
      repository.recordParityObservation.mock.calls.some(
        ([row]) => row.category === CompetitionParityCategory.CREDIT_AVAILABLE
      )
    ).toBe(false);
    expect(
      repository.recordParityObservation.mock.calls[0][0].sourceVersion
    ).toMatch(/^legacy-read-v2:/);
  });

  it.each(['baseline', 'candidate', 'persistence', 'transaction'])(
    'isolates %s failures without logging private error payloads',
    async (failure) => {
      features.isLegacyCompetitionShadowCompareEnabled.mockReturnValue(true);
      features.getLegacyCompetitionShadowSampleRate.mockReturnValue(1);
      const baseline = jest.fn().mockResolvedValue(snapshot);
      const candidate = jest.fn().mockResolvedValue(snapshot);
      const error = new Error('private SQL signature payload');
      if (failure === 'baseline') baseline.mockRejectedValue(error);
      if (failure === 'candidate') candidate.mockRejectedValue(error);
      if (failure === 'persistence')
        repository.recordParityObservation.mockRejectedValue(error);
      if (failure === 'transaction')
        repository.executeNativeQueriesInTransaction.mockRejectedValueOnce(
          error
        );
      const comparator = new CompetitionShadowComparator(
        repository as never,
        features as never,
        logger,
        () => 0
      );
      await expect(
        comparator.compareIfSampled(record, baseline, candidate, {})
      ).resolves.toBe(false);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
        error.message
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('reason=sample_failed')
      );
      if (failure !== 'persistence')
        expect(repository.recordParityObservation).not.toHaveBeenCalled();
      if (failure === 'transaction') {
        expect(baseline).not.toHaveBeenCalled();
        expect(candidate).not.toHaveBeenCalled();
        await expect(
          comparator.compareIfSampled(record, baseline, candidate, {})
        ).resolves.toBe(true);
      }
    }
  );

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

  it('reports oversized samples without logging their source data', async () => {
    features.isLegacyCompetitionShadowCompareEnabled.mockReturnValue(true);
    features.getLegacyCompetitionShadowSampleRate.mockReturnValue(1);
    const comparator = new CompetitionShadowComparator(
      repository as never,
      features as never,
      logger
    );
    await expect(
      comparator.compareIfSampled(
        record,
        async () => {
          throw new CompetitionRowLimitError();
        },
        async () => snapshot,
        {}
      )
    ).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/outcome=skipped reason=row_limit duration_ms=\d+/)
    );
  });

  it('allows only one sample at a time and releases capacity after completion', async () => {
    features.isLegacyCompetitionShadowCompareEnabled.mockReturnValue(true);
    features.getLegacyCompetitionShadowSampleRate.mockReturnValue(1);
    let release!: (value: CompetitionSnapshot) => void;
    const pending = new Promise<CompetitionSnapshot>((resolve) => {
      release = resolve;
    });
    const baseline = jest.fn().mockReturnValue(pending);
    const candidate = jest.fn().mockResolvedValue(snapshot);
    const comparator = new CompetitionShadowComparator(
      repository as never,
      features as never,
      logger,
      () => 0
    );
    const first = comparator.compareIfSampled(record, baseline, candidate, {});
    await expect(
      comparator.compareIfSampled(record, baseline, candidate, {})
    ).resolves.toBe(false);
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('outcome=skipped reason=in_flight')
    );
    release(snapshot);
    await expect(first).resolves.toBe(true);
    await expect(
      comparator.compareIfSampled(record, baseline, candidate, {})
    ).resolves.toBe(true);
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
