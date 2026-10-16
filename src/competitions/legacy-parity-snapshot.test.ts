import { loadLegacyParityCandidate } from '@/competitions/legacy-parity-snapshot';
import { CompetitionRowLimitError } from '@/competitions/competition-page';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import type {
  Competition,
  CompetitionReader,
  CompetitionRoutingRecord,
  CompetitionPageRequest
} from '@/competitions/competition.types';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { CompetitionStorageMode } from '@/entities/ICompetition';

function fixture() {
  const voters = Array.from({ length: 10_005 }, (_, index) => ({
    profile_id: `profile-${index}`,
    votes: 0,
    credit_spent: 0
  }));
  const listVoters = jest.fn(async (_record, page: CompetitionPageRequest) => ({
    data: voters.slice(page.offset, page.offset + page.limit),
    next_cursor: null,
    has_more: page.offset + page.limit < voters.length
  }));
  const empty = async () => ({ data: [], next_cursor: null, has_more: false });
  const competition = {
    storage_mode: CompetitionStorageMode.NATIVE,
    voting: { credit_scope: WaveCreditScope.WAVE },
    capabilities: []
  } as unknown as Competition;
  const reader = {
    getCompetition: async () => competition,
    listVoters,
    listEntries: empty,
    listLeaderboard: empty,
    listDecisions: empty,
    listOutcomes: empty,
    listDistribution: empty,
    listPauses: empty
  } as unknown as CompetitionReader;
  const record = {
    id: 'comparison',
    wave_id: 'wave'
  } as CompetitionRoutingRecord;
  const budgets = jest
    .spyOn(competitionCreditService, 'getWaveBudgets')
    .mockImplementation(
      async (_competition, ids) =>
        new Map(
          ids.map((profile_id) => [
            profile_id,
            {
              competition_id: record.id,
              profile_id,
              entry_id: null,
              credit_type: WaveCreditType.TDH,
              credit_scope: WaveCreditScope.WAVE,
              available: 0,
              spent: 0,
              remaining: 0,
              current_vote: null,
              min_vote: null,
              max_vote: null
            }
          ])
        )
    );
  return { reader, record, listVoters, budgets };
}

afterEach(() => jest.restoreAllMocks());

it('collects every voter beyond 10,000 using bounded full-comparison pages', async () => {
  const { reader, record, listVoters } = fixture();
  const result = await loadLegacyParityCandidate(
    reader,
    record,
    0,
    {},
    Infinity
  );
  expect(result.votes_and_credits).toHaveLength(10_005);
  expect(result.credit_budgets).toHaveLength(10_005);
  expect(listVoters.mock.calls.map(([, page]) => page.offset)).toEqual([
    0, 2000, 4000, 6000, 8000, 10000
  ]);
  expect(listVoters.mock.calls.every(([, page]) => page.limit === 2000)).toBe(
    true
  );
});

it('retains the shadow sample row ceiling and original reader page size', async () => {
  const { reader, record, listVoters, budgets } = fixture();
  await expect(
    loadLegacyParityCandidate(reader, record, 0, {})
  ).rejects.toBeInstanceOf(CompetitionRowLimitError);
  expect(listVoters.mock.calls.every(([, page]) => page.limit === 500)).toBe(
    true
  );
  expect(budgets).not.toHaveBeenCalled();
});
