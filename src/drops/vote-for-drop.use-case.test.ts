jest.mock('@/competitions/competition.repository', () => ({
  competitionRepository: { lockOriginalPrimary: jest.fn() }
}));
jest.mock('@/competitions/legacy-competition-vote.service', () => ({
  voteForMigratedLegacyEntry: jest.fn()
}));
import { VoteForDropUseCase } from './vote-for-drop.use-case';
import { competitionRepository } from '@/competitions/competition.repository';
import { voteForMigratedLegacyEntry } from '@/competitions/legacy-competition-vote.service';

const service = new VoteForDropUseCase(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never
);
const model = {
  voter_id: 'voter',
  drop_id: 'drop',
  wave_id: 'wave',
  votes: 42,
  proxy_id: 'proxy'
};
const ctx = { connection: {} as never };

beforeEach(() => jest.resetAllMocks());

it('dispatches the permanent old vote command to its immutable native primary with proxy attribution', async () => {
  const record = { id: 'original-primary' };
  jest
    .mocked(competitionRepository.lockOriginalPrimary)
    .mockResolvedValue(record as never);
  jest.mocked(voteForMigratedLegacyEntry).mockResolvedValue(true);
  await expect(service.execute(model, ctx)).resolves.toBe(true);
  expect(voteForMigratedLegacyEntry).toHaveBeenCalledWith(record, model, ctx);
});

it.each([null])(
  'does not write retired vote storage for %j',
  async (record) => {
    jest
      .mocked(competitionRepository.lockOriginalPrimary)
      .mockResolvedValue(record as never);
    await expect(service.execute(model, ctx)).rejects.toThrow(
      'This drop does not belong to a competition'
    );
    expect(voteForMigratedLegacyEntry).not.toHaveBeenCalled();
  }
);
