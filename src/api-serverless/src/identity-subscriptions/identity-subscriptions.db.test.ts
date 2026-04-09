import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { IdentitySubscriptionsDb } from './identity-subscriptions.db';

describe('IdentitySubscriptionsDb', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('coerces stringly MySQL booleans for drop notification recipients', async () => {
    const connection = { connection: { id: 'tx' } } as any;
    const execute = jest.fn().mockResolvedValue([
      {
        identity_id: 'profile-1',
        subscribed_to_all_drops: '0',
        has_group_mention: '0'
      },
      {
        identity_id: 'profile-2',
        subscribed_to_all_drops: '1',
        has_group_mention: '1'
      }
    ]);
    const repo = new IdentitySubscriptionsDb(
      () =>
        ({
          execute
        }) as any
    );

    await expect(
      repo.findWaveFollowersEligibleForDropNotifications(
        {
          waveId: 'wave-1',
          authorId: 'author-1',
          mentionedGroups: []
        },
        connection
      )
    ).resolves.toEqual([
      {
        identity_id: 'profile-1',
        subscribed_to_all_drops: false,
        has_group_mention: false
      },
      {
        identity_id: 'profile-2',
        subscribed_to_all_drops: true,
        has_group_mention: true
      }
    ]);

    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      {
        waveId: 'wave-1',
        authorId: 'author-1',
        mentionedGroups: [],
        targetType: ActivityEventTargetType.WAVE,
        targetAction: ActivityEventAction.DROP_CREATED
      },
      { wrappedConnection: connection }
    );
  });

  it('coerces stringly MySQL booleans for wave subscription state', async () => {
    const connection = { connection: { id: 'tx' } } as any;
    const oneOrNull = jest
      .fn()
      .mockResolvedValue({ subscribed_to_all_drops: '0' });
    const repo = new IdentitySubscriptionsDb(
      () =>
        ({
          oneOrNull
        }) as any
    );

    await expect(
      repo.getWaveSubscriptionState('profile-1', 'wave-1', connection)
    ).resolves.toEqual({
      is_following: true,
      subscribed_to_all_drops: false
    });

    expect(oneOrNull).toHaveBeenCalledWith(
      expect.any(String),
      {
        identityId: 'profile-1',
        waveId: 'wave-1',
        target_type: ActivityEventTargetType.WAVE,
        target_action: ActivityEventAction.DROP_CREATED
      },
      { wrappedConnection: connection }
    );
  });
});
