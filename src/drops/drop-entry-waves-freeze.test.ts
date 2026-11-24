jest.mock('@/competitions/legacy-competition-mutation', () => ({
  withLegacyPrimaryMutation: jest.fn(),
  readLegacyMutationSource: (action: () => unknown) => action()
}));

import { withLegacyPrimaryMutation } from '@/competitions/legacy-competition-mutation';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import { getPrePublicationContentFingerprint } from '@/content-moderation/pre-publication-moderation.service';
import { DropType } from '@/entities/IDrop';
import { memeCollaborationsService } from '@/meme-collaborations/meme-collaborations.service';
import { Time } from '@/time';
import {
  WAVES_FROZEN_POLL_MESSAGE,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';
import { CreateOrUpdateDropUseCase } from './create-or-update-drop.use-case';
import { DeleteDropUseCase } from './delete-drop.use-case';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE',
  'WAVES_FREEZE_AT',
  'MAIN_STAGE_WAVE_ID'
];
const PAST_FREEZE = new Error('past the waves freeze check');
const FREEZE = Date.UTC(2026, 10, 25);
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
  afterEach(() => {
    jest.restoreAllMocks();
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
      // The write itself, past the owner lock and the freeze check.
      jest
        .spyOn(result as any, 'createOrUpdateDrop')
        .mockRejectedValue(PAST_FREEZE);
      return result;
    }

    function execute(dropType: DropType, waveId: string) {
      return useCase().execute(
        {
          drop_type: dropType,
          wave_id: waveId,
          author_id: 'author',
          parts: [],
          metadata: []
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

    it('refuses an entry whose author profile lock wait passes the freeze', async () => {
      delete process.env.FEATURE_WAVES_FROZEN;
      process.env.WAVES_FREEZE_AT = new Date(FREEZE).toISOString();
      const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(FREEZE - 1);
      jest
        .mocked(withLegacyPrimaryMutation)
        .mockImplementation(async (_wave, _ctx, action) => action(null));
      // The last lock before the drop is written: the author's profile row.
      jest
        .spyOn(moderationReviewDb, 'lockProfile')
        .mockImplementation(async () => {
          now.mockReturnValue(FREEZE + 1);
        });
      jest.spyOn(moderationReviewDb, 'lockDrop').mockResolvedValue(undefined);
      const dropsDb = {
        findDropById: jest.fn().mockResolvedValue(null),
        insertDrop: jest.fn().mockRejectedValue(PAST_FREEZE)
      };
      const wavesApiDb = {
        findById: jest.fn().mockResolvedValue({ id: 'wave', type: 'RANK' })
      };
      const forEntry = new CreateOrUpdateDropUseCase(
        dropsDb as any,
        {} as any,
        {} as any,
        wavesApiDb as any,
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
        { assertPostingAllowed: jest.fn().mockResolvedValue(undefined) } as any
      );
      jest
        .spyOn(forEntry as any, 'assertDropLimits')
        .mockReturnValue(undefined);
      jest
        .spyOn(forEntry as any, 'validateReferences')
        .mockImplementation(async (model) => ({
          validatedModel: model,
          groupIdsUserIsEligibleFor: []
        }));
      jest
        .spyOn(forEntry as any, 'verifyChatLinksAreAllowed')
        .mockReturnValue(undefined);
      const model = {
        drop_id: null,
        drop_type: DropType.PARTICIPATORY,
        wave_id: 'wave',
        author_id: 'author',
        title: null,
        parts: [],
        metadata: [],
        mentioned_groups: [],
        mentioned_users: [],
        referenced_nfts: []
      } as any;
      const prePublication = {
        operation: 'CREATE',
        dropId: 'new-drop',
        authorProfileId: 'author',
        contentFingerprint: getPrePublicationContentFingerprint({
          title: null,
          parts: []
        }),
        requestId: 'request',
        permitGeneration: 0,
        authenticationContext: undefined
      } as any;
      await expect(
        forEntry.execute(model, false, { connection, prePublication })
      ).rejects.toBeInstanceOf(WavesFrozenException);
      expect(moderationReviewDb.lockProfile).toHaveBeenCalledTimes(1);
      expect(dropsDb.insertDrop).not.toHaveBeenCalled();
    });

    it('posts chat as before, without the entry lock', async () => {
      await expect(execute(DropType.CHAT, 'wave')).rejects.toBe(PAST_FREEZE);
      expect(withLegacyPrimaryMutation).not.toHaveBeenCalled();
    });

    it('refuses an entry whose owner lock wait passes the freeze', async () => {
      delete process.env.FEATURE_WAVES_FROZEN;
      process.env.WAVES_FREEZE_AT = new Date(FREEZE).toISOString();
      const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(FREEZE - 1);
      jest
        .mocked(withLegacyPrimaryMutation)
        .mockImplementation(async (_wave, _ctx, action) => {
          now.mockReturnValue(FREEZE + 1);
          return action(null);
        });
      const forEntry = useCase();
      await expect(
        forEntry.execute(
          {
            drop_type: DropType.PARTICIPATORY,
            wave_id: 'wave',
            author_id: 'author',
            parts: [],
            metadata: []
          } as any,
          false,
          { connection, prePublication: {} as any }
        )
      ).rejects.toBeInstanceOf(WavesFrozenException);
      expect(withLegacyPrimaryMutation).toHaveBeenCalledTimes(1);
      expect((forEntry as any).createOrUpdateDrop).not.toHaveBeenCalled();
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

  describe('chat drops with a poll', () => {
    beforeEach(() => {
      jest
        .mocked(withLegacyPrimaryMutation)
        .mockImplementation((_wave, _ctx, action) => action(null));
    });

    /**
     * A chat delete or edit that gets as far as the deletions: the first one
     * (closing meme collaborations) stands for every write after the check.
     */
    function useCase({
      poll,
      directMessage = false
    }: {
      poll: boolean;
      directMessage?: boolean;
    }) {
      const dropsDb = {
        findDropById: jest.fn().mockResolvedValue({
          id: 'drop',
          wave_id: 'wave',
          drop_type: DropType.CHAT,
          author_id: 'author'
        }),
        findWaveByIdOrNull: jest.fn().mockResolvedValue({
          id: 'wave',
          is_direct_message: directMessage,
          description_drop_id: 'description'
        })
      };
      const dropPollsDb = {
        findPollByDropIdForUpdate: jest
          .fn()
          .mockResolvedValue(poll ? { id: 'poll', drop_id: 'drop' } : null),
        deleteByDropId: jest.fn()
      };
      const result = new DeleteDropUseCase(
        {} as any,
        {} as any,
        dropsDb as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        dropPollsDb as any,
        {} as any,
        {} as any,
        {
          lockForDelete: jest.fn().mockResolvedValue([]),
          beforeDelete: jest.fn().mockResolvedValue(undefined)
        } as any
      );
      jest
        .spyOn(result as any, 'assertDeleterIsAllowedToDeleteDrop')
        .mockResolvedValue(undefined);
      jest
        .spyOn(memeCollaborationsService, 'closeDeleted')
        .mockRejectedValue(PAST_FREEZE);
      return { result, dropPollsDb };
    }

    function run(
      forDrop: ReturnType<typeof useCase>,
      purpose: 'DELETE' | 'UPDATE' | 'SYSTEM_DELETE'
    ) {
      return forDrop.result.execute(
        {
          drop_id: 'drop',
          deleter_id: purpose === 'SYSTEM_DELETE' ? null : 'author',
          deleter_identity: 'author',
          deletion_purpose: purpose
        } as any,
        { connection }
      );
    }

    it.each(['DELETE', 'UPDATE'] as const)(
      'neither deletes nor edits away a poll while frozen (%s)',
      async (purpose) => {
        const forDrop = useCase({ poll: true });
        await expect(run(forDrop, purpose)).rejects.toThrow(
          WAVES_FROZEN_POLL_MESSAGE
        );
        await expect(run(forDrop, purpose)).rejects.toBeInstanceOf(
          WavesFrozenException
        );
        expect(forDrop.dropPollsDb.deleteByDropId).not.toHaveBeenCalled();
        expect(memeCollaborationsService.closeDeleted).not.toHaveBeenCalled();
      }
    );

    it('checks right before the deletion, after the waits before it', async () => {
      delete process.env.FEATURE_WAVES_FROZEN;
      process.env.WAVES_FREEZE_AT = new Date(FREEZE).toISOString();
      const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(FREEZE - 1);
      // The delete waits on the drop's ownership lock; the freeze starts.
      jest
        .mocked(withLegacyPrimaryMutation)
        .mockImplementation(async (_wave, _ctx, action) => {
          now.mockReturnValue(FREEZE + 1);
          return action(null);
        });
      const forDrop = useCase({ poll: true });
      await expect(run(forDrop, 'DELETE')).rejects.toThrow(
        WAVES_FROZEN_POLL_MESSAGE
      );
      // The poll row is read for update on the delete's own connection.
      expect(
        forDrop.dropPollsDb.findPollByDropIdForUpdate
      ).toHaveBeenCalledWith('drop', expect.objectContaining({ connection }));
      expect(forDrop.dropPollsDb.deleteByDropId).not.toHaveBeenCalled();
    });

    it('deletes and edits chat with no poll, direct messages and moderation deletes as before', async () => {
      await expect(run(useCase({ poll: false }), 'DELETE')).rejects.toBe(
        PAST_FREEZE
      );
      await expect(run(useCase({ poll: false }), 'UPDATE')).rejects.toBe(
        PAST_FREEZE
      );
      await expect(
        run(useCase({ poll: true, directMessage: true }), 'DELETE')
      ).rejects.toBe(PAST_FREEZE);
      await expect(run(useCase({ poll: true }), 'SYSTEM_DELETE')).rejects.toBe(
        PAST_FREEZE
      );
    });

    it('removes polls as before when not frozen', async () => {
      delete process.env.FEATURE_WAVES_FROZEN;
      const forDrop = useCase({ poll: true });
      await expect(run(forDrop, 'DELETE')).rejects.toBe(PAST_FREEZE);
      expect(
        forDrop.dropPollsDb.findPollByDropIdForUpdate
      ).not.toHaveBeenCalled();
    });
  });
});
