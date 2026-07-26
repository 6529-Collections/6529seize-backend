import { SqlExecutor } from '@/sql-executor';
import { SubscriptionCoverageRepository } from './subscription-coverage.repository';

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
});
