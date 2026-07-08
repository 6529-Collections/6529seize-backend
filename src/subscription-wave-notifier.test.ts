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
  getSubscriptionAdminHandles
} from './subscription-wave-notifier';

describe('subscription wave notifier message formatting', () => {
  const originalAdminHandles = process.env.SUBSCRIPTIONS_ADMIN_HANDLES;

  afterEach(() => {
    if (originalAdminHandles === undefined) {
      delete process.env.SUBSCRIPTIONS_ADMIN_HANDLES;
    } else {
      process.env.SUBSCRIPTIONS_ADMIN_HANDLES = originalAdminHandles;
    }
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
      ' @[admin1] ; @admin2, admin3 ,, ';

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
});
