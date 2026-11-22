jest.mock('@/competitions/legacy-competition-mutation', () => ({
  withLegacyPrimaryMutation: jest.fn(),
  readLegacyMutationSource: (action: () => unknown) => action()
}));

import { withLegacyPrimaryMutation } from '@/competitions/legacy-competition-mutation';
import { DropType } from '@/entities/IDrop';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { CreateOrUpdateDropUseCase } from './create-or-update-drop.use-case';
import { DeleteDropUseCase } from './delete-drop.use-case';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE',
  'WAVES_FREEZE_AT',
  'MAIN_STAGE_WAVE_ID'
];
const PAST_FREEZE = new Error('past the waves freeze check');
const connection = {} as any;

describe('legacy entries during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    jest.clearAllMocks();
    for (const name of NAMES) delete process.env[name];
    process.env.FEATURE_WAVES_FROZEN = 'true';
    process.env.MAIN_STAGE_WAVE_ID = 'main';
    jest.mocked(withLegacyPrimaryMutation).mockRejectedValue(PAST_FREEZE);
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  describe('creating and editing', () => {
    function useCase() {
      const result = new CreateOrUpdateDropUseCase(
        { findDropById: jest.fn().mockResolvedValue(null) } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );
      jest.spyOn(result as any, 'assertDropLimits').mockReturnValue(undefined);
      return result;
    }

    function execute(dropType: DropType, waveId: string) {
      return useCase().execute(
        {
          drop_type: dropType,
          wave_id: waveId,
          author_id: 'author',
          parts: []
        } as any,
        false,
        { connection, prePublication: {} as any }
      );
    }

    it('makes or edits no legacy entry while frozen', async () => {
      await expect(
        execute(DropType.PARTICIPATORY, 'wave')
      ).rejects.toBeInstanceOf(WavesFrozenException);
      await expect(execute(DropType.WINNER, 'wave')).rejects.toBeInstanceOf(
        WavesFrozenException
      );
      expect(withLegacyPrimaryMutation).not.toHaveBeenCalled();
    });

    it('takes Main Stage entries when the freeze keeps it', async () => {
      process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
      await expect(execute(DropType.PARTICIPATORY, 'main')).rejects.toBe(
        PAST_FREEZE
      );
      await expect(
        execute(DropType.PARTICIPATORY, 'wave')
      ).rejects.toBeInstanceOf(WavesFrozenException);
    });

    it('never takes the entry lock for chat', async () => {
      await expect(execute(DropType.CHAT, 'wave')).rejects.not.toBeInstanceOf(
        WavesFrozenException
      );
      expect(withLegacyPrimaryMutation).not.toHaveBeenCalled();
    });
  });

  describe('deleting', () => {
    function useCase(dropType: DropType) {
      const dropsDb = {
        findDropById: jest.fn().mockResolvedValue({
          id: 'drop',
          wave_id: 'wave',
          drop_type: dropType,
          author_id: 'author'
        }),
        findWaveByIdOrNull: jest.fn().mockRejectedValue(PAST_FREEZE)
      };
      return new DeleteDropUseCase(
        {} as any,
        {} as any,
        dropsDb as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { lockForDelete: jest.fn().mockResolvedValue([]) } as any
      );
    }

    function deleteDrop(
      dropType: DropType,
      purpose: 'DELETE' | 'UPDATE' | 'SYSTEM_DELETE'
    ) {
      return useCase(dropType).execute(
        {
          drop_id: 'drop',
          deleter_id: purpose === 'SYSTEM_DELETE' ? null : 'author',
          deleter_identity: 'author',
          deletion_purpose: purpose
        } as any,
        { connection }
      );
    }

    beforeEach(() => {
      jest
        .mocked(withLegacyPrimaryMutation)
        .mockImplementation((_wave, _ctx, action) => action(null));
    });

    it.each([DropType.PARTICIPATORY, DropType.WINNER, DropType.COMPETITION])(
      'withdraws no %s entry by deleting it while frozen',
      async (dropType) => {
        await expect(deleteDrop(dropType, 'DELETE')).rejects.toBeInstanceOf(
          WavesFrozenException
        );
      }
    );

    it('deletes chat as before while frozen', async () => {
      await expect(deleteDrop(DropType.CHAT, 'DELETE')).rejects.toBe(
        PAST_FREEZE
      );
    });

    it("lets the backend's own deletes (moderation) through", async () => {
      await expect(
        deleteDrop(DropType.PARTICIPATORY, 'SYSTEM_DELETE')
      ).rejects.toBe(PAST_FREEZE);
    });

    it('lets an edit replace its rows', async () => {
      await expect(deleteDrop(DropType.PARTICIPATORY, 'UPDATE')).rejects.toBe(
        PAST_FREEZE
      );
    });

    it('deletes entries as before when not frozen', async () => {
      delete process.env.FEATURE_WAVES_FROZEN;
      await expect(deleteDrop(DropType.PARTICIPATORY, 'DELETE')).rejects.toBe(
        PAST_FREEZE
      );
    });
  });
});
