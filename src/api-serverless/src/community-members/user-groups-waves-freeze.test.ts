import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import { Time } from '@/time';
import {
  WAVES_FROZEN_GROUP_MESSAGE,
  WAVES_FROZEN_GROUP_VISIBILITY_MESSAGE,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const FLAG = 'FEATURE_WAVES_FROZEN';
const AT = 'WAVES_FREEZE_AT';
const PAST_FREEZE = new Error('past the waves freeze check');

/** The connection the fake transaction hands its work. */
const TX_CONNECTION = { connection: 'the transaction' };
const WAVE_GROUPS = ['wave-admin-group', 'decision-vote-group'];

function createService() {
  // A moving wave uses WAVE_GROUPS; every other group only staying waves
  // use, or none.
  const { usedByMovingWave } = stubWavesScope({
    movingWaveGroups: WAVE_GROUPS
  });
  const userGroupsDb = {
    executeNativeQueriesInTransaction: jest.fn(
      (work: (connection: unknown) => Promise<unknown>) => work(TX_CONNECTION)
    ),
    findVisibilityRequest: jest.fn().mockResolvedValue(null),
    reserveVisibilityRequest: jest.fn().mockResolvedValue(false),
    lockForVisibilityChange: jest.fn().mockResolvedValue(undefined),
    completeVisibilityRequest: jest.fn().mockResolvedValue(undefined)
  };
  const service = new UserGroupsService(
    userGroupsDb as any,
    {} as any,
    {} as any,
    {} as any
  );
  jest.spyOn(service, 'getByIdOrThrow').mockRejectedValue(PAST_FREEZE);
  return { service, userGroupsDb, usedByMovingWave };
}

function change(old_version_id: string | null, idempotencyKey?: string) {
  return {
    group_id: 'new-version',
    old_version_id,
    visible: true,
    profile_id: 'creator',
    idempotencyKey
  } as any;
}

/** Hiding or showing a group, with no replacement. */
function visibility(group_id: string, visible: boolean) {
  return {
    group_id,
    old_version_id: null,
    visible,
    profile_id: 'creator'
  } as any;
}

describe('group replacement during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of [FLAG, AT]) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of [FLAG, AT]) delete process.env[name];
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of [FLAG, AT]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it.each(['wave-admin-group', 'decision-vote-group'])(
    'replaces no group a wave or decision uses (%s) while frozen',
    async (oldVersion) => {
      process.env[FLAG] = 'true';
      const { service, userGroupsDb } = createService();
      const result = service.changeVisibility(change(oldVersion), {});
      await expect(result).rejects.toBeInstanceOf(WavesFrozenException);
      await expect(result).rejects.toThrow(WAVES_FROZEN_GROUP_MESSAGE);
      expect(
        userGroupsDb.executeNativeQueriesInTransaction
      ).not.toHaveBeenCalled();
    }
  );

  it('reads the receipt and writes none when it refuses a request with an Idempotency-Key', async () => {
    process.env[FLAG] = 'true';
    const { service, userGroupsDb } = createService();
    jest.spyOn(moderationReviewDb, 'savedRequest').mockResolvedValue(null);
    await expect(
      service.changeVisibility(change('wave-admin-group', 'new-key'), {})
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(userGroupsDb.findVisibilityRequest).toHaveBeenCalledTimes(1);
    expect(userGroupsDb.reserveVisibilityRequest).not.toHaveBeenCalled();
    expect(
      userGroupsDb.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
  });

  it('answers a retry of a save that finished before the freeze from its receipt', async () => {
    process.env[FLAG] = 'true';
    const { service, userGroupsDb } = createService();
    const stored = { id: 'wave-admin-group' } as any;
    userGroupsDb.findVisibilityRequest.mockResolvedValue({
      payload_hash: 'saved',
      completed: true
    });
    userGroupsDb.reserveVisibilityRequest.mockResolvedValue(true);
    jest.mocked(service.getByIdOrThrow).mockResolvedValue(stored);
    await expect(
      service.changeVisibility(change('wave-admin-group', 'saved-key'), {})
    ).resolves.toBe(stored);
    expect(userGroupsDb.lockForVisibilityChange).not.toHaveBeenCalled();
  });

  it('answers a retry of a save with a receipt from before Idempotency-Key receipts', async () => {
    process.env[FLAG] = 'true';
    const { service, userGroupsDb } = createService();
    const stored = { id: 'wave-admin-group' } as any;
    jest.spyOn(moderationReviewDb, 'savedRequest').mockResolvedValue({
      scope: {
        save_subject_id: 'new-version',
        old_version_id: 'wave-admin-group',
        visible: true
      },
      published_subject_id: 'wave-admin-group'
    } as any);
    jest.mocked(service.getByIdOrThrow).mockResolvedValue(stored);
    await expect(
      service.changeVisibility(change('wave-admin-group', 'legacy-key'), {})
    ).resolves.toBe(stored);
    expect(userGroupsDb.completeVisibilityRequest).toHaveBeenCalledTimes(1);
  });

  it('still replaces a group no wave uses, and publishes new groups', async () => {
    process.env[FLAG] = 'true';
    const { service, usedByMovingWave } = createService();
    await expect(
      service.changeVisibility(change('filter-group'), {})
    ).rejects.toBe(PAST_FREEZE);
    await expect(service.changeVisibility(change(null), {})).rejects.toBe(
      PAST_FREEZE
    );
    // Once before the transaction, with no connection (so the primary), and
    // once inside it, on the transaction's connection.
    expect(usedByMovingWave.mock.calls).toEqual([
      [['new-version', 'filter-group'], {}],
      [['new-version', 'filter-group'], { connection: TX_CONNECTION }],
      [['new-version'], {}],
      [['new-version'], { connection: TX_CONNECTION }]
    ]);
  });

  it('refuses a change that would make a staying wave using the group move', async () => {
    process.env[FLAG] = 'true';
    const { service, userGroupsDb, usedByMovingWave } = createService();
    jest.spyOn(moderationReviewDb, 'savedRequest').mockResolvedValue(null);
    // Before the write only staying waves use the group; after it, one of
    // them would move (say the group was its only hidden group).
    usedByMovingWave
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const applied = jest
      .spyOn(service as any, 'applyVisibilityChange')
      .mockResolvedValue({ updatedGroup: {}, replacedGroup: null });
    await expect(
      service.changeVisibility(
        { ...visibility('hidden-group', true), idempotencyKey: 'k' },
        {}
      )
    ).rejects.toThrow(WAVES_FROZEN_GROUP_VISIBILITY_MESSAGE);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(usedByMovingWave).toHaveBeenLastCalledWith(['hidden-group'], {
      connection: TX_CONNECTION
    });
    // The thrown error rolls the write back with its receipt.
    expect(userGroupsDb.completeVisibilityRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'neither hides nor shows a group a wave uses while frozen (visible=%s)',
    async (visible) => {
      process.env[FLAG] = 'true';
      const { service, userGroupsDb } = createService();
      const result = service.changeVisibility(
        visibility('wave-admin-group', visible),
        {}
      );
      await expect(result).rejects.toBeInstanceOf(WavesFrozenException);
      await expect(result).rejects.toThrow(
        WAVES_FROZEN_GROUP_VISIBILITY_MESSAGE
      );
      expect(
        userGroupsDb.executeNativeQueriesInTransaction
      ).not.toHaveBeenCalled();
    }
  );

  it('still publishes or hides a group no wave uses while frozen', async () => {
    process.env[FLAG] = 'true';
    const { service } = createService();
    await expect(
      service.changeVisibility(visibility('filter-group', true), {})
    ).rejects.toBe(PAST_FREEZE);
    await expect(
      service.changeVisibility(visibility('filter-group', false), {})
    ).rejects.toBe(PAST_FREEZE);
  });

  it.each([
    [
      'a replacement',
      change('wave-admin-group', 'new-key'),
      WAVES_FROZEN_GROUP_MESSAGE
    ],
    [
      'hiding',
      { ...visibility('wave-admin-group', false), idempotencyKey: 'k' },
      WAVES_FROZEN_GROUP_VISIBILITY_MESSAGE
    ]
  ])(
    'checks again after the locks when the freeze starts during the wait (%s)',
    async (_name, request, message) => {
      const freeze = Date.UTC(2026, 10, 25);
      process.env[AT] = new Date(freeze).toISOString();
      const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(freeze - 1);
      const { service, userGroupsDb, usedByMovingWave } = createService();
      jest.spyOn(moderationReviewDb, 'savedRequest').mockResolvedValue(null);
      userGroupsDb.lockForVisibilityChange.mockImplementation(async () => {
        now.mockReturnValue(freeze + 1);
      });
      await expect(service.changeVisibility(request, {})).rejects.toThrow(
        message
      );
      // The check that refused it read on the transaction's connection.
      expect(usedByMovingWave).toHaveBeenCalledTimes(1);
      expect(usedByMovingWave).toHaveBeenCalledWith(expect.any(Array), {
        connection: TX_CONNECTION
      });
      expect(userGroupsDb.reserveVisibilityRequest).toHaveBeenCalledTimes(1);
      expect(userGroupsDb.lockForVisibilityChange).toHaveBeenCalled();
      // The write never started, and the thrown error rolls back the receipt.
      expect(service.getByIdOrThrow).not.toHaveBeenCalled();
      expect(userGroupsDb.completeVisibilityRequest).not.toHaveBeenCalled();
    }
  );

  it('replaces groups as before when not frozen', async () => {
    delete process.env[FLAG];
    const { service, usedByMovingWave } = createService();
    await expect(
      service.changeVisibility(change('wave-admin-group'), {})
    ).rejects.toBe(PAST_FREEZE);
    expect(usedByMovingWave).not.toHaveBeenCalled();
  });
});
