import { competitionMainStageRepository } from '@/competitions/competition-main-stage.repository';
import { CompetitionCapability } from '@/entities/ICompetition';
import { freezeMemeCollaborationForNativeDecision } from './meme-collaboration-mint-selection';
import { memeCollaborationsService } from './meme-collaborations.service';

const decision = {
  competition: {
    id: 'main-stage',
    capabilities: [CompetitionCapability.MAIN_STAGE]
  },
  winners: [
    { rank: 2, drop_id: 'second' },
    { rank: 1, drop_id: 'next-mint' }
  ],
  skipped: false
};
const ctx = { connection: { connection: {} } };

beforeEach(() => {
  jest
    .spyOn(competitionMainStageRepository, 'isDesignated')
    .mockResolvedValue(true);
  jest
    .spyOn(memeCollaborationsService, 'freezeForMint')
    .mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());

it('freezes only the first-ranked artwork using the decision transaction', async () => {
  await freezeMemeCollaborationForNativeDecision(decision, ctx);
  expect(competitionMainStageRepository.isDesignated).toHaveBeenCalledWith(
    'main-stage',
    ctx
  );
  expect(memeCollaborationsService.freezeForMint).toHaveBeenCalledTimes(1);
  expect(memeCollaborationsService.freezeForMint).toHaveBeenCalledWith(
    'next-mint',
    ctx
  );
});

it.each([
  { ...decision, skipped: true },
  { ...decision, competition: { ...decision.competition, capabilities: [] } }
])(
  'does not consult designation or freeze skipped/unprivileged decisions',
  async (input) => {
    await freezeMemeCollaborationForNativeDecision(input, ctx);
    expect(competitionMainStageRepository.isDesignated).not.toHaveBeenCalled();
    expect(memeCollaborationsService.freezeForMint).not.toHaveBeenCalled();
  }
);

it('does not freeze a competition that is no longer designated', async () => {
  jest
    .mocked(competitionMainStageRepository.isDesignated)
    .mockResolvedValue(false);
  await freezeMemeCollaborationForNativeDecision(decision, ctx);
  expect(memeCollaborationsService.freezeForMint).not.toHaveBeenCalled();
});

it('does not freeze when the decision has no first-ranked artwork', async () => {
  await freezeMemeCollaborationForNativeDecision(
    { ...decision, winners: [decision.winners[0]] },
    ctx
  );
  expect(memeCollaborationsService.freezeForMint).not.toHaveBeenCalled();
});

it('propagates freezing failure so the decision transaction cannot publish without credits', async () => {
  const error = new Error('freeze failed');
  jest.mocked(memeCollaborationsService.freezeForMint).mockRejectedValue(error);
  await expect(
    freezeMemeCollaborationForNativeDecision(decision, ctx)
  ).rejects.toBe(error);
});
