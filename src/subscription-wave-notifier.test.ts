jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn()
}));

jest.mock('@/api/waves/wave-score.service', () => ({
  waveScoreService: { requestWaveScoreRefreshBestEffort: jest.fn() },
  WaveScoreDirtyRefreshReason: { DROP_CHANGED: 'DROP_CHANGED' }
}));

jest.mock('@/drops/create-or-update-drop.use-case', () => ({
  createOrUpdateDrop: { execute: jest.fn() }
}));

jest.mock('@/drops/drops.db', () => ({
  dropsDb: { updateHideLinkPreview: jest.fn() }
}));

jest.mock('@/identities/identities.db', () => ({
  identitiesDb: {
    getIdentityByProfileId: jest.fn(),
    getIdentityByWallet: jest.fn()
  }
}));

import {
  buildDailySubscriptionsWaveMessage,
  buildInsufficientBalanceWaveMessage,
  buildNoBalanceFoundWaveMessage,
  buildNoSubscriptionFoundWaveMessage,
  buildProcessedTopUpWaveMessage,
  buildSubscriptionTopUpWaveMessage,
  getSubscriptionAdminHandles,
  sendDailySubscriptionsWaveUpdate,
  sendSubscriptionTopUpWaveUpdate
} from './subscription-wave-notifier';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { dropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import { identitiesDb } from '@/identities/identities.db';
import { setSqlExecutor } from '@/sql-executor';

describe('subscription wave notifier message formatting', () => {
  const originalEnv = {
    SUBSCRIPTIONS_ADMIN_HANDLES: process.env.SUBSCRIPTIONS_ADMIN_HANDLES,
    SUBSCRIPTIONS_WAVE_ID: process.env.SUBSCRIPTIONS_WAVE_ID,
    SUBSCRIPTIONS_BOT_PROFILE_ID: process.env.SUBSCRIPTIONS_BOT_PROFILE_ID
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setSqlExecutor({
      execute: jest.fn(),
      executeNativeQueriesInTransaction: jest.fn(async (callback) =>
        callback({ connection: 'connection' })
      )
    } as any);
  });

  afterEach(() => {
    restoreEnv('SUBSCRIPTIONS_ADMIN_HANDLES', originalEnv);
    restoreEnv('SUBSCRIPTIONS_WAVE_ID', originalEnv);
    restoreEnv('SUBSCRIPTIONS_BOT_PROFILE_ID', originalEnv);
  });

  it('builds daily subscription list posts with the card link', () => {
    expect(
      buildDailySubscriptionsWaveMessage({
        memeId: 312,
        seizeDomain: '6529',
        uploadLink: 'https://arweave.net/subscriptions'
      })
    ).toBe(
      [
        '📋 Published provisional list of Subscriptions for [The Memes Card #312](https://6529.io/the-memes/312)',
        '',
        'View on 6529.io:',
        'https://6529.io/open-data/meme-subscriptions',
        '',
        'View on Arweave:',
        'https://arweave.net/subscriptions'
      ].join('\n')
    );
  });

  it('parses optional admin handles from comma or semicolon separated env', () => {
    process.env.SUBSCRIPTIONS_ADMIN_HANDLES =
      ' @[admin1] ; @admin2, admin3 ,, @admin1, bad-handle, xx ';

    expect(getSubscriptionAdminHandles()).toEqual([
      'admin1',
      'admin2',
      'admin3'
    ]);
  });

  it('adds admin mentions to already processed top-up warnings', () => {
    expect(
      buildProcessedTopUpWaveMessage({
        hash: '0xabc',
        adminHandles: ['admin1', 'admin2']
      })
    ).toBe('Top up 0xabc already processed\n\n@[admin1] @[admin2]');
  });

  it('builds normal top-up posts with an optional profile mention', () => {
    expect(
      buildSubscriptionTopUpWaveMessage({
        topUp: {
          amount: 0.06529,
          from_wallet: '0x1234'
        },
        seizeDomain: '6529',
        etherscanLink: 'https://etherscan.io/tx/0xabc',
        profileHandle: '6529er'
      })
    ).toBe(
      [
        '🔝 Subscription Top Up of 0.06529 ETH from 0x1234.',
        '',
        'Profile: @[6529er]',
        '',
        'View on 6529.io:',
        'https://6529.io/0x1234/subscriptions',
        '',
        'View on Etherscan:',
        'https://etherscan.io/tx/0xabc'
      ].join('\n')
    );
  });

  it('builds admin-tagged redemption issue posts', () => {
    const adminHandles = ['admin1', 'admin2'];
    const transactionLink = 'https://etherscan.io/tx/0xabc';

    expect(
      buildNoSubscriptionFoundWaveMessage({
        airdropAddress: '0xairdrop',
        transactionLink,
        adminHandles
      })
    ).toBe(
      [
        'No subscription found for airdrop address:',
        '',
        '0xairdrop',
        '',
        'Transaction:',
        transactionLink,
        '',
        '@[admin1] @[admin2]'
      ].join('\n')
    );
    expect(
      buildNoBalanceFoundWaveMessage({
        consolidationKey: '0xkey',
        transactionLink,
        adminHandles
      })
    ).toBe(
      [
        'No balance found for consolidation key:',
        '',
        '0xkey',
        '',
        'Transaction:',
        transactionLink,
        '',
        '@[admin1] @[admin2]'
      ].join('\n')
    );
    expect(
      buildInsufficientBalanceWaveMessage({
        consolidationKey: '0xkey',
        transactionLink,
        adminHandles
      })
    ).toBe(
      [
        'Insufficient balance for consolidation key:',
        '',
        '0xkey',
        '',
        'Transaction:',
        transactionLink,
        '',
        '@[admin1] @[admin2]'
      ].join('\n')
    );
  });

  it('skips posting when wave env is not configured', async () => {
    delete process.env.SUBSCRIPTIONS_WAVE_ID;
    delete process.env.SUBSCRIPTIONS_BOT_PROFILE_ID;

    await sendDailySubscriptionsWaveUpdate({
      memeId: 312,
      seizeDomain: '6529',
      uploadLink: 'https://arweave.net/subscriptions'
    });

    expect(createOrUpdateDrop.execute).not.toHaveBeenCalled();
  });

  it('creates wave drops with hidden link previews and push notifications', async () => {
    process.env.SUBSCRIPTIONS_WAVE_ID = 'wave-1';
    process.env.SUBSCRIPTIONS_BOT_PROFILE_ID = 'profile-1';
    (identitiesDb.getIdentityByProfileId as jest.Mock).mockResolvedValue({
      handle: 'subbot',
      primary_address: '0xbot'
    });
    (createOrUpdateDrop.execute as jest.Mock).mockResolvedValue({
      drop_id: 'drop-1',
      pending_push_notification_ids: [1, 2]
    });

    await sendDailySubscriptionsWaveUpdate({
      memeId: 312,
      seizeDomain: '6529',
      uploadLink: 'https://arweave.net/subscriptions'
    });

    expect(identitiesDb.getIdentityByProfileId).toHaveBeenCalledWith(
      'profile-1',
      { connection: 'connection' }
    );
    expect(createOrUpdateDrop.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: 'wave-1',
        mentioned_users: [],
        author_identity: 'subbot',
        author_id: 'profile-1',
        drop_type: DropType.CHAT
      }),
      false,
      {
        connection: { connection: 'connection' },
        bypassChatLinkRestrictions: true,
        bypassChatSlowModeRestrictions: true
      }
    );
    const dropModel = (createOrUpdateDrop.execute as jest.Mock).mock
      .calls[0][0];
    expect(dropModel.parts[0].content).toContain('The Memes Card #312');
    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      {
        drop_id: 'drop-1',
        hide_link_preview: true
      },
      { connection: { connection: 'connection' } }
    );
    expect(
      waveScoreService.requestWaveScoreRefreshBestEffort
    ).toHaveBeenCalledWith(
      ['wave-1'],
      WaveScoreDirtyRefreshReason.DROP_CHANGED,
      { connection: { connection: 'connection' } }
    );
    expect(sendIdentityPushNotifications).toHaveBeenCalledWith([1, 2]);
  });

  it('skips posting when the bot profile cannot supply an author identity', async () => {
    process.env.SUBSCRIPTIONS_WAVE_ID = 'wave-1';
    process.env.SUBSCRIPTIONS_BOT_PROFILE_ID = 'profile-1';
    (identitiesDb.getIdentityByProfileId as jest.Mock).mockResolvedValue({
      handle: null,
      primary_address: null
    });

    await sendDailySubscriptionsWaveUpdate({
      memeId: 312,
      seizeDomain: '6529',
      uploadLink: 'https://arweave.net/subscriptions'
    });

    expect(createOrUpdateDrop.execute).not.toHaveBeenCalled();
    expect(sendIdentityPushNotifications).toHaveBeenCalledWith([]);
  });

  it('mentions the top-up profile when one resolves', async () => {
    process.env.SUBSCRIPTIONS_WAVE_ID = 'wave-1';
    process.env.SUBSCRIPTIONS_BOT_PROFILE_ID = 'profile-1';
    (identitiesDb.getIdentityByProfileId as jest.Mock).mockResolvedValue({
      handle: 'subbot',
      primary_address: '0xbot'
    });
    (identitiesDb.getIdentityByWallet as jest.Mock).mockResolvedValue({
      handle: 'topper'
    });
    (createOrUpdateDrop.execute as jest.Mock).mockResolvedValue({
      drop_id: 'drop-1',
      pending_push_notification_ids: []
    });

    await sendSubscriptionTopUpWaveUpdate({
      topUp: {
        amount: 0.06529,
        from_wallet: '0x1234'
      } as any,
      seizeDomain: '6529',
      etherscanLink: 'https://etherscan.io/tx/0xabc'
    });

    const dropModel = (createOrUpdateDrop.execute as jest.Mock).mock
      .calls[0][0];
    expect(dropModel.mentioned_users).toEqual([{ handle: 'topper' }]);
    expect(dropModel.parts[0].content).toContain('Profile: @[topper]');
  });

  it('swallows wave posting errors', async () => {
    process.env.SUBSCRIPTIONS_WAVE_ID = 'wave-1';
    process.env.SUBSCRIPTIONS_BOT_PROFILE_ID = 'profile-1';
    (identitiesDb.getIdentityByProfileId as jest.Mock).mockResolvedValue({
      handle: 'subbot',
      primary_address: '0xbot'
    });
    (createOrUpdateDrop.execute as jest.Mock).mockRejectedValue(
      new Error('wave failed')
    );

    await expect(
      sendDailySubscriptionsWaveUpdate({
        memeId: 312,
        seizeDomain: '6529',
        uploadLink: 'https://arweave.net/subscriptions'
      })
    ).resolves.toBeUndefined();
    expect(sendIdentityPushNotifications).not.toHaveBeenCalled();
  });
});

function restoreEnv(
  key: keyof typeof process.env,
  originalEnv: Record<string, string | undefined>
) {
  const originalValue = originalEnv[key];
  if (originalValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = originalValue;
  }
}
