import { CompetitionCursorCodec } from '@/competitions/competition-cursor';
import { CompetitionService } from '@/competitions/competition.service';
import {
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';
import { WaveType } from '@/entities/IWave';
import { NotFoundException } from '@/exceptions';
import { aWave } from '@/tests/fixtures/wave.fixture';

function nativeRecord(id: string, waveId: string, createdAt: number) {
  return {
    id,
    wave_id: waveId,
    legacy_wave_id: null,
    storage_mode: CompetitionStorageMode.NATIVE,
    execution_mode: CompetitionExecutionMode.DISABLED,
    type: CompetitionType.RANK,
    lifecycle: CompetitionLifecycle.PUBLISHED,
    title: id,
    description: null,
    participation_config: {
      group_id: null,
      signature_required: false,
      max_entries_per_participant: null,
      required_metadata: [],
      required_media: [],
      submission_type: null,
      identity_submission_strategy: null,
      identity_submission_duplicates: null,
      starts_at: null,
      ends_at: null,
      terms: null
    },
    voting_config: {
      group_id: null,
      credit_type: 'TDH',
      credit_scope: 'WAVE',
      credit_category: null,
      credit_creditor: null,
      credit_nfts: [],
      signature_required: false,
      starts_at: null,
      ends_at: null,
      max_votes_per_identity_to_entry: null,
      forbid_negative_votes: false
    },
    decision_config: {
      strategy: null,
      next_decision_time: null,
      winning_min_threshold: null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0,
      max_winners: null,
      time_lock_ms: null
    },
    winner_config: {
      max_winners: null,
      winning_min_threshold: null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0
    },
    outcome_config: [],
    config_version: 1,
    participation_starts_at: null,
    participation_ends_at: null,
    voting_starts_at: null,
    voting_ends_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    published_at: createdAt,
    ended_at: null,
    cancelled_at: null,
    archived_at: null
  };
}

describe('CompetitionService', () => {
  const wave = aWave(
    { type: WaveType.CHAT },
    { id: 'wave-a', name: 'Hub A', serial_no: 1 }
  );
  const first = nativeRecord(
    '00000000-0000-4000-8000-000000000001',
    wave.id,
    10
  );
  const second = nativeRecord(
    '00000000-0000-4000-8000-000000000002',
    wave.id,
    20
  );
  const repository = {
    listCompetitionRecordsForWave: jest.fn(),
    findCompetitionRecordById: jest.fn(),
    parseCompetitionRecord: jest.fn((record) => record),
    findCapabilities: jest.fn().mockResolvedValue([]),
    findNativeEntry: jest.fn(),
    listNativeVoters: jest.fn(),
    listNativeOutcomes: jest.fn(),
    listNativeDistribution: jest.fn()
  };
  const wavesDb = { findWaveById: jest.fn() };
  const groupsService = { getGroupsUserIsEligibleFor: jest.fn() };
  const features = {
    isUnifiedCompetitionReadsEnabled: jest.fn(),
    isNativeCompetitionWritesEnabled: jest.fn()
  };
  const service = new CompetitionService(
    repository as never,
    wavesDb as never,
    groupsService as never,
    features as never,
    new CompetitionCursorCodec()
  );

  beforeEach(() => {
    jest.clearAllMocks();
    features.isUnifiedCompetitionReadsEnabled.mockReturnValue(true);
    features.isNativeCompetitionWritesEnabled.mockReturnValue(false);
    wavesDb.findWaveById.mockResolvedValue(wave);
    groupsService.getGroupsUserIsEligibleFor.mockResolvedValue([]);
    repository.listCompetitionRecordsForWave.mockResolvedValue([first, second]);
    repository.findCompetitionRecordById.mockImplementation(async (id) =>
      [first, second].find((record) => record.id === id)
    );
    repository.listNativeOutcomes.mockResolvedValue({
      data: [],
      has_more: false,
      next_cursor: null
    });
    repository.listNativeDistribution.mockResolvedValue({
      data: [],
      has_more: false,
      next_cursor: null
    });
    repository.findNativeEntry.mockResolvedValue(null);
    repository.listNativeVoters.mockResolvedValue({
      data: [],
      has_more: false,
      next_cursor: null
    });
  });

  it('returns zero/one/many resources without a current competition projection', async () => {
    const page = await service.listCompetitions(
      wave.id,
      { limit: 1, direction: 'ASC', sort: 'created_at' },
      {}
    );
    expect(page.data.map((competition) => competition.id)).toEqual([first.id]);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).not.toBeNull();
    expect(page.data[0]).not.toHaveProperty('storage_mode');
    expect(page.data[0]).not.toHaveProperty('execution_mode');
    expect(page.data[0]).not.toHaveProperty('current');

    const next = await service.listCompetitions(
      wave.id,
      {
        limit: 1,
        direction: 'ASC',
        sort: 'created_at',
        cursor: page.next_cursor!
      },
      {}
    );
    expect(next.data.map((competition) => competition.id)).toEqual([second.id]);
    expect(next.has_more).toBe(false);
  });

  it('keeps entry and vote permissions false for anonymous readers', async () => {
    const competition = await service.getCompetition(wave.id, first.id, {});
    expect(competition.permissions).toMatchObject({
      view: true,
      submit: false,
      vote: false,
      administer: false
    });
  });

  it('keeps native submit and vote permissions false while writes are disabled', async () => {
    const authenticationContext = {
      isUserFullyAuthenticated: () => true,
      isAuthenticatedAsProxy: () => false,
      getActingAsId: () => 'profile-viewer'
    };
    const competition = await service.getCompetition(wave.id, first.id, {
      authenticationContext
    } as never);
    expect(competition.permissions).toMatchObject({
      view: true,
      submit: false,
      vote: false
    });
  });

  it('masks private waves before looking up a competition', async () => {
    wavesDb.findWaveById.mockResolvedValue({
      ...wave,
      visibility_group_id: 'private-group'
    });
    await expect(
      service.getCompetition(wave.id, first.id, {})
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findCompetitionRecordById).not.toHaveBeenCalled();
  });

  it('masks competition IDs that belong to another wave', async () => {
    repository.findCompetitionRecordById.mockResolvedValue({
      ...first,
      wave_id: 'wave-b'
    });
    await expect(
      service.getCompetition(wave.id, first.id, {})
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('masks voter filters for entries outside the requested competition', async () => {
    const otherCompetitionEntryId = '20000000-0000-4000-8000-000000000001';

    await expect(
      service.listVoters(
        wave.id,
        first.id,
        { limit: 50, direction: 'DESC' },
        otherCompetitionEntryId,
        {}
      )
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.findNativeEntry).toHaveBeenCalledWith(
      first.id,
      otherCompetitionEntryId,
      expect.any(Object)
    );
    expect(repository.listNativeVoters).not.toHaveBeenCalled();
  });

  it('validates distribution ownership beyond the first internal outcome page', async () => {
    const outcomes = Array.from({ length: 501 }, (_, index) => ({
      id: index === 500 ? 'outcome-late' : `outcome-${index}`
    }));
    repository.listNativeOutcomes.mockImplementation(
      async (
        _competitionId: string,
        request: { readonly offset: number; readonly limit: number }
      ) => {
        const data = outcomes.slice(
          request.offset,
          request.offset + request.limit
        );
        return {
          data,
          has_more: request.offset + data.length < outcomes.length,
          next_cursor: null
        };
      }
    );

    await expect(
      service.listDistribution(
        wave.id,
        first.id,
        'outcome-late',
        { limit: 50, direction: 'ASC' },
        {}
      )
    ).resolves.toEqual({ data: [], has_more: false, next_cursor: null });
    expect(repository.listNativeOutcomes).toHaveBeenCalledTimes(2);
  });

  it('exposes no v3 data while the unified-read kill switch is off', async () => {
    features.isUnifiedCompetitionReadsEnabled.mockReturnValue(false);
    await expect(service.getHub(wave.id, {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(wavesDb.findWaveById).not.toHaveBeenCalled();
  });
});
