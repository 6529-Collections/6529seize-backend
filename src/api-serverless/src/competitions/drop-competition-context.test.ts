import { CompetitionEntryService } from './competition-entry.service';
import { competitionService } from '@/competitions/competition.service';
import { competitionEntryRepository } from '@/competitions/competition-entry.repository';
import { dropsDb } from '@/drops/drops.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { DropEntity, DropType } from '@/entities/IDrop';
import { NotFoundException } from '@/exceptions';

jest.mock('@/competitions/competition.service', () => ({
  competitionService: {
    getHub: jest.fn(),
    getEntry: jest.fn(),
    getCompetition: jest.fn()
  }
}));
jest.mock('@/api/drops/drops.api.service', () => ({ dropsService: {} }));

const service = new CompetitionEntryService();
const drop = {
  id: 'drop',
  wave_id: 'wave',
  drop_type: DropType.COMPETITION
} as DropEntity;
const entry = {
  id: 'entry',
  wave_id: 'wave',
  competition_id: 'competition',
  drop_id: 'drop'
};

beforeEach(() => {
  jest.spyOn(dropsDb, 'findDropById').mockResolvedValue(drop);
  jest.spyOn(contentModerationDb, 'getPresentations').mockResolvedValue({});
  jest
    .spyOn(competitionEntryRepository, 'findDropEntries')
    .mockResolvedValue([entry as never]);
  jest
    .mocked(competitionService.getHub)
    .mockResolvedValue({ id: 'wave' } as never);
  jest.mocked(competitionService.getEntry).mockResolvedValue(entry as never);
  jest
    .mocked(competitionService.getCompetition)
    .mockResolvedValue({ id: 'competition' } as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
});

it('resolves native voting through the parent-checked competition and entry', async () => {
  await expect(service.getDropContext('wave', 'drop', {})).resolves.toEqual({
    competition: { id: 'competition' },
    entry
  });
  expect(competitionService.getEntry).toHaveBeenCalledWith(
    'wave',
    'competition',
    'entry',
    {}
  );
});
it('returns legacy context only when a non-native drop has no membership', async () => {
  jest
    .mocked(dropsDb.findDropById)
    .mockResolvedValue({ ...drop, drop_type: DropType.PARTICIPATORY });
  jest.mocked(competitionEntryRepository.findDropEntries).mockResolvedValue([]);
  await expect(service.getDropContext('wave', 'drop', {})).resolves.toEqual({
    competition: null,
    entry: null
  });
});
it('never routes an orphaned native entry to legacy voting', async () => {
  jest.mocked(competitionEntryRepository.findDropEntries).mockResolvedValue([]);
  await expect(
    service.getDropContext('wave', 'drop', {})
  ).rejects.toBeInstanceOf(NotFoundException);
});
it.each([null, { ...drop, wave_id: 'other' }])(
  'masks deleted or wrong-parent drops',
  async (value) => {
    jest.mocked(dropsDb.findDropById).mockResolvedValue(value);
    await expect(
      service.getDropContext('wave', 'drop', {})
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(competitionEntryRepository.findDropEntries).not.toHaveBeenCalled();
  }
);
it('checks wave visibility before reading drop membership', async () => {
  jest
    .mocked(competitionService.getHub)
    .mockRejectedValue(new NotFoundException('Wave not found'));
  await expect(
    service.getDropContext('wave', 'drop', {})
  ).rejects.toBeInstanceOf(NotFoundException);
  expect(dropsDb.findDropById).not.toHaveBeenCalled();
});
it('does not expose hidden content', async () => {
  jest.mocked(contentModerationDb.getPresentations).mockResolvedValue({
    drop: { moderation: { can_view: false }, viewer: {} }
  } as never);
  await expect(
    service.getDropContext('wave', 'drop', {})
  ).rejects.toBeInstanceOf(NotFoundException);
  expect(competitionEntryRepository.findDropEntries).not.toHaveBeenCalled();
});
it('does not fall back when the entry is deleted or its competition is inaccessible', async () => {
  jest
    .mocked(competitionService.getEntry)
    .mockRejectedValue(new NotFoundException('Entry not found'));
  await expect(
    service.getDropContext('wave', 'drop', {})
  ).rejects.toBeInstanceOf(NotFoundException);
});
