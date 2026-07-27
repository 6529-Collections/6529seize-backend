import { SqlExecutor } from '@/sql-executor';
import {
  SubscriptionCoverageNotificationSnapshot,
  SubscriptionCoverageRepository
} from './subscription-coverage.repository';

function createExecutor() {
  const execute = jest.fn(async (sql: string) => {
    if (sql.includes('CAST(balance AS CHAR)')) {
      return [
        {
          consolidation_key: 'profile-key',
          balance_eth: '0.13058'
        }
      ];
    }
    if (
      sql.includes('FROM subscriptions_mode') &&
      !sql.includes('SELECT DISTINCT evidence')
    ) {
      return [
        {
          consolidation_key: 'profile-key',
          automatic: 1,
          subscribe_all_editions: 1
        }
      ];
    }
    if (sql.includes('SELECT DISTINCT evidence')) {
      return [{ consolidation_key: 'profile-key' }];
    }
    if (
      sql.includes('FROM subscriptions_nfts') &&
      sql.includes('automatic_subscription')
    ) {
      return [
        {
          consolidation_key: 'profile-key',
          token_id: 528,
          subscribed: 1,
          subscribed_count: 3,
          automatic_subscription: 0
        }
      ];
    }
    if (sql.includes('FROM owners_balances_memes_consolidation')) {
      return [];
    }
    return [];
  });
  const executor = {
    execute,
    oneOrNull: jest.fn(async (sql: string) =>
      sql.includes('MAX(id)') ? { max_id: 16 } : null
    ),
    executeNativeQueriesInTransaction: jest.fn(),
    getAffectedRows: jest.fn(() => 0)
  } as unknown as SqlExecutor;
  return { executor, execute };
}

describe('SubscriptionCoverageRepository source loading', () => {
  it('uses exact balance text, normalized intent evidence, and zero eligibility', async () => {
    const { executor, execute } = createExecutor();
    const repository = new SubscriptionCoverageRepository(() => executor);

    const result = await repository.loadSourceData(['PROFILE-KEY'], [528], {});

    expect(result.get('profile-key')).toEqual({
      consolidationKey: 'profile-key',
      hasDemonstratedIntent: true,
      balanceEth: '0.13058',
      mode: {
        automatic: true,
        subscribeAllEditions: true
      },
      eligibilityCount: 0,
      selections: [
        {
          tokenId: 528,
          subscribed: true,
          subscribedCount: 3,
          automaticSubscription: false
        }
      ]
    });
    const sql = execute.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('CAST(balance AS CHAR)');
    expect(sql).toContain('subscriptions_top_up');
    expect(sql).toContain('subscriptions_nfts_final');
    expect(sql).toContain('subscriptions_redeemed');
    expect(sql).toContain('token_id >= :firstFutureTokenId');
    expect(sql).not.toContain('token_id IN (:tokenIds)');
    expect(sql).not.toContain('subscriptions_logs');
  });

  it('routes only a single canonical profile row', async () => {
    const { executor } = createExecutor();
    jest.mocked(executor.execute).mockResolvedValueOnce([
      {
        consolidation_key: 'one',
        profile_id: 'profile-one',
        handle: 'One'
      },
      {
        consolidation_key: 'one',
        profile_id: 'profile-one',
        handle: 'One'
      },
      {
        consolidation_key: 'ambiguous',
        profile_id: 'profile-a',
        handle: 'A'
      },
      {
        consolidation_key: 'ambiguous',
        profile_id: 'profile-b',
        handle: 'B'
      }
    ]);
    const repository = new SubscriptionCoverageRepository(() => executor);

    const profiles = await repository.resolveCanonicalProfiles(
      ['one', 'ambiguous'],
      {}
    );

    expect(profiles.get('one')).toEqual({
      profileId: 'profile-one',
      handle: 'One'
    });
    expect(profiles.has('ambiguous')).toBe(false);
  });

  it('orders fresh dirty keys ahead of repeatedly failing keys', async () => {
    const { executor, execute } = createExecutor();
    const repository = new SubscriptionCoverageRepository(() => executor);

    await repository.listDirty(100);

    expect(execute.mock.calls[0][0]).toContain(
      'ORDER BY attempts ASC, dirty_at ASC, consolidation_key ASC'
    );
  });
});

describe('SubscriptionCoverageRepository alert writes', () => {
  const existingCoveredState = {
    consolidation_key: 'profile-key',
    current_status: 'COVERED',
    current_fingerprint: 'covered-fingerprint',
    current_at_risk_token_id: null,
    current_fully_funded_drops: 7,
    current_requested_mints: null,
    current_missing_mints: null,
    recipient_profile_id: null,
    last_notified_status: null,
    last_notified_fingerprint: null,
    last_notified_at: null,
    created_at: 1,
    updated_at: 1
  };
  const unroutableSnapshot: SubscriptionCoverageNotificationSnapshot = {
    consolidationKey: 'profile-key',
    status: 'ACTION_REQUIRED',
    fingerprint: 'risk-fingerprint',
    atRiskTokenId: 528,
    fullyFundedDrops: 0,
    requestedMints: 1,
    missingMints: 1,
    recipientProfileId: null,
    notificationData: null
  };
  const policy = {
    notificationsEnabled: true,
    baselineOnly: false,
    notifyInitialCritical: false
  };

  function createAlertRepository() {
    const connection = { connection: {} };
    const executor = {
      execute: jest.fn(async () => []),
      oneOrNull: jest.fn(async () => existingCoveredState),
      executeNativeQueriesInTransaction: jest.fn(
        async (executable: (value: typeof connection) => Promise<unknown>) =>
          executable(connection)
      ),
      getAffectedRows: jest.fn(() => 0)
    } as unknown as SqlExecutor;
    const notificationsDb = {
      insertManyNotifications: jest.fn(async () => [42])
    };
    return {
      executor,
      notificationsDb,
      repository: new SubscriptionCoverageRepository(
        () => executor,
        notificationsDb
      )
    };
  }

  it('does not consume an unroutable deterioration before delivery is possible', async () => {
    const { executor, notificationsDb, repository } = createAlertRepository();

    const pending = await repository.applyAlertSnapshot(
      unroutableSnapshot,
      policy
    );

    expect(pending).toMatchObject({
      notificationIds: [],
      notificationStatus: null,
      decisionReason: 'DETERIORATED',
      createdBaseline: false
    });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(notificationsDb.insertManyNotifications).not.toHaveBeenCalled();

    const delivered = await repository.applyAlertSnapshot(
      {
        ...unroutableSnapshot,
        recipientProfileId: 'profile-id',
        notificationData: {
          recipient_profile_id: 'profile-id',
          profile_handle: 'alice',
          status: 'ACTION_REQUIRED',
          consolidation_key: 'profile-key',
          mint_capacity: 0,
          allocated_mints: 0,
          fully_funded_drops: 0,
          funded_through: null,
          next_unfunded: {
            token_id: 528,
            mint_at: '2026-07-27T14:40:00.000Z',
            requested_mints: 1,
            funded_mints: 0,
            missing_mints: 1
          },
          minimum_top_up_eth: '0.06529',
          top_up_deadline: null,
          calculation_version: 1,
          forecast_fingerprint: 'risk-fingerprint'
        }
      },
      policy
    );

    expect(delivered.notificationIds).toEqual([42]);
    expect(notificationsDb.insertManyNotifications).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
