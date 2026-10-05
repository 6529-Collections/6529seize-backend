import { nativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { nativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { competitionEntryDropHooks } from './competition-entry-drop-hooks';
import {
  competitionEntryRepository,
  NativeDropEntry
} from './competition-entry.repository';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { DropEntity } from '@/entities/IDrop';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { ConnectionWrapper } from '@/sql-executor';

jest.mock('./competition-entry.repository', () => ({
  competitionEntryRepository: {
    lockDropMemberships: jest.fn(),
    deleteEntry: jest.fn()
  }
}));
jest.mock('./native-competition-runtime.service', () => ({
  nativeCompetitionRuntimeService: { refreshCompetition: jest.fn() }
}));
jest.mock('./native-competition-runtime.repository', () => ({
  nativeCompetitionRuntimeRepository: { enqueueEvent: jest.fn() }
}));

const ctx = { connection: {} as ConnectionWrapper<unknown> };
const model = { drop_id: 'submission' } as CreateOrUpdateDropModel;
const drop = { id: 'submission' } as DropEntity;

it.each(Object.values(CompetitionEntryStatus))(
  'rejects content and presentation edits for an unsigned %s entry',
  async (status) => {
    const entries = [{ status, signed: false }] as NativeDropEntry[];
    jest
      .mocked(competitionEntryRepository.lockDropMemberships)
      .mockResolvedValue(entries);
    await expect(
      competitionEntryDropHooks.prepareUpdate(model, async () => {}, ctx)
    ).rejects.toThrow('Competition submissions cannot be edited');
    await expect(
      competitionEntryDropHooks.preparePresentationUpdate(drop, entries, ctx)
    ).rejects.toThrow('Competition submissions cannot be edited');
  }
);

it('preserves ordinary chat editing when there is no competition entry', async () => {
  jest
    .mocked(competitionEntryRepository.lockDropMemberships)
    .mockResolvedValue([]);
  await expect(
    competitionEntryDropHooks.prepareUpdate(model, async () => {}, ctx)
  ).resolves.toEqual({ entries: [] });
  await expect(
    competitionEntryDropHooks.preparePresentationUpdate(drop, [], ctx)
  ).resolves.toEqual({ entries: [] });
});

it.each(Object.values(CompetitionEntryStatus))(
  'deletes a %s entry without converting it to disqualified',
  async (status) => {
    jest.clearAllMocks();
    const entry = {
      id: 'entry',
      competition_id: 'competition',
      wave_id: 'wave',
      drop_id: drop.id,
      status
    } as NativeDropEntry;
    await competitionEntryDropHooks.beforeDelete(drop, [entry], 'author', ctx);
    expect(competitionEntryRepository.deleteEntry).toHaveBeenCalledWith(
      'entry',
      ctx
    );
    expect(
      nativeCompetitionRuntimeService.refreshCompetition
    ).toHaveBeenCalledWith('competition', expect.any(Number), ctx);
    expect(
      nativeCompetitionRuntimeRepository.enqueueEvent
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'COMPETITION_ENTRY_DELETED',
        competition_entry_id: 'entry'
      }),
      ctx
    );
  }
);
